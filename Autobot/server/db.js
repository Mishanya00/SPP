import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { log, redact } from './logger.js';
export const dataDir = resolve(process.env.DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(`${dataDir}/app.sqlite`);
db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), name TEXT NOT NULL, prompt TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', short_description TEXT NOT NULL DEFAULT '', token TEXT, telegram_id TEXT UNIQUE, username TEXT, code TEXT, avatar BLOB, status TEXT NOT NULL DEFAULT 'generating', error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE, message TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
db.exec('CREATE TABLE IF NOT EXISTS bot_logs (id INTEGER PRIMARY KEY, bot_id TEXT REFERENCES bots(id) ON DELETE CASCADE, level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)');
export const getBot = id => db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
export const event = (id, message) => {
  log('info', message, { botId: id });
  return db.prepare('INSERT INTO events(bot_id, message) VALUES (?, ?)').run(id, redact(message));
};
export function publicBot(bot) {
  const { token, code, avatar, user_id, ...safe } = bot;
  return { ...safe, hasToken: !!token, hasCode: !!code, hasAvatar: !!avatar,
    events: db.prepare('SELECT id, message, created_at FROM events WHERE bot_id = ? ORDER BY id').all(bot.id) };
}
