export function botEnvironment(code, token, settings = process.env) {
  const environment = { BOT_TOKEN: token };
  if (code.includes('DEEPSEEK_')) {
    if (!settings.DEEPSEEK_API_KEY) throw new Error('Для этого бота нужен DEEPSEEK_API_KEY на сервере.');
    Object.assign(environment, {
      DEEPSEEK_API_KEY: settings.DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL: (settings.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
      DEEPSEEK_MODEL: settings.DEEPSEEK_MODEL || 'deepseek-chat'
    });
  }
  return environment;
}
