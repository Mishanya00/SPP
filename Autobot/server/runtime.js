import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { db, dataDir, event, getBot } from './db.js';
import { decrypt } from './security.js';
import { telegram } from './telegram.js';
import { botLog, savedLogs } from './bot-logs.js';
import { redact, errorDetail } from './logger.js';
import { completionRequest, completionMetadata, parseCompletion, repairRequest } from './deepseek.js';
import { botEnvironment } from './bot-environment.js';
const exec = promisify(execFile);
const dockerCommand = async (args, environment = {}) => {
  try { return await exec('docker', args, { env: { ...process.env, ...environment }, timeout: 30000, maxBuffer: 1024 * 1024 }); }
  catch (error) {
    // Never expose execFile's message: it includes the complete command and env arguments.
    const detail = redact(error.stderr || error.stdout || error.code || 'Docker не ответил').slice(-4000);
    throw Object.assign(new Error(`docker ${args[0]}: ${detail.trim()}`), { status: 503 });
  }
};
const docker = (...args) => dockerCommand(args);
const name = id => `autobot-${id}`;
export const busy = new Set();
export async function locked(id, action) {
  if (busy.has(id)) throw Object.assign(new Error('Дождитесь завершения текущей операции.'), { status: 409 });
  busy.add(id);
  try { return await action(); } finally { busy.delete(id); }
}
async function removeContainer(container) {
  const result = await docker('ps', '-aq', '--filter', `name=^/${container}$`);
  if (result.stdout.trim()) await docker('rm', '-f', container);
}
async function containerOutput(id) {
  const result = await docker('logs', '--timestamps', '--tail', '200', name(id));
  return redact([result.stdout, result.stderr].filter(Boolean).join('\n')).slice(-24000);
}
async function snapshot(id) {
  try {
    const output = await containerOutput(id);
    if (output) botLog(id, 'info', `Вывод Python перед остановкой:\n${output}`);
  } catch { /* A bot that has never started has no process output. */ }
}
export async function getLogs(id) {
  let output = '', notice = null;
  if (getBot(id)?.code) {
    try { output = await containerOutput(id); }
    catch (error) { notice = error.message; }
  }
  return { entries: savedLogs(id), output, notice };
}
export async function stopBot(id) {
  await snapshot(id);
  await removeContainer(name(id));
  await removeContainer(`${name(id)}-prepare`);
  db.prepare("UPDATE bots SET status = CASE WHEN code IS NULL THEN status ELSE 'stopped' END WHERE id = ?").run(id);
  botLog(id, 'info', 'Контейнер остановлен; данные сохранены');
}
export async function startBot(id) {
  const bot = getBot(id);
  if (!bot?.code || !bot.token) throw Object.assign(new Error('Нужны готовый код и Telegram API Key.'), { status: 409 });
  let stage = 'подготовка';
  const prepare = `${name(id)}-prepare`;
  const image = process.env.BOT_IMAGE || 'autobot-runner:local';
  try {
    botLog(id, 'info', 'Начало запуска бота');
    await stopBot(id);
    stage = 'настройка Telegram';
    await telegram(bot.token, 'setMyName', { name: bot.name });
    await telegram(bot.token, 'setMyDescription', { description: bot.description });
    await telegram(bot.token, 'setMyShortDescription', { short_description: bot.short_description });
    await telegram(bot.token, 'deleteWebhook', { drop_pending_updates: false });
    botLog(id, 'info', 'Профиль Telegram обновлён, webhook отключён');
    stage = 'копирование кода';
    await mkdir(`${dataDir}/${id}`, { recursive: true });
    await writeFile(`${dataDir}/${id}/main.py`, bot.code, { mode: 0o644 });
    await writeFile(`${dataDir}/${id}/runtime`, 'created');
    // Copy into a stopped staging container, then mount its volume read-only in the bot.
    await docker('create', '--name', prepare, '--label', 'app=autobot', '--network=none',
      '--mount', `type=volume,src=${name(id)}-code,dst=/app`, image);
    try { await docker('cp', `${dataDir}/${id}/main.py`, `${prepare}:/app/main.py`); }
    finally { await removeContainer(prepare); }
    botLog(id, 'info', 'main.py записан в отдельный том кода');
    stage = 'создание контейнера';
    const environment = botEnvironment(bot.code, decrypt(bot.token));
    await dockerCommand(['create', '--name', name(id), '--label', 'app=autobot', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=192m', '--cpus=0.5', '--pids-limit=64', '--user=10001:10001', '--tmpfs=/tmp:rw,noexec,nosuid,size=32m', '--mount', `type=volume,src=${name(id)}-data,dst=/data`, '--mount', `type=volume,src=${name(id)}-code,dst=/app,readonly`, '--log-opt', 'max-size=1m', '--log-opt', 'max-file=1', ...Object.keys(environment).flatMap(key => ['--env', key]), image], environment);
    stage = 'запуск Python';
    await docker('start', name(id));
    await new Promise(resolve => setTimeout(resolve, 2000));
    const { stdout } = await docker('inspect', '--format', '{{json .State}}', name(id));
    const state = JSON.parse(stdout);
    if (!state.Running) throw new Error(`Python завершился: exitCode=${state.ExitCode}, OOMKilled=${state.OOMKilled}. ${state.Error || ''}\n${await containerOutput(id)}`);
    db.prepare("UPDATE bots SET status = 'running', error = NULL WHERE id = ?").run(id);
    botLog(id, 'info', 'Процесс Python запущен; вывод доступен на вкладке «Логи»');
    event(id, 'Контейнер запущен. Бот готов к проверке в Telegram');
  } catch (error) {
    const detail = redact(`Ошибка запуска (${stage}): ${error.message}`).slice(-6000);
    botLog(id, 'error', detail);
    db.prepare("UPDATE bots SET status = 'error', error = ? WHERE id = ?").run(detail, id);
    throw Object.assign(new Error(detail), { status: error.status || 503 });
  }
}
export async function removeRuntime(id) {
  await stopBot(id);
  for (const suffix of ['data', 'code']) {
    const volume = `${name(id)}-${suffix}`;
    const volumes = await docker('volume', 'ls', '-q', '--filter', `name=^${volume}$`);
    if (volumes.stdout.trim()) await docker('volume', 'rm', volume);
  }
}
export async function generate(id) {
  busy.add(id);
  const started = Date.now();
  try {
    botLog(id, 'info', 'Начало генерации через DeepSeek');
    const bot = getBot(id);
    const initialRequest = completionRequest(process.env.DEEPSEEK_MODEL || 'deepseek-chat', await readFile(new URL('./prompt.txt', import.meta.url), 'utf8'), bot.prompt);
    let request = initialRequest;
    let result;
    const maxAttempts = 4;
    await mkdir(`${dataDir}/${id}`, { recursive: true });
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      event(id, attempt === 1 ? 'Запрос отправлен в DeepSeek' : `Исправление кода через DeepSeek: попытка ${attempt - 1} из ${maxAttempts - 1}`);
      const response = await fetch(`${(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify(request), signal: AbortSignal.timeout(180000)
      });
      if (!response.ok) {
        const hints = {
          400: 'Проверьте модель и параметры запроса.',
          401: 'Проверьте DEEPSEEK_API_KEY.',
          402: 'Пополните баланс DeepSeek API.',
          422: 'Проверьте параметры запроса.',
          429: 'Достигнут лимит запросов. Повторите позже.',
          500: 'Ошибка на стороне DeepSeek. Повторите позже.',
          503: 'DeepSeek перегружен. Повторите позже.'
        };
        await response.body?.cancel();
        throw new Error(`DeepSeek вернул HTTP ${response.status}. ${hints[response.status] || 'Проверьте настройки DeepSeek API.'}`);
      }
      const answer = await response.json();
      botLog(id, 'info', `Метаданные ответа DeepSeek: ${JSON.stringify(completionMetadata(answer))}`);
      let feedback;
      try { result = parseCompletion(answer); }
      catch (error) { feedback = redact(error.message); }
      if (!feedback) {
        botLog(id, 'info', `DeepSeek ответил за ${Date.now() - started} мс; получено ${result.code.length} символов кода`);
        event(id, 'Код получен от модели');
        await writeFile(`${dataDir}/${id}/main.py`, result.code);
        event(id, 'Файл main.py создан');
        try { await exec('python3', ['runner/validate.py', `${dataDir}/${id}/main.py`], { timeout: 10000 }); }
        catch (error) {
          // Infrastructure failures cannot be fixed by asking the model to rewrite code.
          if (typeof error.code !== 'number' || error.killed) throw new Error('Не удалось запустить или завершить проверку Python. Проверьте Python и логи сервера.');
          feedback = redact(error.stderr || error.message).slice(-6000);
        }
      }
      if (!feedback) break;
      botLog(id, 'warn', `Ответ не прошёл проверку (попытка ${attempt}/${maxAttempts}): ${feedback}`);
      if (attempt === maxAttempts) throw new Error('DeepSeek не смог исправить код после 3 автоматических исправлений. Подробности на вкладке «Логи».');
      request = repairRequest(initialRequest, redact(answer?.choices?.[0]?.message?.content || ''), feedback);
    }
    event(id, 'Синтаксис Python проверен');
    db.prepare("UPDATE bots SET code = ?, name = ?, status = 'ready', error = NULL WHERE id = ?").run(result.code, result.name, id);
    if (getBot(id).token) await startBot(id);
    else event(id, 'Добавьте Telegram API Key для запуска');
  } catch (error) {
    const detail = errorDetail(error);
    botLog(id, 'error', `Создание завершилось ошибкой: ${detail}`);
    db.prepare("UPDATE bots SET status = 'error', error = ? WHERE id = ?").run(error.name === 'TimeoutError' ? 'DeepSeek не ответил за 3 минуты. Повторите генерацию.' : error.message === 'fetch failed' ? `Нет соединения с DeepSeek: ${detail}. Проверьте DNS, VPN/прокси и доступ из контейнера.` : redact(error.message), id);
    event(id, 'Создание остановлено: требуется повторная попытка');
  } finally { busy.delete(id); }
}
let reconciling = false;
export async function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try {
    for (const bot of db.prepare("SELECT id FROM bots WHERE status = 'running'").all()) {
      if (busy.has(bot.id)) continue;
      let detail;
      try {
        const { stdout } = await docker('inspect', '--format', '{{json .State}}', name(bot.id));
        const state = JSON.parse(stdout);
        if (state.Running) continue;
        detail = `Контейнер завершился: exitCode=${state.ExitCode}, OOMKilled=${state.OOMKilled}. ${state.Error || ''}\n${await containerOutput(bot.id)}`;
      } catch (error) { detail = error.message; }
      if (!busy.has(bot.id) && getBot(bot.id)?.status === 'running') {
        botLog(bot.id, 'error', detail);
        db.prepare("UPDATE bots SET status = 'error', error = ? WHERE id = ?").run(redact(detail).slice(-6000), bot.id);
      }
    }
  } finally { reconciling = false; }
}
