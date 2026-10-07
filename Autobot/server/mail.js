import nodemailer from 'nodemailer';

export const mailer = {
  configured: () => Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM && process.env.PUBLIC_BASE_URL),
  async sendReset(email, token) {
    const base = new URL(process.env.PUBLIC_BASE_URL);
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid PUBLIC_BASE_URL');
    const link = new URL('/access.html', base);
    link.searchParams.set('reset', token);
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      requireTLS: process.env.SMTP_SECURE !== 'true',
      ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {}),
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM, to: email,
      subject: 'Автобот: восстановление доступа',
      text: `Для смены пароля откройте ссылку: ${link}\nСсылка действует 15 минут и может использоваться только один раз. Если вы не запрашивали восстановление, проигнорируйте письмо.`
    });
  }
};
