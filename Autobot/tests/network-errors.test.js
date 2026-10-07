import test from 'node:test';
import assert from 'node:assert/strict';
import { errorDetail } from '../server/logger.js';

test('fetch diagnostics retain nested DNS and connection failures', () => {
  const cause = new AggregateError([
    Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('getaddrinfo api.deepseek.com'), { code: 'EAI_AGAIN' })
  ]);
  const detail = errorDetail(new TypeError('fetch failed', { cause }));
  assert.match(detail, /fetch failed/);
  assert.match(detail, /ETIMEDOUT/);
  assert.match(detail, /EAI_AGAIN/);
});

test('nested error messages do not disclose API keys', () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-secret-for-diagnostics';
  try {
    const detail = errorDetail(new TypeError('fetch failed', {
      cause: new Error('test-secret-for-diagnostics Bearer other-secret sk-example-key')
    }));
    assert.doesNotMatch(detail, /test-secret-for-diagnostics|other-secret|sk-example-key/);
    assert.match(detail, /REDACTED/);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test('cyclic causes cannot break error reporting', () => {
  const error = new Error('cycle');
  error.cause = error;
  assert.match(errorDetail(error), /cycle/);
});
