const notice = document.querySelector('#notice');
let resetToken = new URLSearchParams(location.search).get('reset');
let currentUser;
const roleNames = { viewer: 'Наблюдатель', user: 'Пользователь', admin: 'Администратор' };
if (resetToken) {
  document.querySelector('#reset-section').hidden = false;
  document.querySelector('#recovery').hidden = true;
  history.replaceState(null, '', '/access.html');
}
function message(text, error = false) { notice.textContent = text; notice.classList.toggle('error', error); }
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}
function form(id, action) {
  document.querySelector(`#${id}`).addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    button.disabled = true;
    try { await action(values); } catch (error) { message(error.message, true); }
    finally { button.disabled = false; }
  });
}
form('forgot', async values => { const data = await api('/api/auth/forgot-password', 'POST', values); message(data.message); });
form('reset', async values => {
  await api('/api/auth/reset-password', 'POST', { ...values, token: resetToken });
  resetToken = null;
  document.querySelector('#reset-section').hidden = true;
  message('Пароль изменён. Вернитесь в Автобот и войдите с новым паролем.');
});
form('email', async values => {
  await api('/api/auth/email', 'PUT', values);
  document.querySelector('#email input[name=password]').value = '';
  message('Email для восстановления сохранён.');
});
form('role', async values => {
  const user = await api('/api/auth/role', 'PUT', values);
  renderRole(user);
  document.querySelector('#permission-result').textContent = '';
  message(`Теперь вы работаете как ${roleNames[user.role]} (${user.role}). Права изменены на сервере без выхода из аккаунта.`);
  if (user.role === 'admin') await users();
});
function renderRole(user) {
  const supported = Array.isArray(user.availableRoles) && user.availableRoles.length > 0;
  user = { ...user, assignedRole: user.assignedRole || user.role,
    availableRoles: supported ? user.availableRoles : [user.role] };
  currentUser = user;
  document.querySelector('#identity').textContent = `${user.username} · активная роль: ${roleNames[user.role]} (${user.role}) · назначенная роль: ${user.assignedRole}`;
  document.querySelector('#role-mode').textContent = user.demoMode
    ? 'Учебный режим: можно выбрать любую роль для текущей сессии. Назначенная аккаунту роль не меняется.'
    : 'Можно временно ограничить свои права и затем вернуться к назначенной роли. Все роли доступны в учебном режиме.';
  const select = document.querySelector('#active-role'); select.replaceChildren();
  for (const role of user.availableRoles) {
    const option = document.createElement('option'); option.value = role; option.textContent = `${roleNames[role]} (${role})`; select.append(option);
  }
  select.value = user.role;
  document.querySelector('#role button').disabled = !supported;
  if (!supported) {
    document.querySelector('#role-mode').textContent = 'Сервер ещё не поддерживает переключение ролей. Обновите приложение; текущая роль показана в списке.';
  }
  const column = ['viewer', 'user', 'admin'].indexOf(user.role) + 1;
  for (const row of document.querySelectorAll('.permissions tr')) {
    [...row.children].forEach((cell, index) => cell.classList.toggle('active', index === column));
  }
  document.querySelector('#admin').hidden = user.role !== 'admin';
}
for (const [action, label] of [['readBots', 'Проверить просмотр'], ['manageBots', 'Проверить изменение ботов'], ['manageUsers', 'Проверить доступ администратора']]) {
  const button = document.createElement('button'); button.textContent = label;
  button.addEventListener('click', async () => {
    const result = document.querySelector('#permission-result'); button.disabled = true;
    try {
      await api('/api/auth/check-permission', 'POST', { action });
      result.textContent = `${label}: HTTP 200 — разрешено для роли ${currentUser.role}.`; result.classList.remove('error');
    } catch (error) { result.textContent = `${label}: HTTP ${error.status || '—'} — ${error.message}`; result.classList.add('error'); }
    finally { button.disabled = false; }
  });
  document.querySelector('#permission-checks').append(button);
}
document.querySelector('#refresh-sessions').addEventListener('click', () => sessions().catch(error => message(error.message, true)));
function item(container, text, buttonText, action) {
  const row = document.createElement('div'); row.className = 'item';
  const description = document.createElement('p'); description.textContent = text; row.append(description);
  const button = document.createElement('button'); button.textContent = buttonText;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await action(); } catch (error) { message(error.message, true); }
    finally { button.disabled = false; }
  });
  row.append(button); container.append(row); return row;
}
async function sessions() {
  const container = document.querySelector('#sessions'); container.replaceChildren();
  for (const session of await api('/api/auth/sessions')) {
    const date = new Date(session.lastSeen || session.expires - 7 * 86400000).toLocaleString('ru');
    item(container, `${session.current ? 'Текущая сессия · ' : ''}${session.ip || 'IP неизвестен'} · ${session.userAgent || 'Браузер неизвестен'} · активность: ${date}`, 'Завершить сессию', async () => {
      await api(`/api/auth/sessions/${encodeURIComponent(session.id)}`, 'DELETE');
      if (session.current) location.assign('/'); else await sessions();
    });
  }
}
async function users() {
  const container = document.querySelector('#users'); container.replaceChildren();
  for (const user of await api('/api/users')) {
    if (currentUser.assignedRole !== 'admin') {
      const row = document.createElement('p'); row.textContent = `${user.username} · назначенная роль: ${user.role}`; container.append(row); continue;
    }
    let select;
    const row = item(container, user.username, 'Изменить роль', async () => {
      await api(`/api/users/${encodeURIComponent(user.id)}/role`, 'PUT', { role: select.value });
      message('Роль изменена. Пользователь должен войти заново.');
      if (user.id === currentUser.id && user.role !== select.value) { location.assign('/'); return; }
      await users();
    });
    select = document.createElement('select'); select.setAttribute('aria-label', `Роль ${user.username}`);
    for (const role of ['viewer', 'user', 'admin']) {
      const option = document.createElement('option'); option.value = role; option.textContent = role; select.append(option);
    }
    select.value = user.role; row.insertBefore(select, row.lastChild);
  }
}
(async () => {
  try {
    const user = await api('/api/auth/me');
    document.querySelector('#account').hidden = false;
    renderRole(user);
    document.querySelector('#email input[name=email]').value = user.email || '';
    await sessions();
    if (user.role === 'admin') { document.querySelector('#admin').hidden = false; await users(); }
  } catch (error) { if (!error.message.includes('Войдите')) message(error.message, true); }
})();
