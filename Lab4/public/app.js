import { RACES, STARS, STAR_BY_ID, distance, fuelCost, flightSeconds, cargoUsed, refuelCost, repairCost, upgradeCost, SAFE_SYSTEMS, ESCAPE_MS, weaponDamage, weaponCost } from './shared.js';

const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value);
const base = (window.STAR_ATLAS_SERVER || location.origin).replace(/\/$/, '');
const prefix = `atlas:${base}:`;
let storageAvailable = true;
const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(prefix + key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(prefix + key, JSON.stringify(value)); } catch { storageAvailable = false; } },
  remove(key) { try { localStorage.removeItem(prefix + key); } catch { storageAvailable = false; } },
};
let token = storage.get('token');
let state = token ? storage.get(`snapshot:${token}`) : null;
let pending = token ? storage.get(`pending:${token}`) : null;
let socket, connected = false, reconnectTimer, attempts = 0, sentId = null, lastMessage = 0, clockOffset = 0;
let selected = state?.player.location || 'sol', view = 'galaxy', tab = 'board', showRange = true, query = '', race = 'human', authMode = 'register';
let interacting = false;
document.addEventListener('pointerdown', () => { interacting = true; });
window.addEventListener('pointerup', () => setTimeout(() => { interacting = false; render(); }, 0));
window.addEventListener('pointercancel', () => { interacting = false; });
let toastTimer, zoom = innerWidth <= 800 ? 2.4 : 1;
let center = innerWidth <= 800 ? { ...STAR_BY_ID[selected] } : { x: 520, y: 360 };
const disabled = condition => condition ? 'disabled' : '';
const busy = () => !connected || Boolean(pending) || Boolean(state?.player.journey);

function toast(message, error = false) {
  $('#toast').textContent = message;
  $('#toast').className = `toast${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 5500);
}
function renderRaces() {
  $('#race-options').innerHTML = Object.entries(RACES).map(([id, item]) => `<button type="button" class="race-option ${race === id ? 'selected' : ''}" data-race="${id}" style="--race:${item.color}" aria-pressed="${race === id}"><span aria-hidden="true">${item.symbol}</span>${item.name}</button>`).join('');
  const item = RACES[race];
  $('#race-details').innerHTML = `<h3>${item.ship} <span style="color:${item.color}">/ ${item.name}</span></h3><p>${item.description}</p><div class="race-stats"><span><small>СТАРТОВЫЙ КАПИТАЛ</small>${number(item.money[0])}–${number(item.money[1])} кр.</span><span><small>ТРЮМ / HP</small>${item.cargo} т</span><span><small>РОДНАЯ СИСТЕМА</small>${STAR_BY_ID[item.home].name}</span></div>`;
}
function setAuthMode(mode) {
  authMode = mode;
  $('#register-tab').classList.toggle('active', mode === 'register');
  $('#login-tab').classList.toggle('active', mode === 'login');
  $('#register-tab').setAttribute('aria-selected', mode === 'register');
  $('#login-tab').setAttribute('aria-selected', mode === 'login');
  $('#race-fieldset').classList.toggle('hidden', mode === 'login');
  $('#auth-title').innerHTML = mode === 'register' ? 'Каждый путь<br>начинается с выбора.' : 'С возвращением,<br>капитан.';
  $('#auth-submit').innerHTML = `${mode === 'register' ? 'Начать путешествие' : 'Войти на борт'} <span>↗</span>`;
  $('#password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
}
$('#register-tab').onclick = () => setAuthMode('register');
$('#login-tab').onclick = () => setAuthMode('login');
$('#race-options').onclick = event => { const target = event.target.closest('[data-race]'); if (target) { race = target.dataset.race; renderRaces(); } };
$('#auth-form').onsubmit = async event => {
  event.preventDefault();
  $('#auth-submit').disabled = true;
  $('#auth-error').textContent = '';
  try {
    const response = await fetch(`${base}/api/${authMode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#username').value.trim(), password: $('#password').value, race }), signal: AbortSignal.timeout(15_000) });
    const result = await response.json().catch(() => { throw new Error('Сервер игры недоступен. Проверьте адрес в config.js.'); });
    if (!response.ok) throw new Error(result.error || 'Не удалось войти.');
    token = result.token;
    storage.set('token', token);
    state = null; pending = null; selected = null; attempts = 0;
    $('#password').value = '';
    connect();
  } catch (error) {
    $('#auth-error').textContent = error.name === 'TypeError' || error.name === 'TimeoutError' ? 'Нет связи с сервером. Проверьте подключение и адрес сервера игры.' : error.message;
  } finally { $('#auth-submit').disabled = false; }
};

