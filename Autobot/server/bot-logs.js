import { db } from './db.js';
import { log, redact } from './logger.js';
export function botLog(id, level, message) {
  const text = redact(message).slice(-16000);
  log(level, text, { botId: id });
  try {
    db.prepare('INSERT INTO bot_logs(bot_id, level, message) VALUES (?, ?, ?)').run(id, level, text);
    db.prepare('DELETE FROM bot_logs WHERE bot_id = ? AND id NOT IN (SELECT id FROM bot_logs WHERE bot_id = ? ORDER BY id DESC LIMIT 300)').run(id, id);
  } catch (error) {
    // Diagnostics must not prevent a bot from starting when log storage is unavailable.
    log('error', 'Не удалось сохранить журнал в SQLite; запись доступна в stdout', { botId: id, error });
  }
}
export function savedLogs(id) {
  return db.prepare('SELECT id, level, message, created_at FROM bot_logs WHERE bot_id = ? ORDER BY id').all(id);
}
