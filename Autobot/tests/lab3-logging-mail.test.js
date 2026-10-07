import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { mailer } from '../server/mail.js';
import { log } from '../server/logger.js';

test('structured logs mask temporary keys and SMTP password', () => {
  const previous = process.env.SMTP_PASSWORD;
  const originalLog = console.log;
  process.env.SMTP_PASSWORD = 'smtp-test-secret';
  const records = [];
  try {
    console.log = line => records.push(JSON.parse(line));
    log('info', 'smtp-test-secret', { requestId: 'test-request', accessToken: 'session-key', resetToken: 'reset-key', SMTP_PASSWORD: 'smtp-test-secret' });
  } finally {
    console.log = originalLog;
    if (previous === undefined) delete process.env.SMTP_PASSWORD; else process.env.SMTP_PASSWORD = previous;
  }
  assert.equal(records[0].level, 'info');
  assert.equal(records[0].requestId, 'test-request');
  assert.ok(records[0].time);
  assert.doesNotMatch(JSON.stringify(records), /smtp-test-secret|session-key|reset-key/);
});

test('SMTP reset mail uses configured origin, one-use key and mandatory TLS', async () => {
  const settings = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: 'test-user', SMTP_PASSWORD: 'test-password', SMTP_FROM: 'sender@example.test', PUBLIC_BASE_URL: 'https://autobot.example.test' };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  const originalTransport = nodemailer.createTransport;
  let message, options;
  try {
    Object.assign(process.env, settings);
    nodemailer.createTransport = config => {
      options = config;
      return { sendMail: async value => { message = value; } };
    };
    assert.equal(mailer.configured(), true);
    await mailer.sendReset('user@example.test', 'a'.repeat(64));
    assert.equal(options.requireTLS, true); assert.equal(options.secure, false);
    assert.equal(options.auth.user, 'test-user');
    assert.equal(message.to, 'user@example.test');
    assert.match(message.text, /https:\/\/autobot.example.test\/access.html\?reset=a{64}/);
    assert.match(message.text, /15 минут/);
  } finally {
    nodemailer.createTransport = originalTransport;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