function connectionUI() {
  if (!state) return;
  $('#online-status').classList.toggle('offline', !connected);
  $('#online-status').innerHTML = `<span class="tiny-dot"></span><span>${connected ? `${state.pilots.filter(pilot => pilot.online).length} в сети` : 'Нет связи'}</span>`;
  const banner = $('#connection-banner');
  banner.classList.toggle('hidden', connected);
  banner.textContent = `Связь потеряна. Показываем последнее сохранённое состояние. Подключаемся автоматически…${pending ? ' Отправленное действие сохранено и будет проверено сервером.' : ''}`;
  $('#save-status').textContent = !storageAvailable ? 'Локальное хранилище недоступно; прогресс на сервере' : pending ? 'Ожидаем подтверждение действия…' : connected ? 'Прогресс сохранён на сервере' : 'Последнее состояние сохранено на устройстве';
}
function sendPending() {
  if (pending && connected && socket?.readyState === WebSocket.OPEN && sentId !== pending.id) {
    sentId = pending.id;
    socket.send(JSON.stringify(pending));
  }
}
function connect() {
  clearTimeout(reconnectTimer);
  if (!token) return;
  if (socket) { socket.onclose = null; socket.close(); }
  connected = false; sentId = null;
  const wsURL = new URL(`${base}/ws`);
  wsURL.protocol = wsURL.protocol === 'https:' ? 'wss:' : 'ws:';
  const current = socket = new WebSocket(wsURL);
  current.onopen = () => { lastMessage = Date.now(); current.send(JSON.stringify({ type: 'auth', token })); };
  current.onmessage = event => {
    if (current !== socket) return;
    lastMessage = Date.now();
    const message = JSON.parse(event.data);
    if (message.type === 'state') {
      const first = !state;
      const oldJourney = state?.player.journey;
      state = message; connected = true; attempts = 0;
      clockOffset = message.serverTime - Date.now();
      storage.set(`snapshot:${token}`, state);
      if (first || !selected || (oldJourney && !state.player.journey)) selected = state.player.location;
      if (first && innerWidth <= 800) center = { ...STAR_BY_ID[selected] };
      $('#onboarding').classList.add('hidden'); $('#game').classList.remove('hidden');
      render(); sendPending();
    } else if (message.type === 'ack' || message.type === 'error') {
      if (pending && message.id === pending.id) { pending = null; sentId = null; storage.remove(`pending:${token}`); }
      toast(message.message, message.type === 'error');
      render();
    }
  };
  current.onclose = event => {
    if (current !== socket) return;
    connected = false;
    if (event.code === 4001) {
      storage.remove('token'); token = null; state = null;
      $('#game').classList.add('hidden'); $('#onboarding').classList.remove('hidden');
      setAuthMode('login'); $('#auth-error').textContent = 'Сессия завершена. Войдите снова.';
      return;
    }
    if (state) { connectionUI(); renderSide(); }
    else $('#auth-error').textContent = 'Соединение с галактикой прервано. Повторяем подключение…';
    reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10_000));
  };
  current.onerror = () => {}; // close handles reconnection.
}
function act(type, extra = {}) {
  if (!state || busy()) return;
  pending = { id: crypto.randomUUID(), revision: state.player.revision, type, ...extra };
  storage.set(`pending:${token}`, pending);
  sendPending(); connectionUI(); renderSide();
}
$('#logout').onclick = async () => {
  const oldToken = token;
  clearTimeout(reconnectTimer);
  token = null; connected = false; state = null; pending = null;
  storage.remove('token');
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
  $('#game').classList.add('hidden'); $('#onboarding').classList.remove('hidden'); setAuthMode('login');
  try { await fetch(`${base}/api/logout`, { method: 'POST', headers: { Authorization: `Bearer ${oldToken}` }, signal: AbortSignal.timeout(5000) }); } catch { /* Local logout still succeeds while offline. */ }
};
window.addEventListener('online', () => { if (!connected) connect(); });
window.addEventListener('offline', () => { connected = false; if (socket) socket.close(); connectionUI(); if (state) renderSide(); });
setInterval(() => { if (socket?.readyState === WebSocket.OPEN && Date.now() - lastMessage > 40_000) socket.close(); }, 5000);

