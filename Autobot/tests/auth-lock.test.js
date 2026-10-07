import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('failed logins lock the account, expire cleanly, and IP rate limit returns 429', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autobot-lock-'));
  process.env.DATA_DIR = directory;
  delete process.env.ADMIN_USERNAME;
  let server, db;
  try {
    ({ db } = await import('../server/db.js'));
    const { app } = await import('../server/app.js');
    await new Promise((resolve, reject) => { server = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()); server.on('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}/api/auth`;
    const post = async (path, body) => {
      const result = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await result.body.cancel(); return result;
    };
    const correct = { username: 'locked_user', password: 'valid-password-123' };
    assert.equal((await post('/register', correct)).status, 201);
    for (let i = 0; i < 5; i++) assert.equal((await post('/login', { ...correct, password: 'wrong-password' })).status, 401);
    const locked = await post('/login', correct);
    assert.equal(locked.status, 429); assert.ok(Number(locked.headers.get('retry-after')) > 0);
    db.prepare('UPDATE login_attempts SET locked_until = 0, updated_at = ?').run(Date.now() - 16 * 60000);
    assert.equal((await post('/login', { ...correct, password: 'wrong-password' })).status, 401);
    assert.equal(db.prepare('SELECT failures FROM login_attempts').get().failures, 1);
    assert.equal((await post('/login', correct)).status, 200);
    assert.equal(db.prepare('SELECT count(*) AS n FROM login_attempts').get().n, 0);
    for (let i = 0; i < 22; i++) await post('/register', {});
    const limited = await post('/login', correct);
    assert.equal(limited.status, 429); assert.ok(limited.headers.get('retry-after'));
  } finally {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    db?.close(); await rm(directory, { recursive: true, force: true });
  }
});
