import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.js';

function client(url, token) {
  const ws = new WebSocket(url);
  const messages = [], waiters = [];
  let latest;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
  ws.on('message', data => {
    const message = JSON.parse(data);
    if (message.type === 'state') latest = message;
    const index = waiters.findIndex(waiter => waiter.predicate(message));
    if (index >= 0) { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
    else messages.push(message);
  });
  return { ws, get state() { return latest; }, send: action => ws.send(JSON.stringify(action)), next: predicate => {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => { const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('WebSocket message timed out')), 5000) }; waiters.push(waiter); });
  } };
}

test('HTTP + two real WebSockets: auth, conflict, broadcast, reconnect, full flight, restart', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-network-'));
  let time = Date.now();
  let app;
  const clients = [];
  async function start() {
    app = createGameServer({ dataDir: dir, now: () => time, allowedOrigins: ['https://captain.github.io'] });
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const port = app.server.address().port;
    return { http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws` };
  }
  try {
    let address = await start();
    const post = (path, body) => fetch(`${address.http}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const register = async username => {
      const response = await post('/api/register', { username, password: 'TestPassword123!', race: 'human' });
      assert.equal(response.status, 201);
      return (await response.json()).token;
    };
    const aToken = await register('КапитанА');
    const bToken = await register('КапитанБ');
    assert.equal((await post('/api/login', { username: 'КапитанА', password: 'wrong-password' })).status, 400);
    assert.equal((await post('/api/login', { username: 'капитана', password: 'TestPassword123!' })).status, 200);
    assert.equal((await post('/api/register', { username: 'капитана', password: 'TestPassword123!', race: 'human' })).status, 400);
    assert.equal((await fetch(`${address.http}/api/health`, { headers: { Origin: 'https://bad.example' } })).status, 403);
    assert.equal((await fetch(`${address.http}/api/health`, { headers: { Origin: 'https://captain.github.io' } })).headers.get('access-control-allow-origin'), 'https://captain.github.io');
    assert.equal((await fetch(`${address.http}/`)).status, 200);
    assert.equal((await fetch(`${address.http}/../server/index.js`)).status, 404);
    const a = client(address.ws, aToken), b = client(address.ws, bToken); clients.push(a, b);
    await Promise.all([a.next(m => m.type === 'state'), b.next(m => m.type === 'state')]);
    const contract = a.state.contracts.find(c => c.origin === 'sol');
    const actionA = { id: randomUUID(), revision: a.state.player.revision, type: 'accept', contractId: contract.id };
    const actionB = { id: randomUUID(), revision: b.state.player.revision, type: 'accept', contractId: contract.id };
    a.send(actionA); b.send(actionB);
    const outcomes = await Promise.all([a.next(m => m.id === actionA.id), b.next(m => m.id === actionB.id)]);
    assert.deepEqual(outcomes.map(m => m.type).sort(), ['ack', 'error']);
    const winner = outcomes[0].type === 'ack' ? a : b;
    const winnerToken = winner === a ? aToken : bToken;
    const claim = winner === a ? actionA : actionB;
    const loser = winner === a ? b : a;
    assert.equal(winner.state.player.contracts.length, 1);
    await loser.next(m => m.type === 'state' && !m.contracts.some(c => c.id === contract.id));
    winner.ws.terminate();
    const reconnected = client(address.ws, winnerToken); clients.push(reconnected);
    await reconnected.next(m => m.type === 'state');
    reconnected.send(claim);
    assert.equal((await reconnected.next(m => m.id === claim.id)).duplicate, true);
    assert.equal(reconnected.state.player.contracts.length, 1);
    const jump = { id: randomUUID(), revision: reconnected.state.player.revision, type: 'jump', target: contract.target };
    reconnected.send(jump);
    await reconnected.next(m => m.id === jump.id && m.type === 'ack');
    await loser.next(m => m.type === 'state' && m.pilots.some(p => p.id === reconnected.state.player.id && p.journey));
    time += 60_000;
    await reconnected.next(m => m.type === 'state' && !m.player.journey && m.player.location === contract.target);
    const before = reconnected.state.player.credits;
    const delivery = { id: randomUUID(), revision: reconnected.state.player.revision, type: 'deliver', contractId: contract.id };
    reconnected.send(delivery);
    await reconnected.next(m => m.id === delivery.id && m.type === 'ack');
    assert.equal(reconnected.state.player.credits, before + contract.reward);
    await app.close(); app = null;
    address = await start();
    const restarted = client(address.ws, winnerToken); clients.push(restarted);
    await restarted.next(m => m.type === 'state');
    assert.equal(restarted.state.player.credits, before + contract.reward);
    assert.equal(restarted.state.player.location, contract.target);
    restarted.send(delivery);
    assert.equal((await restarted.next(m => m.id === delivery.id)).duplicate, true);
    assert.equal(restarted.state.player.credits, before + contract.reward);
    const response = await fetch(`${address.http}/api/logout`, { method: 'POST', headers: { Authorization: `Bearer ${winnerToken}` } });
    assert.equal(response.status, 200);
    const invalid = new WebSocket(address.ws);
    invalid.on('open', () => invalid.send(JSON.stringify({ type: 'auth', token: winnerToken })));
    const code = await new Promise(resolve => invalid.on('close', resolve));
    assert.equal(code, 4001);
  } finally {
    clients.forEach(c => c.ws.terminate());
    if (app) await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
