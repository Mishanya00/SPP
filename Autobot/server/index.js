import { app } from './app.js';
import { db } from './db.js';
import { reconcile } from './runtime.js';
import { log } from './logger.js';
db.prepare("UPDATE bots SET status = 'error', error = 'Сервер перезапущен во время генерации. Повторите попытку.' WHERE status = 'generating'").run();
await reconcile();
const timer = setInterval(() => { reconcile().catch(error => log('error', 'Runtime reconciliation failed', { error })); }, 10000);
timer.unref();
app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => log('info', 'Автобот запущен', { port: Number(process.env.PORT || 3000) }));
