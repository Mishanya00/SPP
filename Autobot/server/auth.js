import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { db } from './db.js';
import { hashPassword, verifyPassword } from './security.js';
import { log } from './logger.js';
import { mailer } from './mail.js';
import { roles, availableRoles, can } from './roles.js';

export const authRouter = Router();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const password = z.string().min(8, 'Пароль: минимум 8 символов.').max(128);
const email = z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Некорректный email.').transform(value => value.toLowerCase());
const credentials = z.object({ username: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/, 'Имя: 3–32 латинские буквы, цифры или _.'), password }).strict();
const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', path: '/' };
const sessionLifetime = 7 * 86400000;
const lockDuration = 15 * 60000;
const maxSessions = 5;
const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
const authLimit = rateLimit({ windowMs: lockDuration, limit: 30, message: { error: 'Слишком много попыток. Подождите 15 минут.' } });
function sessionToken(req) {
  if (req.headers.authorization?.startsWith('Bearer ')) return req.headers.authorization.slice(7);
  return req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('session='))?.slice(8) || '';
}
function publicUser(user) { return { id: user.id, username: user.username, role: user.role, email: user.email }; }
function login(req, res, user) {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
  const sessions = db.prepare('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC').all(user.id);
  for (const session of sessions.slice(maxSessions - 1)) db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
  const token = randomBytes(32).toString('hex');
  const expiresAt = now + sessionLifetime;
  db.prepare('INSERT INTO sessions(id, user_id, expires, created_at, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(digest(token), user.id, expiresAt, now, now, req.ip, (req.headers['user-agent'] || '').slice(0, 300));
  res.cookie('session', token, { ...cookieOptions, maxAge: sessionLifetime });
  log('info', 'Вход выполнен', { requestId: req.requestId, userId: user.id, role: user.role });
  return { ...publicUser(user), accessToken: token, expiresAt };
}
export function authenticate(req, res, next) {
  const id = digest(sessionToken(req));
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires > ?').get(id, Date.now());
  const user = session && db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!user) return res.set('WWW-Authenticate', 'Bearer realm="autobot"').status(401).json({ error: 'Войдите в аккаунт.' });
  db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?').run(Date.now(), id);
  req.session = session;
  const allowed = availableRoles(user.role);
  req.user = { ...publicUser(user), role: allowed.includes(session.active_role) ? session.active_role : user.role,
    assignedRole: user.role, availableRoles: allowed, demoMode: process.env.DEMO_ROLE_SWITCH === 'true' };
  next();
}
export function requireAdmin(req, res, next) {
  if (!can(req.user.role, 'manageUsers')) return res.status(403).json({ error: 'Нужна роль администратора.' });
  next();
}
export function requireAssignedAdmin(req, res, next) {
  if (req.user.assignedRole !== 'admin') return res.status(403).json({ error: 'Назначать постоянные роли может только администратор аккаунта. Учебное переключение меняет права текущей сессии.' });
  next();
}