const svgShip = `<svg class="ship-art" viewBox="0 0 300 145" aria-label="Ваш космический корабль" role="img"><defs><linearGradient id="ship-metal" x1="0" x2="1"><stop stop-color="#586d60"/><stop offset=".5" stop-color="#c3c8a3"/><stop offset="1" stop-color="#40584c"/></linearGradient></defs><g transform="translate(150 72) rotate(35)"><path d="M-12 23l-7 33 19-10 19 10-7-33" fill="#d3b56c33"/><path d="M-7 35L0 68l7-33" fill="#e8b76b99"/><path d="M-11-10l-39 47 34-9 16 12 16-12 34 9-39-47L0-58z" fill="url(#ship-metal)" stroke="#bcc5a1" stroke-width=".7"/><path d="M0-58v98M-11-10l-5 38M11-10l5 38" stroke="#233c30" fill="none"/><path d="M0-35l-6 20 6 9 6-9z" fill="#e8b76b"/><path d="M-32 25l12-16M32 25L20 9" stroke="#d9c58b" stroke-width="2"/></g><path d="M40 115h60m100-90h60" stroke="#6f826133"/><text x="32" y="130" fill="#7b8f6b" font-size="7" letter-spacing="2">RANGER CLASS / MK.I</text></svg>`;

