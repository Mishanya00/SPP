import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, sep } from 'node:path';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket } from 'ws';
import { Store } from './store.js';
import { GameError, newPlayer, applyAction, finishFlights, snapshot, advanceCombat, migrateWorld } from './game.js';
import { RACES } from '../public/shared.js';

const deriveKey = promisify(scrypt);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = token => createHash('sha256').update(token).digest('hex');
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export function createGameServer({ dataDir = process.env.DATA_DIR || resolve(root, 'data'), allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean), now = Date.now } = {}) {
  const store = new Store(dataDir);
  migrateWorld(store.state, now());
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const limits = new Map();
  let activeHashes = 0;
  const online = () => new Set([...wss.clients].filter(ws => ws.playerId && ws.readyState === WebSocket.OPEN).map(ws => ws.playerId));
  const send = (ws, value) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) { ws.terminate(); return; }
    ws.send(JSON.stringify(value));
  };
  const publish = () => {
    const players = online();
    for (const ws of wss.clients) if (ws.playerId) send(ws, snapshot(store.state, ws.playerId, players, now()));
  };
  const sessionFor = token => {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const session = store.state.sessions[digest(token)];
    return session && session.expiresAt > now() ? session : null;
  };
  const originAllowed = request => {
    const origin = request.headers.origin;
    if (!origin) return true; // Native clients and same-origin GET requests.
    return origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}` || allowedOrigins.includes(origin);
  };
  function reply(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(payload));
  }
  async function body(request) {
    let text = '';
    for await (const chunk of request) {
      text += chunk;
      if (Buffer.byteLength(text) > 4096) throw new GameError('Запрос слишком большой.');
    }
    try { return JSON.parse(text); } catch { throw new GameError('Некорректный JSON.'); }
  }
  function rateLimit(request) {
    const key = request.socket.remoteAddress;
    const window = limits.get(key) || { count: 0, until: now() + 60_000 };
    if (window.until <= now()) { window.count = 0; window.until = now() + 60_000; }
    window.count++;
    limits.set(key, window);
    if (window.count > 30) throw new GameError('Слишком много попыток. Подождите минуту.');
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (!originAllowed(request)) return reply(response, 403, { error: 'Этот адрес клиента не разрешён на сервере.' });
    if (request.headers.origin) {
      response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/api/health') return reply(response, 200, { status: 'ok', online: online().size });
      if (path === '/api/logout' && request.method === 'POST') {
        const token = request.headers.authorization?.replace(/^Bearer /, '');
        if (sessionFor(token)) {
          const hash = digest(token);
          store.transact(state => { delete state.sessions[hash]; });
          for (const ws of wss.clients) if (ws.sessionHash === hash) ws.close(4001, 'Logged out');
        }
        return reply(response, 200, { ok: true });
      }
      if (['/api/register', '/api/login'].includes(path) && request.method === 'POST') {
        rateLimit(request);
        const input = await body(request);
        const username = typeof input.username === 'string' ? input.username.trim() : '';
        if (!/^[\p{L}\p{N}_-]{3,20}$/u.test(username)) throw new GameError('Имя: 3–20 букв, цифр, дефисов или подчёркиваний.');
        if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) throw new GameError('Пароль должен содержать от 8 до 128 символов.');
        const key = username.toLocaleLowerCase('ru');
        const existing = Object.values(store.state.users).find(user => user.key === key);
        const register = path === '/api/register';
        if (register && (!Object.hasOwn(RACES, input.race))) throw new GameError('Выберите расу.');
        if (register && existing) throw new GameError('Это имя капитана уже занято.');
        if (activeHashes >= 8) throw new GameError('Сервер занят. Попробуйте через несколько секунд.');
        activeHashes++;
        const salt = register ? randomBytes(16).toString('hex') : existing?.salt || '00000000000000000000000000000000';
        let hash;
        try { hash = await deriveKey(input.password, salt, 64); } finally { activeHashes--; }
        if (!register && (!existing || !timingSafeEqual(Buffer.from(existing.passwordHash, 'hex'), hash))) throw new GameError('Неверное имя или пароль.');
        const token = randomBytes(32).toString('hex');
        store.transact(state => {
          let user = existing;
          if (register) {
            if (Object.values(state.users).some(item => item.key === key)) throw new GameError('Это имя капитана уже занято.');
            const player = newPlayer(username, input.race, now());
            user = { key, salt, passwordHash: hash.toString('hex'), player };
            state.users[player.id] = user;
          }
          for (const [id, session] of Object.entries(state.sessions)) if (session.expiresAt <= now()) delete state.sessions[id];
          state.sessions[digest(token)] = { playerId: user.player.id, expiresAt: now() + SESSION_MS };
        });
        reply(response, register ? 201 : 200, { token });
        publish();
        return;
      }
      if (path.startsWith('/api/')) return reply(response, 404, { error: 'Маршрут не найден.' });
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply(response, 405, { error: 'Метод не поддерживается.' });
      const publicDir = resolve(root, 'public');
      const filename = resolve(publicDir, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
      if (!filename.startsWith(publicDir + sep)) return reply(response, 403, { error: 'Доступ запрещён.' });
      let file;
      try { file = await readFile(filename); } catch { return reply(response, 404, { error: 'Файл не найден.' }); }
      const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
      response.writeHead(200, { 'Content-Type': `${types[extname(filename)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : file);
    } catch (error) {
      if (!(error instanceof GameError)) console.error(error);
      if (!response.headersSent) reply(response, error instanceof GameError ? 400 : 500, { error: error instanceof GameError ? error.message : 'Сервер не смог сохранить действие. Повторите позже.' });
    }
  });
  server.requestTimeout = 15_000;
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (request.url !== '/ws' || !originAllowed(request)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.alive = true;
    ws.window = { count: 0, until: now() + 1000 };
    const authTimeout = setTimeout(() => { if (!ws.playerId) ws.close(4001, 'Authentication required'); }, 5000);
    ws.on('error', () => ws.terminate());
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', raw => {
      let message;
      try {
        if (ws.window.until < now()) ws.window = { count: 0, until: now() + 1000 };
        if (++ws.window.count > 20) { ws.close(4008, 'Too many requests'); return; }
        message = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object') throw new GameError('Некорректное сообщение.');
        if (!ws.playerId) {
          const session = message.type === 'auth' && sessionFor(message.token);
          if (!session) { ws.close(4001, 'Session expired'); return; }
          ws.playerId = session.playerId;
          ws.sessionHash = digest(message.token);
          clearTimeout(authTimeout);
          publish();
          return;
        }
        if (!store.state.sessions[ws.sessionHash] || store.state.sessions[ws.sessionHash].expiresAt <= now()) { ws.close(4001, 'Session expired'); return; }
        const result = store.transact(state => applyAction(state, ws.playerId, message, now()));
        // Snapshot goes first: the client never enables another action against an old revision.
        publish();
        send(ws, { type: 'ack', ...result });
      } catch (error) {
        if (!(error instanceof GameError) && !(error instanceof SyntaxError)) console.error(error);
        if (ws.playerId) send(ws, snapshot(store.state, ws.playerId, online(), now()));
        send(ws, { type: 'error', id: message?.id, message: error instanceof GameError ? error.message : 'Действие не выполнено. Повторите позже.' });
      }
    });
    ws.on('close', () => { clearTimeout(authTimeout); publish(); });
  });
  const arrivals = setInterval(() => {
    if (!store.state.engagements.length && !Object.values(store.state.users).some(({ player }) => player.journey?.arrivesAt <= now())) return;
    try { store.transact(state => { advanceCombat(state, now()); finishFlights(state, now()); }); publish(); } catch (error) { console.error('Could not save arrivals', error); }
  }, 100);
  const heartbeat = setInterval(() => {
    for (const [key, limit] of limits) if (limit.until <= now()) limits.delete(key);
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
      if (ws.playerId) send(ws, { type: 'heartbeat' });
      if (ws.playerId && (!store.state.sessions[ws.sessionHash] || store.state.sessions[ws.sessionHash].expiresAt <= now())) ws.close(4001, 'Session expired');
    }
  }, 15_000);
  return { server, store, wss, close: async () => {
    clearInterval(arrivals); clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createGameServer();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '0.0.0.0', () => console.log(`Star Atlas → http://localhost:${port}`));
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