authRouter.post('/register', authLimit, async (req, res) => {
  const values = credentials.extend({ email: email.optional() }).parse(req.body);
  const user = { id: randomUUID(), username: values.username.toLowerCase(), email: values.email || null, role: 'user' };
  const hash = await hashPassword(values.password);
  try { db.prepare('INSERT INTO users(id, username, password, role, email) VALUES (?, ?, ?, ?, ?)').run(user.id, user.username, hash, user.role, user.email); }
  catch (error) { if (String(error.message).includes('UNIQUE')) fail(409, 'Имя пользователя или email уже заняты.'); throw error; }
  res.status(201).json(login(req, res, user));
});
authRouter.post('/login', authLimit, async (req, res) => {
  const values = credentials.parse(req.body);
  const username = values.username.toLowerCase();
  const identifier = digest(username);
  const now = Date.now();
  const attempts = db.prepare('SELECT * FROM login_attempts WHERE identifier = ?').get(identifier);
  if (attempts?.locked_until > now) {
    res.set('Retry-After', String(Math.ceil((attempts.locked_until - now) / 1000)));
    fail(429, 'Вход временно заблокирован после неудачных попыток. Подождите 15 минут.');
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const valid = await verifyPassword(values.password, user?.password || dummyHash);
  if (!user || !valid) {
    const stored = db.prepare('SELECT * FROM login_attempts WHERE identifier = ?').get(identifier);
    const failures = (stored && stored.updated_at > now - lockDuration ? stored.failures : 0) + 1;
    db.prepare('INSERT INTO login_attempts VALUES (?, ?, ?, ?) ON CONFLICT(identifier) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at')
      .run(identifier, failures, failures >= 5 ? now + lockDuration : 0, now);
    log('warn', 'Неудачная попытка входа', { requestId: req.requestId, userId: user?.id, ip: req.ip });
    res.set('WWW-Authenticate', 'Bearer realm="autobot"');
    fail(401, 'Неверное имя пользователя или пароль.');
  }
  db.prepare('DELETE FROM login_attempts WHERE identifier = ?').run(identifier);
  res.json(login(req, res, user));
});
authRouter.post('/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(digest(sessionToken(req)));
  res.clearCookie('session', cookieOptions).status(204).end();
});
authRouter.post('/forgot-password', authLimit, async (req, res) => {
  const values = z.object({ email }).strict().parse(req.body);
  if (!mailer.configured()) fail(503, 'На сервере не настроено восстановление через почту.');
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(values.email);
  if (user) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM password_resets WHERE user_id = ? OR expires <= ?').run(user.id, Date.now());
    db.prepare('INSERT INTO password_resets VALUES (?, ?, ?)').run(digest(token), user.id, Date.now() + 15 * 60000);
    try { await mailer.sendReset(values.email, token); }
    catch (error) {
      db.prepare('DELETE FROM password_resets WHERE id = ?').run(digest(token));
      log('error', 'Не удалось отправить письмо восстановления', { requestId: req.requestId, userId: user.id, code: error.code });
      fail(503, 'Почтовый сервис временно недоступен.');
    }
    log('info', 'Запрошено восстановление доступа', { requestId: req.requestId, userId: user.id });
  }
  res.status(202).json({ message: 'Если этот email зарегистрирован, на него отправлена ссылка восстановления.' });
});
authRouter.post('/reset-password', authLimit, async (req, res) => {
  const values = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), password }).strict().parse(req.body);
  const hash = await hashPassword(values.password);
  // Consume after the asynchronous hash, inside one transaction: a key is usable once.
  db.exec('BEGIN IMMEDIATE');
  try {
    const reset = db.prepare('SELECT * FROM password_resets WHERE id = ? AND expires > ?').get(digest(values.token), Date.now());
    if (!reset) fail(400, 'Ссылка недействительна или истекла.');
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, reset.user_id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(reset.user_id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.user_id);
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(reset.user_id);
    db.prepare('DELETE FROM login_attempts WHERE identifier = ?').run(digest(user.username));
    db.exec('COMMIT');
    log('info', 'Пароль восстановлен; сессии отозваны', { requestId: req.requestId, userId: reset.user_id });
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  res.clearCookie('session', cookieOptions).status(204).end();
});
for (const path of ['/register', '/login', '/logout', '/forgot-password', '/reset-password']) authRouter.all(path, (req, res) => res.set('Allow', 'POST').status(405).json({ error: 'Метод не поддерживается.' }));

authRouter.use(authenticate);
authRouter.get('/me', (req, res) => res.json(req.user));
authRouter.put('/role', (req, res) => {
  const { role } = z.object({ role: z.enum(roles) }).strict().parse(req.body);
  if (!req.user.availableRoles.includes(role)) fail(403, 'Выбранная роль выше назначенной аккаунту. Для учебного переключения включите DEMO_ROLE_SWITCH.');
  db.prepare('UPDATE sessions SET active_role = ? WHERE id = ?').run(role, req.session.id);
  log('info', 'Активная роль сессии изменена', { requestId: req.requestId, userId: req.user.id, role, assignedRole: req.user.assignedRole, demoMode: req.user.demoMode });
  res.json({ ...req.user, role });
});
authRouter.post('/check-permission', (req, res) => {
  const { action } = z.object({ action: z.enum(['readBots', 'manageBots', 'manageUsers']) }).strict().parse(req.body);
  if (!can(req.user.role, action)) fail(403, `Роль ${req.user.role} не разрешает это действие.`);
  res.json({ role: req.user.role, action, allowed: true });
});
authRouter.put('/email', authLimit, async (req, res) => {
  const values = z.object({ email, password }).strict().parse(req.body);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!await verifyPassword(values.password, user.password)) fail(401, 'Неверный пароль.');
  try { db.prepare('UPDATE users SET email = ? WHERE id = ?').run(values.email, user.id); }
  catch (error) { if (String(error.message).includes('UNIQUE')) fail(409, 'Этот email уже используется.'); throw error; }
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
  log('info', 'Email для восстановления обновлён', { requestId: req.requestId, userId: user.id });
  res.json({ ...req.user, email: values.email });
});
authRouter.get('/sessions', (req, res) => res.json(db.prepare('SELECT id, created_at AS createdAt, last_seen AS lastSeen, expires, ip, user_agent AS userAgent FROM sessions WHERE user_id = ? AND expires > ? ORDER BY created_at DESC').all(req.user.id, Date.now()).map(session => ({ ...session, current: session.id === req.session.id }))));
authRouter.delete('/sessions/:id', (req, res) => {
  const result = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!result.changes) fail(404, 'Сессия не найдена.');
  if (req.params.id === req.session.id) res.clearCookie('session', cookieOptions);
  log('info', 'Сессия отозвана', { requestId: req.requestId, userId: req.user.id });
  res.status(204).end();
});
for (const [path, allow] of [['/me', 'GET, HEAD'], ['/role', 'PUT'], ['/check-permission', 'POST'], ['/email', 'PUT'], ['/sessions', 'GET, HEAD'], ['/sessions/:id', 'DELETE']]) authRouter.all(path, (req, res) => res.set('Allow', allow).status(405).json({ error: 'Метод не поддерживается.' }));