function render() {
  if (!state) return;
  const p = state.player;
  $('#current-system').textContent = p.journey ? `${STAR_BY_ID[p.journey.origin].name} → ${STAR_BY_ID[p.journey.target].name}` : STAR_BY_ID[p.location].name;
  $('#credits').textContent = number(p.credits);
  $('#captain-name').textContent = p.username;
  $('#captain-avatar').textContent = RACES[p.race].symbol;
  $('#captain-avatar').style.color = RACES[p.race].color;
  $('#ship-summary').textContent = `${RACES[p.race].ship} / HP ${number(p.hull)}/${p.maxHull} / ТОПЛИВО ${p.fuel} / ТРЮМ ${cargoUsed(p)} ИЗ ${p.capacity} Т`;
  $('#log-entries').innerHTML = p.log.slice(0, 3).map(entry => `<div class="log-entry"><time>${new Date(entry.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time><span>↗</span><span>${escapeHTML(entry.text)}</span></div>`).join('');
  connectionUI(); renderMap(); renderSide(); animate();
}
function routeButton(target) { return `<button class="route-link" data-target="${target}">↗ ${STAR_BY_ID[target].name} <span>→</span></button>`; }
function contractCard(contract, owned = false) {
  const p = state.player;
  const canDeliver = contract.target === p.location;
  const full = cargoUsed(p) + contract.weight > p.capacity || p.contracts.length >= 3;
  return `<article class="contract-card"><div class="contract-type"><span>ГРУЗОВОЙ КОНТРАКТ</span><span>${contract.weight} Т</span></div><h3>${contract.goods}</h3>${routeButton(contract.target)}<footer><span class="reward">+${number(contract.reward)} <small>кр.</small></span>${owned ? `<button class="accept-button ${canDeliver ? 'deliver' : ''}" data-action="deliver" data-contract="${contract.id}" ${disabled(busy() || !canDeliver)}>${canDeliver ? 'Сдать груз ↗' : 'В пути'}</button>` : `<button class="accept-button" data-action="accept" data-contract="${contract.id}" ${disabled(busy() || selected !== p.location || full)}>${full ? 'Трюм занят' : 'Принять ↗'}</button>`}</footer>${owned ? `<button class="discard" data-action="abandon" data-contract="${contract.id}" ${disabled(busy())}>Отменить заказ</button>` : ''}</article>`;
}
function service(title, detail, action, label, unavailable = false) {
  return `<div class="service-row"><div><strong>${title}</strong><small>${detail}</small></div><button class="accept-button" data-action="${action}" ${disabled(busy() || Boolean(state.player.combatTarget) || unavailable)}>${label}</button></div>`;
}
function services() {
  const p = state.player;
  return service('Заправка', `${p.fuel} / 80 ед. · 3 кр. за единицу`, 'refuel', `${refuelCost(p)} кр.`, p.fuel === 80 || p.credits < refuelCost(p))
    + service('Ремонт трюма / HP', `${number(p.hull)} / ${p.maxHull} · 3 кр. за единицу`, 'repair', `${repairCost(p)} кр.`, p.hull === p.maxHull || p.credits < repairCost(p))
    + service('Улучшение корабля', '+8 т трюм / HP · +35 дальность', 'upgrade', p.upgrades === 5 ? 'Максимум' : `${number(upgradeCost(p))} кр.`, p.upgrades === 5 || p.credits < upgradeCost(p))
    + service('Улучшение оружия', `Урон ${weaponDamage(p).min}–${weaponDamage(p).max} HP/с · уровень ${(p.weaponLevel || 0) + 1}`, 'weapon', p.weaponLevel >= 5 ? 'Максимум' : `${number(weaponCost(p))} кр.`, p.weaponLevel >= 5 || p.credits < weaponCost(p))
    + ((p.fuel < 30 || p.hull <= 10) ? service('Аварийная помощь', 'Запас топлива и ремонт · доступно без денег', 'rescue', 'До 100 кр.') : '');
}
function meter(label, value, max) { return `<div class="data-row"><span>${label}</span><strong>${number(value)} / ${max}</strong></div><div class="meter"><span style="width:${value / max * 100}%"></span></div>`; }
function renderSide() {
  if (interacting) return;
  if (!state) return;
  const p = state.player, star = STAR_BY_ID[selected] || STAR_BY_ID[p.location];
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  let html;
  if (view === 'contracts') {
    html = `<div class="side-title"><div class="eyebrow">ЛИЧНЫЕ КОНТРАКТЫ / ${p.contracts.length} ИЗ 3</div><h2>Мои заказы</h2><p>Трюм: ${cargoUsed(p)} / ${p.capacity} т. Сдавайте груз в системе назначения.</p></div><div class="contract-list">${p.contracts.map(c => contractCard(c, true)).join('') || '<div class="empty-state"><strong>Впереди ваш первый рейс</strong>Выберите свою систему на карте и примите заказ на станции.</div>'}</div><div class="side-section"><div class="data-row"><span>Выполнено заказов</span><strong>${p.completed}</strong></div><div class="data-row"><span>Всего заработано</span><strong>${number(p.earned)} кр.</strong></div></div>`;
  } else if (view === 'ship') {
    html = `<div class="side-title"><div class="eyebrow">${RACES[p.race].name.toUpperCase()} / УРОВЕНЬ ${p.upgrades + 1}</div><h2>${RACES[p.race].ship}</h2><p>Капитан ${escapeHTML(p.username)}</p>${svgShip}</div><div class="side-section">${meter('Топливо', p.fuel, 80)}${meter('Трюм / здоровье (HP)', p.hull, p.maxHull)}${meter('Загрузка трюма', cargoUsed(p), p.capacity)}<div class="data-row"><span>Дальность прыжка</span><strong>${p.range} св. л.</strong></div><div class="data-row"><span>Исследовано систем</span><strong>${p.visited.length} / 50</strong></div></div><div class="side-section"><div class="section-title"><h2>Обслуживание корабля</h2></div>${services()}</div>`;
  } else if (view === 'pilots') {
    const pilots = [...state.pilots].sort((a, b) => Number(b.online) - Number(a.online) || b.completed - a.completed);
    html = `<div class="side-title"><div class="eyebrow">ОБЩАЯ ГАЛАКТИКА</div><h2>Капитаны</h2><p>${pilots.filter(p => p.online).length} в сети · ${pilots.length} зарегистрировано</p></div><div class="side-section">${pilots.map(pilot => `<div class="pilot-row ${pilot.online ? '' : 'offline'}"><span class="pilot-symbol" style="--race:${RACES[pilot.race].color}">${RACES[pilot.race].symbol}</span><div><strong>${escapeHTML(pilot.username)} ${pilot.id === p.id ? '· вы' : ''}</strong><small>${pilot.journey ? 'В гиперпространстве' : STAR_BY_ID[pilot.location].name} · ${number(pilot.hull)} / ${pilot.maxHull} HP</small></div>${pilot.online ? '<span class="tiny-dot"></span>' : ''}</div>`).join('')}</div>`;
  } else {
    const home = star.id === p.location;
    const dist = distance(STAR_BY_ID[p.location], star);
    const outOfRange = dist > p.range;
    const jumpLabel = p.journey ? 'Гиперпрыжок выполняется…' : home ? 'Вы в этой системе' : outOfRange ? 'Вне дальности двигателя' : p.fuel < fuelCost(STAR_BY_ID[p.location], star) ? 'Недостаточно топлива' : 'Гиперпрыжок';
    html = `<div class="side-title"><div class="eyebrow">${star.capital ? 'СТОЛИЧНАЯ' : 'ЗВЁЗДНАЯ'} СИСТЕМА</div><div class="system-visual" aria-hidden="true"><div class="mini-planet" style="--race:${RACES[star.race].color}"></div><span class="planet-moon"></span></div><h2>${star.name}</h2><p><span style="color:${RACES[star.race].color}">${RACES[star.race].symbol}</span> ${RACES[star.race].name} · ${star.economy}</p>${home ? '<span class="system-badge">⌖ Ваш корабль здесь</span>' : ''}</div><div class="side-section"><div class="data-row"><span>Расстояние</span><strong>${home ? 'На орбите' : `${dist} св. л.`}</strong></div><div class="data-row"><span>Топливо на прыжок</span><strong>${home ? '—' : `${fuelCost(STAR_BY_ID[p.location], star)} ед.`} <span style="color:var(--muted)">/ ${p.fuel} в баке</span></strong></div><div class="data-row"><span>Время перелёта</span><strong>${home ? '—' : `${flightSeconds(STAR_BY_ID[p.location], star, p.speed)} сек.`}</strong></div><button class="button primary" data-action="jump" data-target="${star.id}" ${disabled(busy() || home || outOfRange || p.fuel < fuelCost(STAR_BY_ID[p.location], star))}>${jumpLabel}<span>↗</span></button></div><div class="tabs"><button data-tab="board" class="${tab === 'board' ? 'active' : ''}">Заказы станции</button><button data-tab="services" class="${tab === 'services' ? 'active' : ''}">Обслуживание</button></div>`;
    if (tab === 'board') {
      const contracts = state.contracts.filter(c => c.origin === star.id);
      html += `<div class="contract-list">${!home ? '<p class="empty-state">Для принятия заказа прилетите в эту систему.</p>' : ''}${contracts.map(c => contractCard(c)).join('') || '<div class="empty-state">Все заказы разобраны капитанами. Новые появятся после завершения доставок.</div>'}</div>`;
    } else html += `<div class="side-section">${home ? services() : '<p class="empty-state">Услуги станции доступны после прибытия.</p>'}</div>`;
  }
  $('#side-content').innerHTML = combatPanel() + html;
}
function setView(next) { view = next; renderSide(); if (innerWidth <= 800) $('.side-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => setView(button.dataset.view));
$('#captain-button').onclick = () => setView('ship');
$('#side-content').onclick = event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.tab) { tab = button.dataset.tab; renderSide(); }
  else if (button.dataset.action) {
    if (button.dataset.action === 'abandon' && !confirm('Отменить заказ? Груз будет возвращён, награда не начислится.')) return;
    act(button.dataset.action, { ...(button.dataset.contract ? { contractId: button.dataset.contract } : {}), ...(button.dataset.target ? { target: button.dataset.target } : {}) });
  } else if (button.dataset.target) {
    selected = button.dataset.target; view = 'galaxy';
    if (innerWidth <= 800) {
      const from = STAR_BY_ID[state.player.location], to = STAR_BY_ID[selected];
      center = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    }
    renderMap(); renderSide();
    if (innerWidth <= 800) $('.main-panel').scrollIntoView({ behavior: 'smooth' });
  }
};

