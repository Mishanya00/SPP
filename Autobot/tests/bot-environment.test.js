import test from 'node:test';
import assert from 'node:assert/strict';
import { botEnvironment } from '../server/bot-environment.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);

test('AI bots receive required settings and ordinary bots receive only Telegram token', () => {
  const settings = { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/', DEEPSEEK_MODEL: 'deepseek-flash' };
  assert.deepEqual(botEnvironment('os.environ["DEEPSEEK_API_KEY"]', 'telegram-test', settings), {
    BOT_TOKEN: 'telegram-test', DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://api.deepseek.com', DEEPSEEK_MODEL: 'deepseek-flash'
  });
  assert.deepEqual(botEnvironment('print("hello")', 'telegram-test', settings), { BOT_TOKEN: 'telegram-test' });
  assert.throws(() => botEnvironment('DEEPSEEK_API_KEY', 'telegram-test', {}), /нужен DEEPSEEK_API_KEY/);
});

test('validator accepts standard library, comments, any quote style and no inline keyboard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autobot-validator-'));
  try {
    const path = join(directory, 'main.py');
    await writeFile(path, 'import urllib.request\nimport pathlib\n# Normal Python code\nprint("Hello")\n');
    assert.match((await exec('python3', ['runner/validate.py', path])).stdout, /ok/);
    await writeFile(path, 'def broken(:\n');
    await assert.rejects(exec('python3', ['runner/validate.py', path]));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
