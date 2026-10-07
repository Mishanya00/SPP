import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, getBot, publicBot, event, dataDir } from './db.js';
import { encrypt } from './security.js';
import { authRouter, authenticate, requireAdmin, requireAssignedAdmin } from './auth.js';
import { can } from './roles.js';
import { telegram } from './telegram.js';
import { generate, startBot, stopBot, removeRuntime, locked, busy, getLogs } from './runtime.js';
import { log, redact } from './logger.js';
export const app = express();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
app.disable('x-powered-by');
app.use((req, res, next) => {
  const started = Date.now();
  req.requestId = randomUUID();
  res.set('X-Request-Id', req.requestId);
  res.on('finish', () => {
    if (req.path.startsWith('/api') || res.statusCode >= 400) log(res.statusCode >= 500 ? 'error' : 'info', 'HTTP request', {
      requestId: req.requestId, method: req.method, route: req.route?.path || 'unmatched',
      status: res.statusCode, durationMs: Date.now() - started, botId: req.bot?.id, userId: req.user?.id, role: req.user?.role
    });
  });
  next();
});
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { fail(400, 'Некорректный Origin.'); }
    if (origin.host !== req.headers.host) return res.status(403).json({ error: 'Недопустимый источник запроса.' });
  }
  next();
});
app.use(express.json({ limit: '128kb' }));
app.use('/api/auth', authRouter);
app.use('/api', authenticate);
app.use('/api/bots', (req, res, next) => {
  if (!can(req.user.role, 'manageBots') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return res.status(403).json({ error: 'Роль viewer разрешает только просмотр.' });
  next();
});
app.get('/api/bots', (req, res) => res.json((req.user.role === 'admin' ? db.prepare('SELECT * FROM bots ORDER BY created_at DESC, rowid DESC').all() : db.prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY created_at DESC, rowid DESC').all(req.user.id)).map(publicBot)));
app.post('/api/bots', (req, res) => {
  const { prompt } = z.object({ prompt: z.string().trim().min(10, 'Опишите бота подробнее: минимум 10 символов.').max(4000) }).strict().parse(req.body);
  if (!process.env.DEEPSEEK_API_KEY) fail(503, 'На сервере не настроен DEEPSEEK_API_KEY. Добавьте ключ в .env.');
  if (db.prepare("SELECT count(*) AS n FROM bots WHERE user_id = ? AND status = 'generating'").get(req.user.id).n >= 2) fail(429, 'Можно создавать не более двух ботов одновременно.');
  if (db.prepare('SELECT count(*) AS n FROM bots WHERE user_id = ?').get(req.user.id).n >= 20) fail(409, 'Лимит: 20 ботов. Удалите ненужные.');
  const id = randomUUID();
  db.prepare('INSERT INTO bots(id, user_id, name, prompt) VALUES (?, ?, ?, ?)').run(id, req.user.id, 'Новый бот', prompt);
  event(id, 'Описание принято');
  void generate(id);
  res.status(201).json(publicBot(getBot(id)));
});
app.param('id', (req, res, next, id) => {
  req.bot = getBot(id);
  if (!req.bot || (req.bot.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).json({ error: 'Бот не найден.' });
  next();
});
app.get('/api/bots/:id', (req, res) => res.json(publicBot(req.bot)));
app.get('/api/bots/:id/logs', async (req, res) => res.json(await getLogs(req.bot.id)));
app.get('/api/bots/:id/code', (req, res) => {
  if (!req.bot.code) fail(404, 'Код пока не создан.');
  res.attachment('main.py').type('text/plain').send(req.bot.code);
});
app.put('/api/bots/:id/token', async (req, res) => {
  const { token } = z.object({ token: z.string().regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, 'Некорректный Telegram API Key.') }).strict().parse(req.body);
  if (req.bot.status === 'running') fail(409, 'Остановите бота перед заменой ключа.');
  if (busy.has(req.bot.id) && req.bot.status !== 'generating') fail(409, 'Дождитесь завершения текущей операции.');
  const me = await telegram(token, 'getMe', {}, true);
  if (req.bot.telegram_id && req.bot.telegram_id !== String(me.id)) fail(409, 'Используйте ключ того же Telegram-бота. Для другого бота создайте новый проект.');
  // Generation may finish while Telegram verifies the token; serialize its eventual start.
  if (!getBot(req.bot.id)) fail(404, 'Бот удалён.');
  if (getBot(req.bot.id).status === 'running' || (busy.has(req.bot.id) && getBot(req.bot.id).status !== 'generating')) fail(409, 'Бот уже запускается. Дождитесь запуска и остановите его перед заменой ключа.');
  try { db.prepare('UPDATE bots SET token = ?, telegram_id = ?, username = ? WHERE id = ?').run(encrypt(token), String(me.id), me.username, req.bot.id); }
  catch (e) { if (String(e.message).includes('UNIQUE')) fail(409, 'Этот Telegram-бот уже подключён.'); throw e; }
  event(req.bot.id, 'Telegram API Key проверен и сохранён');
  if (!busy.has(req.bot.id) && getBot(req.bot.id).code) await locked(req.bot.id, () => startBot(req.bot.id));
  res.json(publicBot(getBot(req.bot.id)));
});
const settings = z.object({ name: z.string().trim().min(1).max(64), description: z.string().max(512), short_description: z.string().max(120) }).strict();
app.put('/api/bots/:id', async (req, res) => {
  const values = settings.parse(req.body);
  await locked(req.bot.id, async () => {
    for (const [field, method, parameter] of [['name', 'setMyName', 'name'], ['description', 'setMyDescription', 'description'], ['short_description', 'setMyShortDescription', 'short_description']]) {
      if (values[field] === req.bot[field]) continue;
      if (req.bot.token) await telegram(req.bot.token, method, { [parameter]: values[field] });
      db.prepare(`UPDATE bots SET ${field} = ? WHERE id = ?`).run(values[field], req.bot.id);
    }
  });
  res.json(publicBot(getBot(req.bot.id)));
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 } });
app.post('/api/bots/:id/avatar', upload.single('avatar'), async (req, res) => {
  const file = req.file;
  if (!file || file.mimetype !== 'image/jpeg' || file.buffer[0] !== 0xff || file.buffer[1] !== 0xd8 || file.buffer[2] !== 0xff) fail(422, 'Загрузите JPG до 5 МБ.');
  if (!req.bot.token) fail(409, 'Сначала добавьте Telegram API Key.');
  await locked(req.bot.id, async () => {
    const form = new FormData();
    form.set('photo', JSON.stringify({ type: 'static', photo: 'attach://avatar' }));
    form.set('avatar', new Blob([file.buffer], { type: 'image/jpeg' }), 'avatar.jpg');
    await telegram(req.bot.token, 'setMyProfilePhoto', form);
    db.prepare('UPDATE bots SET avatar = ? WHERE id = ?').run(file.buffer, req.bot.id);
  });
  res.json(publicBot(getBot(req.bot.id)));
});
app.get('/api/bots/:id/avatar', (req, res) => {
  if (!req.bot.avatar) fail(404, 'Аватарка не загружена.');
  res.type('image/jpeg').send(Buffer.from(req.bot.avatar));
});
app.delete('/api/bots/:id/avatar', async (req, res) => {
  await locked(req.bot.id, async () => {
    if (req.bot.token) await telegram(req.bot.token, 'removeMyProfilePhoto');
    db.prepare('UPDATE bots SET avatar = NULL WHERE id = ?').run(req.bot.id);
  });
  res.status(204).end();
});
app.post('/api/bots/:id/start', async (req, res) => { await locked(req.bot.id, () => startBot(req.bot.id)); res.json(publicBot(getBot(req.bot.id))); });
app.post('/api/bots/:id/stop', async (req, res) => { await locked(req.bot.id, () => stopBot(req.bot.id)); res.json(publicBot(getBot(req.bot.id))); });
app.post('/api/bots/:id/retry', (req, res) => {
  if (busy.has(req.bot.id) || req.bot.status === 'running') fail(409, 'Бот занят.');
  if (!process.env.DEEPSEEK_API_KEY) fail(503, 'На сервере не настроен DEEPSEEK_API_KEY.');
  db.prepare("UPDATE bots SET status = 'generating', error = NULL, code = NULL WHERE id = ?").run(req.bot.id);
  event(req.bot.id, 'Повторная генерация');
  void generate(req.bot.id);
  res.status(202).json(publicBot(getBot(req.bot.id)));
});
app.delete('/api/bots/:id', async (req, res) => {
  await locked(req.bot.id, async () => {
    // Bots that have never run have no Docker resources to remove.
    if (existsSync(`${dataDir}/${req.bot.id}/runtime`)) await removeRuntime(req.bot.id);
    await rm(`${dataDir}/${req.bot.id}`, { recursive: true, force: true });
    db.prepare('DELETE FROM bots WHERE id = ?').run(req.bot.id);
  });
  res.status(204).end();
});
app.get('/api/users', requireAdmin, (req, res) => res.json(db.prepare('SELECT id, username, role, email FROM users ORDER BY username').all()));
app.put('/api/users/:userId/role', requireAdmin, requireAssignedAdmin, (req, res) => {
  const { role } = z.object({ role: z.enum(['viewer', 'user', 'admin']) }).strict().parse(req.body);
  const user = db.prepare('SELECT id, username, role, email FROM users WHERE id = ?').get(req.params.userId);
  if (!user) fail(404, 'Пользователь не найден.');
  if (user.role === 'admin' && role !== 'admin' && db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'").get().n === 1) fail(409, 'Нельзя понизить роль последнего администратора.');
  if (user.role !== role) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    log('info', 'Роль пользователя изменена; сессии отозваны', { requestId: req.requestId, userId: req.user.id, targetUserId: user.id, role });
  }
  res.json({ ...user, role });
});
for (const [path, allow] of [
  ['/api/bots', 'GET, HEAD, POST'], ['/api/bots/:id', 'GET, HEAD, PUT, DELETE'],
  ['/api/bots/:id/logs', 'GET, HEAD'], ['/api/bots/:id/code', 'GET, HEAD'],
  ['/api/bots/:id/token', 'PUT'], ['/api/bots/:id/avatar', 'GET, HEAD, POST, DELETE'],
  ['/api/bots/:id/start', 'POST'], ['/api/bots/:id/stop', 'POST'], ['/api/bots/:id/retry', 'POST'],
  ['/api/users', 'GET, HEAD'], ['/api/users/:userId/role', 'PUT']
]) app.all(path, (req, res) => res.set('Allow', allow).status(405).json({ error: 'Метод не поддерживается.' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Маршрут не найден.' }));
app.use(express.static(resolve('public'), { setHeaders: res => res.set('Cache-Control', 'no-store') }));
app.use(express.static(resolve('dist')));
app.get('/{*path}', (req, res) => res.sendFile(resolve('dist/index.html')));
app.use((error, req, res, next) => {
  // Parse errors can include raw request bodies; log only unexpected errors in detail.
  log('error', 'Request failed', { requestId: req.requestId, botId: req.bot?.id, error: error.type || (error instanceof z.ZodError ? 'Validation error' : error) });
  if (error instanceof z.ZodError) return res.status(422).json({ error: error.issues.map(v => v.message).join(' ') });
  if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 422).json({ error: 'Нужен один JPG-файл размером до 5 МБ.' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос.' });
  if (error.status === 401) res.set('WWW-Authenticate', 'Bearer realm="autobot"');
  res.status(error.status || 500).json({ error: error.status ? redact(error.message) : 'Ошибка сервера. Проверьте логи приложения и повторите попытку.' });
});