function renderMap() {
  if (interacting) return;
  if (!state) return;
  const p = state.player, here = STAR_BY_ID[p.location], target = STAR_BY_ID[selected];
  let svg = `<defs><filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter><pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M80 0H0V80" fill="none" stroke="#cadab608" stroke-width=".6"/><path d="M0 0h4m-4 0v4" stroke="#c2d4b018"/></pattern></defs><rect width="1040" height="720" fill="url(#grid)"/>`;
  for (let i = 0; i < 160; i++) svg += `<circle cx="${(i * 317 + 43) % 1040}" cy="${(i * 199 + 17) % 720}" r="${i % 3 ? .65 : 1}" fill="#bbc5a6" opacity="${i % 4 ? .16 : .32}"/>`;
  const edges = new Set();
  for (const star of STARS) {
    const nearest = STARS.filter(other => other.id !== star.id).sort((a, b) => distance(star, a) - distance(star, b)).slice(0, 2);
    for (const other of nearest) {
      const key = [star.id, other.id].sort().join(':');
      if (edges.has(key)) continue;
      edges.add(key);
      svg += `<line x1="${star.x}" y1="${star.y}" x2="${other.x}" y2="${other.y}" stroke="#8fba9c13" stroke-width=".8"/>`;
    }
  }
  svg += `<text class="sector-label" x="140" y="310">ТЕРРИТОРИЯ ЛЮДЕЙ</text><text class="sector-label" x="640" y="63">СЕКТОР МАЛОКОВ</text><text class="sector-label" x="145" y="40">СЕКТОР ПЕЛЕНГОВ</text><text class="sector-label" x="638" y="655">ПРОСТРАНСТВО ФЭЯН</text><text class="sector-label" x="235" y="662">МИРЫ ГААЛЬЦЕВ</text>`;
  if (showRange) svg += `<circle cx="${here.x}" cy="${here.y}" r="${p.range}" fill="#b9bc7903" stroke="#d9c88226" stroke-width=".8" stroke-dasharray="4 6"/><circle cx="${here.x}" cy="${here.y}" r="20" fill="none" stroke="#e8b76b38"/>`;
  const destinations = new Set(p.contracts.map(c => c.target));
  for (const id of destinations) { const dest = STAR_BY_ID[id]; svg += `<line x1="${here.x}" y1="${here.y}" x2="${dest.x}" y2="${dest.y}" stroke="#a8c3a343" stroke-dasharray="3 5"/>`; }
  if (target && target.id !== here.id) svg += `<line x1="${here.x}" y1="${here.y}" x2="${target.x}" y2="${target.y}" stroke="#e8b76b88" stroke-width="1" stroke-dasharray="5 5"/>`;
  for (const star of STARS) {
    const chosen = star.id === selected, mine = star.id === here.id, dimmed = query && !star.name.toLocaleLowerCase('ru').includes(query);
    svg += `<g class="star ${chosen ? 'selected' : ''} ${star.capital ? 'capital' : ''} ${dimmed ? 'dimmed' : ''}" data-star="${star.id}" tabindex="0" role="button" aria-label="${star.name}, ${RACES[star.race].name}${mine ? ', ваш корабль' : ''}"><title>${star.name} · ${RACES[star.race].name} · ${distance(here, star)} св. л.</title><circle cx="${star.x}" cy="${star.y}" r="18" fill="transparent"/>${chosen ? `<circle cx="${star.x}" cy="${star.y}" r="14" fill="#e8b76b10" stroke="#e8b76bb0" stroke-width=".8"/><path d="M${star.x - 20} ${star.y}h4m32 0h4M${star.x} ${star.y - 20}v4m0 32v4" stroke="#e8b76b80"/>` : ''}${destinations.has(star.id) ? `<rect x="${star.x - 9}" y="${star.y - 9}" width="18" height="18" rx="3" fill="none" stroke="#a4bd8d" stroke-dasharray="2 3"/>` : ''}<circle class="star-core" cx="${star.x}" cy="${star.y}" r="${star.capital ? 4.2 : 2.8}" fill="${RACES[star.race].color}"/><text x="${star.x + 10}" y="${star.y + (chosen ? 26 : 15)}">${star.name}${mine ? ' ·' : ''}</text></g>`;
  }
  for (const pilot of state.pilots) {
    if (!pilot.online && pilot.id !== p.id) continue;
    const at = STAR_BY_ID[pilot.location];
    svg += `<g data-pilot="${pilot.id}" transform="translate(${at.x + 10} ${at.y - 12})"><title>${escapeHTML(pilot.username)}</title><path class="${pilot.id === p.id ? 'ship-marker' : 'other-ship'}" d="M0-6L4 5 0 3-4 5z"/></g>`;
  }
  $('#galaxy').innerHTML = svg;
  applyZoom();
}
function animate() {
  if (!state || $('#game').classList.contains('hidden')) return;
  const time = connected ? Date.now() + clockOffset : state.serverTime;
  for (const pilot of state.pilots) {
    const node = document.querySelector(`[data-pilot="${pilot.id}"]`);
    if (!node || !pilot.journey) continue;
    const { origin, target, startedAt, arrivesAt } = pilot.journey;
    const a = STAR_BY_ID[origin], b = STAR_BY_ID[target], progress = Math.min(1, Math.max(0, (time - startedAt) / (arrivesAt - startedAt)));
    node.setAttribute('transform', `translate(${a.x + (b.x - a.x) * progress} ${a.y + (b.y - a.y) * progress}) rotate(${Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 90})`);
  }
  const flight = state.player.journey;
  $('#travel-overlay').classList.toggle('hidden', !flight);
  if (flight) {
    const remaining = Math.max(0, Math.ceil((flight.arrivesAt - time) / 1000));
    const progress = Math.min(100, Math.max(0, (time - flight.startedAt) / (flight.arrivesAt - flight.startedAt) * 100));
    $('#travel-overlay').innerHTML = `<strong>↗ Курс на ${STAR_BY_ID[flight.target].name}</strong><p>${connected ? (remaining ? `В гиперпространстве · до прибытия ${remaining} сек.` : 'Ожидаем разрешение на стыковку…') : 'Нет связи · ожидаем подтверждение положения'}</p><div class="meter"><span style="width:${progress}%"></span></div>`;
  }
}
setInterval(animate, 100);
function selectStar(event) {
  const star = event.target.closest('[data-star]');
  if (!star) return;
  selected = star.dataset.star; view = 'galaxy'; tab = 'board'; renderMap(); renderSide();
}
let drag;
$('#galaxy').addEventListener('pointerdown', event => { if (event.button !== 0) return; drag = { x: event.clientX, y: event.clientY, center: { ...center }, moved: false }; });
window.addEventListener('pointermove', event => {
  if (!drag) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (Math.hypot(dx, dy) > 5) drag.moved = true;
  if (!drag.moved) return;
  const scale = Math.max(1040 / $('#galaxy').clientWidth, 720 / $('#galaxy').clientHeight) / zoom;
  center = { x: drag.center.x - dx * scale, y: drag.center.y - dy * scale }; applyZoom();
});
window.addEventListener('pointerup', event => { if (drag && !drag.moved) selectStar(event); drag = null; });
window.addEventListener('pointercancel', () => { drag = null; });
$('#galaxy').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectStar(event); } });
function applyZoom() {
  center.x = Math.max(0, Math.min(1040, center.x)); center.y = Math.max(0, Math.min(720, center.y));
  $('#galaxy').setAttribute('viewBox', `${center.x - 520 / zoom} ${center.y - 360 / zoom} ${1040 / zoom} ${720 / zoom}`);
}
$('#zoom-in').onclick = () => { zoom = Math.min(3, zoom * 1.3); applyZoom(); };
$('#zoom-out').onclick = () => { zoom = Math.max(.75, zoom / 1.3); applyZoom(); };
$('#zoom-reset').onclick = () => { zoom = 1; center = { x: 520, y: 360 }; applyZoom(); };
$('#home-button').onclick = () => { if (!state) return; selected = state.player.location; view = 'galaxy'; center = { ...STAR_BY_ID[selected] }; zoom = 1.5; renderMap(); renderSide(); };
$('#range-toggle').onclick = () => { showRange = !showRange; $('#range-toggle').classList.toggle('active', showRange); $('#range-toggle').setAttribute('aria-pressed', showRange); renderMap(); };
$('#star-search').oninput = event => { query = event.target.value.trim().toLocaleLowerCase('ru'); renderMap(); };
$('#star-search').onkeydown = event => { if (event.key !== 'Enter' || !query) return; const found = STARS.find(star => star.name.toLocaleLowerCase('ru').includes(query)); if (found) { selected = found.id; center = { ...found }; zoom = 1.5; view = 'galaxy'; renderMap(); renderSide(); } else toast('Система не найдена. Попробуйте другое название.'); };
$('#map-legend').innerHTML = Object.values(RACES).map(race => `<span class="legend-item" style="--race:${race.color}"><i></i>${race.name}</span>`).join('') + '<span class="legend-note">ПЕРЕТАЩИТЕ КАРТУ ДЛЯ НАВИГАЦИИ</span>';
$('#help-button').onclick = () => $('#help-dialog').showModal();
$('#close-help').onclick = $('#help-done').onclick = () => $('#help-dialog').close();
renderRaces();
if (state && token) { $('#onboarding').classList.add('hidden'); $('#game').classList.remove('hidden'); render(); }
if (token) connect();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { /* Server-side progress remains available without shell caching. */ });

