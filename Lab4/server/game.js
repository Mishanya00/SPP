import { randomInt, randomUUID } from 'node:crypto';
import { RACES, STARS, STAR_BY_ID, distance, fuelCost, flightSeconds, cargoUsed, upgradeCost, repairCost, SAFE_SYSTEMS, ESCAPE_MS, weaponDamage, weaponCost } from '../public/shared.js';

export class GameError extends Error {}
const requireRule = (condition, message) => { if (!condition) throw new GameError(message); };
const goods = ['Медикаменты', 'Микросхемы', 'Запчасти', 'Образцы минералов', 'Провизия', 'Научное оборудование', 'Терраформеры', 'Почтовые капсулы'];

export function createContract(origin) {
  const destinations = STARS.filter(star => star.id !== origin.id && distance(origin, star) <= 250);
  const target = destinations[randomInt(destinations.length)];
  const weight = randomInt(5, 15);
  return { id: randomUUID(), origin: origin.id, target: target.id, goods: goods[randomInt(goods.length)], weight,
    reward: 200 + distance(origin, target) * 3 + weight * 8, claimedBy: null };
}

export function newWorld() {
  return { version: 2, combatAt: null, engagements: [], revision: 0, users: {}, sessions: {}, contracts: STARS.flatMap(star => Array.from({ length: 3 }, () => createContract(star))) };
}

export function newPlayer(username, raceId, now = Date.now()) {
  const race = RACES[raceId];
  requireRule(Boolean(race), 'Выберите расу.');
  return { id: randomUUID(), username, race: raceId, location: race.home, credits: randomInt(race.money[0], race.money[1] + 1),
    hull: race.cargo, maxHull: race.cargo, capacity: race.cargo, range: race.range, speed: race.speed, fuel: 80,
    weaponLevel: 0, combatTarget: null, upgrades: 0, completed: 0, earned: 0, visited: [race.home], contracts: [], journey: null, revision: 0,
    log: [{ text: `Добро пожаловать, капитан. Станция ${STAR_BY_ID[race.home].name} разрешает вылет.`, at: now }], receipts: [] };
}

function log(player, text, now) {
  player.log.unshift({ text, at: now });
  player.log = player.log.slice(0, 30);
}

export function finishFlights(world, now = Date.now()) {
  let changed = false;
  for (const { player } of Object.values(world.users)) {
    if (!player.journey || player.journey.arrivesAt > now) continue;
    const { target } = player.journey;
    player.location = target;
    player.journey = null;
    if (!player.visited.includes(target)) player.visited.push(target);
    player.revision++;
    log(player, `Прибытие в систему ${STAR_BY_ID[target].name}. Стыковка завершена.`, now);
    changed = true;
  }
  return changed;
}

