(() => {
  const panel = document.querySelector('#role-panel');
  const names = { viewer: 'Наблюдатель', user: 'Пользователь', admin: 'Администратор' };
  let snapshot;
  function element(tag, text) { const node = document.createElement(tag); if (text) node.textContent = text; return node; }
  async function refresh() {
    if (document.hidden) return;
    try {
      const response = await fetch('/api/auth/me');
      const user = response.ok ? await response.json() : null;
      const key = JSON.stringify(user);
      if (key === snapshot) return;
      snapshot = key;
      const open = panel.querySelector('details')?.open;
      panel.replaceChildren();
      const details = element('details'); details.open = open || false;
      details.append(element('summary', user ? `${user.username} · ${names[user.role]} (${user.role})` : 'Аккаунт и восстановление доступа'));
      const content = element('div'); content.className = 'content';
      if (user) {
        content.append(element('p', user.role === 'viewer' ? 'Можно читать своих ботов. Создание и изменение запрещены.' : user.role === 'user' ? 'Можно создавать и управлять своими ботами.' : 'Доступны все проекты и список пользователей.'));
        const mode = element('p', user.demoMode ? 'Учебный режим · все роли доступны' : `Назначенная роль: ${user.assignedRole}`); mode.className = 'mode'; content.append(mode);
        const label = element('label', 'Работать как');
        const select = element('select');
        for (const role of user.availableRoles) { const option = element('option', `${names[role]} (${role})`); option.value = role; select.append(option); }
        select.value = user.role; label.append(select); content.append(label);
        const button = element('button', 'Переключить роль');
        const status = element('p'); status.setAttribute('role', 'status');
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const response = await fetch('/api/auth/role', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: select.value }) });
            const data = await response.json(); if (!response.ok) throw new Error(data.error);
            location.reload();
          } catch (error) { status.textContent = error.message; status.className = 'error'; button.disabled = false; }
        });
        content.append(button, status);
      }
      const access = element('a', user ? 'Роли и проверка прав' : 'Восстановить доступ'); access.href = '/access.html'; content.append(access);
      if (user) { const sessions = element('a', 'Активные сессии аккаунта'); sessions.href = '/access.html#sessions-heading'; content.append(sessions); }
      details.append(content); panel.append(details);
    } catch { /* Keep the last role indicator during a temporary network failure. */ }
  }
  refresh(); setInterval(refresh, 5000);
  document.addEventListener('visibilitychange', refresh);
})();
