import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('session role switching changes actual permissions, stays local and cannot persist demo elevation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autobot-roles-'));
  process.env.DATA_DIR = directory;
  delete process.env.ADMIN_USERNAME;
  process.env.DEMO_ROLE_SWITCH = 'false';
  let server, db;
  try {
    ({ db } = await import('../server/db.js'));
    const { app } = await import('../server/app.js');
    await new Promise((resolve, reject) => { server = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()); server.on('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (method, path, body, token) => {
      const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, data: response.status === 204 ? null : await response.json() };
    };
    const credentials = { username: 'role_user', password: 'valid-password-123' };
    const registered = (await request('POST', '/api/auth/register', credentials)).data;
    const token = registered.accessToken;
    const secondToken = (await request('POST', '/api/auth/login', credentials)).data.accessToken;
    const other = (await request('POST', '/api/auth/register', { ...credentials, username: 'other_user' })).data;
    db.prepare('INSERT INTO bots(id, user_id, name, prompt) VALUES (?, ?, ?, ?)').run('own', registered.id, 'Own', 'Test prompt');
    db.prepare('INSERT INTO bots(id, user_id, name, prompt) VALUES (?, ?, ?, ?)').run('other', other.id, 'Other', 'Test prompt');
    const settings = { name: 'Changed', description: '', short_description: '' };
    assert.deepEqual((await request('GET', '/api/auth/me', undefined, token)).data.availableRoles, ['viewer', 'user']);
    assert.equal((await request('PUT', '/api/auth/role', { role: 'admin' }, token)).status, 403);
    assert.equal((await request('PUT', '/api/auth/role', { role: 'viewer' }, token)).status, 200);
    assert.equal((await request('GET', '/api/auth/me', undefined, token)).data.assignedRole, 'user');
    assert.equal((await request('GET', '/api/auth/me', undefined, secondToken)).data.role, 'user');
    assert.equal((await request('GET', '/api/bots/own', undefined, token)).status, 200);
    assert.equal((await request('PUT', '/api/bots/own', settings, token)).status, 403);
    assert.equal((await request('POST', '/api/auth/check-permission', { action: 'manageBots' }, token)).status, 403);
    await request('PUT', '/api/auth/role', { role: 'user' }, token);
    assert.equal((await request('PUT', '/api/bots/own', settings, token)).status, 200);
    assert.equal((await request('GET', '/api/bots/other', undefined, token)).status, 404);
    process.env.DEMO_ROLE_SWITCH = 'true';
    assert.deepEqual((await request('GET', '/api/auth/me', undefined, token)).data.availableRoles, ['viewer', 'user', 'admin']);
    assert.equal((await request('PUT', '/api/auth/role', { role: 'admin' }, token)).status, 200);
    assert.equal((await request('GET', '/api/users', undefined, token)).status, 200);
    assert.equal((await request('GET', '/api/bots', undefined, token)).data.length, 2);
    assert.equal((await request('PUT', '/api/bots/other', settings, token)).status, 200);
    assert.equal((await request('POST', '/api/auth/check-permission', { action: 'manageUsers' }, token)).status, 200);
    assert.equal((await request('PUT', `/api/users/${registered.id}/role`, { role: 'admin' }, token)).status, 403);
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(registered.id).role, 'user');
    process.env.DEMO_ROLE_SWITCH = 'false';
    assert.equal((await request('GET', '/api/auth/me', undefined, token)).data.role, 'user');
    assert.equal((await request('GET', '/api/users', undefined, token)).status, 403);
    assert.equal((await request('PUT', '/api/auth/role', { role: 'invalid' }, token)).status, 422);
    assert.equal((await request('PUT', '/api/auth/role', { role: 'viewer' })).status, 401);
    await request('POST', '/api/auth/logout', undefined, token);
    assert.equal((await request('PUT', '/api/auth/role', { role: 'user' }, token)).status, 401);
  } finally {
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    db?.close(); await rm(directory, { recursive: true, force: true });
  }
});
