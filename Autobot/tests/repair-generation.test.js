import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('generation repairs rejected code, bounds retries and saves only validated results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autobot-repair-'));
  const previousDir = process.env.DATA_DIR;
  const originalFetch = globalThis.fetch;
  process.env.DATA_DIR = directory;
  let db;
  const validCode = "import asyncio\nimport os\nfrom aiogram import Bot, Dispatcher\nfrom aiogram.types import InlineKeyboardMarkup\nasync def main():\n    bot = Bot(token=os.environ['BOT_TOKEN'])\n    dp = Dispatcher()\n    await dp.start_polling(bot)\nasyncio.run(main())\n";
  const invalidCode = `def broken(:\n${validCode}`;
  const reply = content => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 });
  const result = code => JSON.stringify({ name: 'Пример', code });
  try {
    ({ db } = await import('../server/db.js'));
    const { generate, busy } = await import('../server/runtime.js');
    const insert = id => db.prepare('INSERT INTO bots(id, name, prompt) VALUES (?, ?, ?)').run(id, 'Test', 'Test bot prompt');
    const get = id => db.prepare('SELECT status, code, error FROM bots WHERE id = ?').get(id);

    insert('repair');
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push(JSON.parse(options.body));
      assert.equal(busy.has('repair'), true);
      assert.equal(get('repair').status, 'generating');
      assert.equal(get('repair').code, null);
      return reply(result(requests.length === 1 ? invalidCode : validCode));
    };
    await generate('repair');
    assert.equal(requests.length, 2);
    assert.equal(get('repair').status, 'ready');
    assert.equal(get('repair').code, validCode);
    assert.equal(busy.has('repair'), false);
    assert.equal(requests[1].messages[1].content, 'Test bot prompt');
    assert.equal(requests[1].messages[2].content, result(invalidCode));
    assert.match(requests[1].messages[3].content, /SyntaxError/);

    insert('exhausted');
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; return reply(result(invalidCode)); };
    await generate('exhausted');
    assert.equal(attempts, 4);
    assert.equal(get('exhausted').status, 'error');
    assert.equal(get('exhausted').code, null);
    assert.match(get('exhausted').error, /3 автоматических исправлений/);
    assert.equal(busy.has('exhausted'), false);

    insert('json-repair');
    attempts = 0;
    globalThis.fetch = async () => { attempts++; return reply(attempts === 1 ? '{broken json' : result(validCode)); };
    await generate('json-repair');
    assert.equal(attempts, 2);
    assert.equal(get('json-repair').status, 'ready');

    insert('http-error');
    attempts = 0;
    globalThis.fetch = async () => { attempts++; return new Response('', { status: 402 }); };
    await generate('http-error');
    assert.equal(attempts, 1);
    assert.match(get('http-error').error, /HTTP 402/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDir;
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