// Called synchronously inside a single durable transaction: claims cannot interleave.
export function applyAction(world, playerId, action, now = Date.now()) {
  advanceCombat(world, now);
  const player = world.users[playerId]?.player;
  requireRule(Boolean(player), 'Капитан не найден.');
  requireRule(typeof action.id === 'string' && /^[\w-]{10,80}$/.test(action.id), 'Некорректный номер действия.');
  const receipt = player.receipts.find(item => item.id === action.id);
  if (receipt) return { ...receipt, duplicate: true };
  requireRule(action.revision === player.revision, 'Состояние изменилось. Данные обновлены — повторите действие.');
  requireRule(!player.journey, 'Дождитесь завершения перелёта.');
  requireRule(!player.combatTarget || ['attack', 'target', 'jump'].includes(action.type), 'Обслуживание и заказы недоступны во время боя.');
  let message;
  const origin = STAR_BY_ID[player.location];
  if (action.type === 'jump') {
    const target = STAR_BY_ID[action.target];
    requireRule(Boolean(target) && target.id !== origin.id, 'Выберите другую систему.');
    requireRule(distance(origin, target) <= player.range, 'Система вне дальности двигателя. Летите через промежуточную звезду.');
    requireRule(player.fuel >= fuelCost(origin, target), 'Недостаточно топлива. Заправьтесь на станции.');
    player.fuel -= fuelCost(origin, target);
    player.journey = { origin: origin.id, target: target.id, startedAt: now, arrivesAt: now + flightSeconds(origin, target, player.speed) * 1000 };
    message = `Курс на ${target.name}. Гиперпрыжок начат.`;
  } else if (action.type === 'attack' || action.type === 'target') {
    const enemy = world.users[action.target]?.player;
    requireRule(Boolean(enemy) && enemy.id !== player.id, 'Выберите другого капитана.');
    requireRule(!SAFE_SYSTEMS.has(player.location), 'В стартовых системах PvP запрещено.');
    requireRule(canFight(player, enemy, now), 'Цель уже покинула систему или недоступна.');
    const linked = world.engagements.some(pair => pair.includes(player.id) && pair.includes(enemy.id));
    requireRule(action.type !== 'target' || linked, 'Эта цель не участвует в вашем бою.');
    if (!linked) world.engagements.push([player.id, enemy.id]);
    player.combatTarget = enemy.id;
    if (!enemy.combatTarget) enemy.combatTarget = player.id;
    message = `Цель: ${enemy.username}. Оружие активно.`;
    log(enemy, `Капитан ${player.username} открыл огонь.`, now);
  } else if (action.type === 'weapon') {
    requireRule(player.weaponLevel < 5, 'Оружие уже полностью улучшено.');
    const cost = weaponCost(player);
    requireRule(player.credits >= cost, 'Недостаточно кредитов для оружия.');
    player.credits -= cost;
    player.weaponLevel++;
    message = `Оружие улучшено до уровня ${player.weaponLevel + 1}.`;
  } else if (action.type === 'accept') {
    const contract = world.contracts.find(item => item.id === action.contractId);
    requireRule(Boolean(contract) && !contract.claimedBy, 'Этот заказ уже забрал другой капитан. Выберите другой.');
    requireRule(contract.origin === player.location, 'Заказ можно взять только на станции отправления.');
    requireRule(player.contracts.length < 3, 'Можно выполнять не более трёх заказов одновременно.');
    requireRule(cargoUsed(player) + contract.weight <= player.capacity, 'Недостаточно места в трюме.');
    contract.claimedBy = player.id;
    player.contracts.push({ ...contract });
    message = `Груз принят: ${contract.goods}. Пункт назначения — ${STAR_BY_ID[contract.target].name}.`;
  } else if (action.type === 'deliver' || action.type === 'abandon') {
    const contract = player.contracts.find(item => item.id === action.contractId);
    requireRule(Boolean(contract), 'Заказ не найден.');
    if (action.type === 'deliver') {
      requireRule(contract.target === player.location, 'Доставьте груз в систему назначения.');
      player.credits += contract.reward;
      player.earned += contract.reward;
      player.completed++;
      message = `Заказ выполнен: ${contract.goods}. Получено ${contract.reward} кр.`;
    } else {
      message = `Заказ отменён: ${contract.goods}. Груз передан службе возврата.`;
    }
    player.contracts = player.contracts.filter(item => item.id !== contract.id);
    world.contracts = world.contracts.filter(item => item.id !== contract.id);
    world.contracts.push(createContract(STAR_BY_ID[contract.origin]));
  } else if (action.type === 'refuel' || action.type === 'repair') {
    const refuel = action.type === 'refuel';
    const amount = refuel ? 80 - player.fuel : player.maxHull - player.hull;
    requireRule(amount > 0, refuel ? 'Бак уже полон.' : 'Корпус не повреждён.');
    const cost = refuel ? amount * 3 : repairCost(player);
    requireRule(player.credits >= cost, 'Недостаточно кредитов.');
    player.credits -= cost;
    if (refuel) player.fuel = 80;
    else player.hull = player.maxHull;
    message = `${refuel ? 'Бак заправлен' : 'Корпус восстановлен'}. Списано ${cost} кр.`;
  } else if (action.type === 'upgrade') {
    requireRule(player.upgrades < 5, 'Корабль уже полностью улучшен.');
    const cost = upgradeCost(player);
    requireRule(player.credits >= cost, 'Недостаточно кредитов для улучшения.');
    player.credits -= cost;
    player.upgrades++;
    player.capacity += 8;
    player.range += 35;
    player.maxHull = player.capacity;
    player.hull = player.maxHull;
    message = `Корабль улучшен до уровня ${player.upgrades + 1}. Трюм +8 т, дальность +35 св. л., HP +8.`;
  } else if (action.type === 'rescue') {
    requireRule(player.fuel < 30 || player.hull <= 10, 'Аварийная помощь сейчас не требуется.');
    // Safety net: a player can never become permanently stranded.
    player.fuel = Math.max(player.fuel, 30);
    player.hull = Math.min(player.maxHull, Math.max(player.hull, 30));
    player.credits = Math.max(0, player.credits - 100);
    message = 'Служба спасения пополнила аварийный запас. Стоимость — до 100 кр.';
  } else throw new GameError('Неизвестное действие.');
  player.revision++;
  log(player, message, now);
  const result = { id: action.id, message };
  player.receipts.push(result);
  player.receipts = player.receipts.slice(-100);
  return result;
}

