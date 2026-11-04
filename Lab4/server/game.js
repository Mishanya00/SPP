import { randomInt, randomUUID } from 'node:crypto';
import { RACES, STARS, STAR_BY_ID, distance, fuelCost, flightSeconds, cargoUsed, upgradeCost } from '../public/shared.js';

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
  return { version: 1, revision: 0, users: {}, sessions: {}, contracts: STARS.flatMap(star => Array.from({ length: 3 }, () => createContract(star))) };
}

export function newPlayer(username, raceId, now = Date.now()) {
  const race = RACES[raceId];
  requireRule(Boolean(race), 'Выберите расу.');
  return { id: randomUUID(), username, race: raceId, location: race.home, credits: randomInt(race.money[0], race.money[1] + 1),
    hull: race.hull, maxHull: race.hull, capacity: race.cargo, range: race.range, speed: race.speed, fuel: 80,
    upgrades: 0, completed: 0, earned: 0, visited: [race.home], contracts: [], journey: null, revision: 0,
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
  const player = world.users[playerId]?.player;
  requireRule(Boolean(player), 'Капитан не найден.');
  requireRule(typeof action.id === 'string' && /^[\w-]{10,80}$/.test(action.id), 'Некорректный номер действия.');
  const receipt = player.receipts.find(item => item.id === action.id);
  if (receipt) return { ...receipt, duplicate: true };
  requireRule(action.revision === player.revision, 'Состояние изменилось. Данные обновлены — повторите действие.');
  requireRule(!player.journey, 'Дождитесь завершения перелёта.');
  let message;
  const origin = STAR_BY_ID[player.location];
  if (action.type === 'jump') {
    const target = STAR_BY_ID[action.target];
    requireRule(Boolean(target) && target.id !== origin.id, 'Выберите другую систему.');
    requireRule(distance(origin, target) <= player.range, 'Система вне дальности двигателя. Летите через промежуточную звезду.');
    requireRule(player.fuel >= fuelCost(origin, target), 'Недостаточно топлива. Заправьтесь на станции.');
    requireRule(player.hull > 10, 'Требуется ремонт корпуса.');
    player.fuel -= fuelCost(origin, target);
    player.hull = Math.max(10, player.hull - 2);
    player.journey = { origin: origin.id, target: target.id, startedAt: now, arrivesAt: now + flightSeconds(origin, target, player.speed) * 1000 };
    message = `Курс на ${target.name}. Гиперпрыжок начат.`;
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
    const cost = amount * 3;
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
    player.maxHull += 15;
    player.hull = player.maxHull;
    message = `Корабль улучшен до уровня ${player.upgrades + 1}. Трюм +8 т, дальность +35 св. л., корпус +15.`;
  } else if (action.type === 'rescue') {
    requireRule(player.fuel < 30 || player.hull <= 10, 'Аварийная помощь сейчас не требуется.');
    // Safety net: a player can never become permanently stranded.
    player.fuel = Math.max(player.fuel, 30);
    player.hull = Math.max(player.hull, 30);
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
      journey: p.journey, completed: p.completed, online: online.has(p.id) })) };
}