function combatPanel() {
  const p = state.player;
  const safe = SAFE_SYSTEMS.has(p.location);
  const time = Date.now() + clockOffset;
  const local = state.pilots.filter(other => other.id !== p.id && other.location === p.location && (!other.journey || time < other.journey.startedAt + ESCAPE_MS));
  const enemies = local.filter(other => other.combatTarget === p.id || p.combatTarget === other.id);
  const damage = weaponDamage(p);
  return `<section class="combat-panel ${p.combatTarget ? 'fighting' : ''}"><div class="section-title"><h2>${safe ? '◈ Безопасная система' : p.combatTarget ? '⚔ Бой' : '⚔ PvP-система'}</h2><span>${number(p.hull)} / ${p.maxHull} HP</span></div><p>Оружие: ${damage.min}–${damage.max} HP/с · ур. ${(p.weaponLevel || 0) + 1}</p>${p.combatTarget ? '<p class="combat-warning">Ремонт недоступен. Прыжок выводит из боя через 0,4 с.</p>' : ''}${safe ? '<p>Нападения запрещены для всех капитанов.</p>' : local.map(other => `<div class="combat-opponent"><div><strong>${escapeHTML(other.username)}</strong><small>${number(other.hull)} / ${other.maxHull} HP · ${weaponDamage(other).min}–${weaponDamage(other).max} HP/с</small></div><button class="accept-button" data-action="${enemies.some(e => e.id === other.id) ? 'target' : 'attack'}" data-target="${other.id}" ${disabled(busy() || p.combatTarget === other.id)}>${p.combatTarget === other.id ? 'Цель' : enemies.some(e => e.id === other.id) ? 'Выбрать' : 'Атаковать'}</button></div>`).join('') || '<p>Других кораблей в системе нет.</p>'}</section>`;
}
