import { decrypt } from './security.js';
import { log, redact } from './logger.js';
export async function telegram(token, method, body = {}, raw = false) {
  let response;
  const started = Date.now();
  try {
    response = await fetch(`https://api.telegram.org/bot${raw ? token : decrypt(token)}/${method}`, {
      method: 'POST', headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      body: body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    log('error', 'Telegram connection failed', { method, durationMs: Date.now() - started, reason: error.cause?.code || error.name });
    throw Object.assign(new Error('Telegram недоступен. Попробуйте ещё раз.'), { status: 502 });
  }
  const data = await response.json();
  log(data.ok ? 'info' : 'error', 'Telegram API response', { method, status: response.status, durationMs: Date.now() - started, description: data.ok ? undefined : redact(data.description) });
  if (!data.ok) throw Object.assign(new Error(`Telegram: ${String(data.description || 'ошибка запроса').replace(/\d{5,}:[\w-]+/g, '[скрыто]')}`), { status: 422 });
  return data.result;
}
