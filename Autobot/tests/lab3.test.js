import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

test('lab 3: migration, roles, HTTP semantics, sessions and one-use email recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autobot-lab3-'));
  process.env.DATA_DIR = directory;
  delete process.env.ADMIN_USERNAME;
  delete process.env.DEEPSEEK_API_KEY;
  const old = new DatabaseSync(join(directory, 'app.sqlite'));
  old.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL); CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, expires INTEGER NOT NULL);');
  old.prepare('INSERT INTO users VALUES (?, ?, ?)').run('legacy', 'legacy', 'unused-hash');
  const legacyToken = 'legacy-session';
  old.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(createHash('sha256').update(legacyToken).digest('hex'), 'legacy', Date.now() + 60000);
  old.close();
  let server, db, mailer, originalSend, originalConfigured;
  try {
    ({ db } = await import('../server/db.js'));
    ({ mailer } = await import('../server/mail.js'));
    originalSend = mailer.sendReset; originalConfigured = mailer.configured;
    const { app } = await import('../server/app.js');
    await new Promise((resolve, reject) => { server = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()); server.on('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (method, path, body, token, extraHeaders = {}) => {
      const response = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = response.status === 204 ? null : await response.json();
      return { status: response.status, headers: response.headers, data };
    };
    const password = 'test-password-123';
    const register = username => request('POST', '/api/auth/register', { username, password });
    const login = username => request('POST', '/api/auth/login', { username, password });
    assert.equal((await request('GET', '/api/auth/me', undefined, legacyToken)).data.role, 'user');
    assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').get('legacy').email, null);
    const unauthenticated = await request('GET', '/api/bots');
    assert.equal(unauthenticated.status, 401); assert.match(unauthenticated.headers.get('www-authenticate'), /Bearer/);
    const method = await request('GET', '/api/auth/login');
    assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'POST');
    assert.equal((await request('POST', '/api/auth/register', { username: 'bad_role', password, role: 'admin' })).status, 422);
    const malformed = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400); await malformed.body.cancel();
    assert.equal((await request('POST', '/api/auth/login', { huge: 'a'.repeat(140000) })).status, 413);
    assert.equal((await request('POST', '/api/auth/login', {}, undefined, { Origin: 'invalid' })).status, 400);

    const admin = (await register('lab_admin')).data;
    const user = (await register('lab_user')).data;
    let adminToken = admin.accessToken, userToken = user.accessToken;
    assert.equal((await request('GET', '/api/users', undefined, userToken)).status, 403);
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
    assert.equal((await request('GET', '/api/users', undefined, adminToken)).status, 200);
    assert.equal((await request('PUT', `/api/users/${admin.id}/role`, { role: 'user' }, adminToken)).status, 409);
    db.prepare('INSERT INTO bots(id, user_id, name, prompt) VALUES (?, ?, ?, ?)').run('own-bot', user.id, 'Test', 'Test prompt');
    db.prepare('INSERT INTO bots(id, user_id, name, prompt) VALUES (?, ?, ?, ?)').run('other-bot', 'legacy', 'Other', 'Test prompt');
    assert.equal((await request('GET', '/api/bots/other-bot', undefined, userToken)).status, 404);
    assert.equal((await request('GET', '/api/bots/other-bot', undefined, adminToken)).status, 200);
    assert.equal((await request('PUT', `/api/users/${user.id}/role`, { role: 'viewer' }, adminToken)).status, 200);
    assert.equal((await request('GET', '/api/auth/me', undefined, userToken)).status, 401);
    userToken = (await login('lab_user')).data.accessToken;
    assert.equal((await request('GET', '/api/bots/own-bot', undefined, userToken)).status, 200);
    assert.equal((await request('POST', '/api/bots', { prompt: 'Test bot description' }, userToken)).status, 403);
    assert.equal((await request('DELETE', '/api/bots/own-bot', undefined, userToken)).status, 403);
    await request('PUT', `/api/users/${user.id}/role`, { role: 'user' }, adminToken);
    userToken = (await login('lab_user')).data.accessToken;
    const wrongMethod = await request('PATCH', '/api/bots/own-bot', {}, userToken);
    assert.equal(wrongMethod.status, 405); assert.match(wrongMethod.headers.get('allow'), /PUT/);
    assert.equal((await request('GET', '/api/missing', undefined, userToken)).status, 404);
    assert.equal((await request('POST', '/api/bots', { prompt: 'Test bot description' }, userToken)).status, 503);

    const tokens = [];
    for (let i = 0; i < 6; i++) tokens.push((await login('lab_user')).data.accessToken);
    userToken = tokens.at(-1);
    assert.equal((await request('GET', '/api/auth/me', undefined, tokens[0])).status, 401);
    const sessions = (await request('GET', '/api/auth/sessions', undefined, userToken)).data;
    assert.equal(sessions.length, 5); assert.equal(sessions.filter(session => session.current).length, 1);
    const otherSession = sessions.find(session => !session.current);
    assert.equal((await request('DELETE', `/api/auth/sessions/${otherSession.id}`, undefined, adminToken)).status, 404);
    assert.equal((await request('DELETE', `/api/auth/sessions/${otherSession.id}`, undefined, userToken)).status, 204);
    assert.equal((await request('PUT', '/api/auth/email', { email: 'user@example.test', password: 'wrong-password' }, userToken)).status, 401);
    assert.equal((await request('PUT', '/api/auth/email', { email: 'User@example.test', password }, userToken)).data.email, 'user@example.test');

    mailer.configured = () => false;
    assert.equal((await request('POST', '/api/auth/forgot-password', { email: 'user@example.test' })).status, 503);
    let sentToken;
    mailer.configured = () => true;
    mailer.sendReset = async (email, token) => { assert.equal(email, 'user@example.test'); sentToken = token; };
    const known = await request('POST', '/api/auth/forgot-password', { email: 'user@example.test' });
    const unknown = await request('POST', '/api/auth/forgot-password', { email: 'missing@example.test' });
    assert.equal(known.status, 202); assert.deepEqual(known.data, unknown.data);
    assert.notEqual(db.prepare('SELECT id FROM password_resets').get().id, sentToken);
    db.prepare('UPDATE password_resets SET expires = ?').run(Date.now() - 1);
    assert.equal((await request('POST', '/api/auth/reset-password', { token: sentToken, password: 'new-password-123' })).status, 400);
    await request('POST', '/api/auth/forgot-password', { email: 'user@example.test' });
    const resetBody = { token: sentToken, password: 'new-password-123' };
    const resets = await Promise.all([request('POST', '/api/auth/reset-password', resetBody), request('POST', '/api/auth/reset-password', resetBody)]);
    assert.deepEqual(resets.map(result => result.status).sort(), [204, 400]);
    assert.equal((await request('GET', '/api/auth/me', undefined, userToken)).status, 401);
    assert.equal((await login('lab_user')).status, 401);
    assert.equal((await request('POST', '/api/auth/login', { username: 'lab_user', password: 'new-password-123' })).status, 200);
  } finally {
    if (mailer) { mailer.sendReset = originalSend; mailer.configured = originalConfigured; }
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    db?.close(); await rm(directory, { recursive: true, force: true });
  }
});
