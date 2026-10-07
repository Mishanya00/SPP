import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('generation persists network causes and distinguishes HTTP errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autobot-errors-'));
  const previousDir = process.env.DATA_DIR;
  const originalFetch = globalThis.fetch;
  process.env.DATA_DIR = directory;
  let db;
  try {
    ({ db } = await import('../server/db.js'));
    const { generate, busy } = await import('../server/runtime.js');
    db.prepare('INSERT INTO bots(id, name, prompt) VALUES (?, ?, ?)').run('network-test', 'Test', 'Test prompt');
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connection timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
      });
    };
    await generate('network-test');
    const bot = db.prepare('SELECT status, error FROM bots WHERE id = ?').get('network-test');
    assert.equal(bot.status, 'error');
    assert.match(bot.error, /UND_ERR_CONNECT_TIMEOUT/);
    assert.equal(busy.has('network-test'), false);
    assert.match(db.prepare("SELECT message FROM bot_logs WHERE level = 'error'").get().message, /UND_ERR_CONNECT_TIMEOUT/);

    globalThis.fetch = async () => new Response('', { status: 402 });
    await generate('network-test');
    const httpError = db.prepare('SELECT error FROM bots WHERE id = ?').get('network-test').error;
    assert.match(httpError, /HTTP 402/);
    assert.match(httpError, /Пополните баланс/);
    assert.doesNotMatch(httpError, /Нет соединения/);
    assert.equal(busy.has('network-test'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDir;
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
