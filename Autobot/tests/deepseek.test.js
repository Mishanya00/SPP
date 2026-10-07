import test from 'node:test';
import assert from 'node:assert/strict';
import { completionRequest, completionMetadata, parseCompletion } from '../server/deepseek.js';

const answer = (content, finish_reason = 'stop') => ({ choices: [{ message: { content }, finish_reason }] });
const bot = { name: 'Пример', code: "print('Привет')\n" };

test('parse complete JSON and fenced JSON without altering Python strings', () => {
  const content = JSON.stringify(bot);
  assert.deepEqual(parseCompletion(answer(content)), bot);
  assert.deepEqual(parseCompletion(answer(`\n\`\`\`json\n${content}\n\`\`\`\n`)), bot);
});

test('distinguish truncated, empty, missing and malformed responses', () => {
  assert.throws(() => parseCompletion(answer('{"code":', 'length')), /обрезан/);
  assert.throws(() => parseCompletion(answer('', 'length')), /обрезан/);
  assert.throws(() => parseCompletion(answer('  ')), /пустой ответ/);
  assert.throws(() => parseCompletion({ choices: [] }), /без choices/);
  assert.throws(() => parseCompletion(answer('{"code":"unescaped\nnewline"}')), /некорректный JSON/);
  assert.throws(() => parseCompletion(answer(JSON.stringify(bot), 'content_filter')), /content_filter/);
  for (const value of [null, [], {}, { ...bot, code: ' ' }, { ...bot, name: '' }]) {
    assert.throws(() => parseCompletion(answer(JSON.stringify(value))), /некорректный код или название/);
  }
});

test('disable default thinking for flash and v4 while preserving legacy requests', () => {
  assert.deepEqual(completionRequest('deepseek-flash', 'system', 'prompt').thinking, { type: 'disabled' });
  assert.deepEqual(completionRequest('deepseek-v4-pro', 'system', 'prompt').thinking, { type: 'disabled' });
  assert.equal(completionRequest('deepseek-chat', 'system', 'prompt').thinking, undefined);
});

test('metadata describes empty reasoning-only replies without exposing content', () => {
  const response = answer('', 'length');
  response.choices[0].message.reasoning_content = 'private reasoning';
  response.usage = { completion_tokens: 8000 };
  assert.deepEqual(completionMetadata(response), {
    finishReason: 'length', contentLength: 0, reasoningLength: 17, completionTokens: 8000
  });
});