export function snapshot(world, playerId, online = new Set(), now = Date.now()) {
  const { receipts, ...player } = world.users[playerId].player;
  return { type: 'state', revision: world.revision, serverTime: now, player,
    contracts: world.contracts.filter(contract => !contract.claimedBy),
    pilots: Object.values(world.users).map(({ player: p }) => ({ id: p.id, username: p.username, race: p.race, location: p.location,
      hull: p.hull, maxHull: p.maxHull, weaponLevel: p.weaponLevel, combatTarget: p.combatTarget, journey: p.journey, completed: p.completed, online: online.has(p.id) })) };
}

function canFight(a, b, time) {
  return a && b && a.hull > 0 && b.hull > 0 && a.location === b.location
    && !SAFE_SYSTEMS.has(a.location)
    && (!a.journey || time < a.journey.startedAt + ESCAPE_MS)
    && (!b.journey || time < b.journey.startedAt + ESCAPE_MS);
}

function syncTargets(world, time) {
  world.engagements = world.engagements.filter(([a, b]) => canFight(world.users[a]?.player, world.users[b]?.player, time));
  for (const { player } of Object.values(world.users)) {
    const enemies = world.engagements.filter(pair => pair.includes(player.id)).map(pair => pair.find(id => id !== player.id));
    if (!enemies.includes(player.combatTarget)) player.combatTarget = enemies[0] || null;
  }
}

function respawn(world, player, now) {
  for (const contract of player.contracts) {
    world.contracts = world.contracts.filter(c => c.id !== contract.id);
    world.contracts.push(createContract(STAR_BY_ID[contract.origin]));
  }
  const starter = newPlayer(player.username, player.race, now);
  for (const key of ['location', 'hull', 'maxHull', 'capacity', 'range', 'speed', 'fuel', 'upgrades', 'weaponLevel', 'combatTarget', 'contracts', 'journey']) player[key] = starter[key];
  delete player.damageRoll;
  player.revision++;
  log(player, 'Корабль уничтожен. Груз и улучшения потеряны. Вы получили стартовый корабль в родной системе; кредиты сохранены.', now);
}

// Integrate DPS over elapsed time, splitting at second boundaries and exact escape times.
// All ships fire simultaneously; one ship has one damage budget, even with many attackers.
export function advanceCombat(world, now = Date.now(), random = Math.random) {
  world.engagements ||= [];
  let time = world.combatAt ?? now;
  if (now < time) return false;
  let changed = world.engagements.length > 0;
  while (time < now && world.engagements.length) {
    syncTargets(world, time);
    if (!world.engagements.length) break;
    let end = Math.min(now, time + 100, (Math.floor(time / 1000) + 1) * 1000);
    const players = Object.values(world.users).map(user => user.player);
    for (const p of players) if (p.combatTarget && p.journey) end = Math.min(end, p.journey.startedAt + ESCAPE_MS);
    const damage = new Map();
    for (const p of players) {
      if (!p.combatTarget) continue;
      const second = Math.floor(time / 1000);
      if (p.damageRoll?.second !== second) {
        const range = weaponDamage(p);
        p.damageRoll = { second, dps: range.min + random() * (range.max - range.min) };
      }
      damage.set(p.combatTarget, (damage.get(p.combatTarget) || 0) + p.damageRoll.dps * (end - time) / 1000);
    }
    for (const [id, amount] of damage) {
      const p = world.users[id].player;
      p.hull = Math.max(0, Math.round((p.hull - amount) * 1e6) / 1e6);
    }
    const dead = players.filter(p => p.hull <= 0);
    for (const p of dead) respawn(world, p, end);
    time = end;
  }
  syncTargets(world, now);
  world.combatAt = now;
  return changed;
}

export function migrateWorld(world, now = Date.now()) {
  if (world.version === 1) {
    for (const { player } of Object.values(world.users)) {
      player.hull = Math.max(1, Math.round(player.hull / player.maxHull * player.capacity));
      player.maxHull = player.capacity;
      player.weaponLevel = 0;
      player.combatTarget = null;
    }
    world.engagements = [];
    world.version = 2;
  }
  // Server downtime is paused combat, not accumulated offline damage.
  world.combatAt = now;
  syncTargets(world, now);
}
