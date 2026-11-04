// Shared, deterministic world and rules. The server is authoritative.
export const RACES = {
  human: { name: 'Люди', home: 'sol', color: '#e8b76b', symbol: '◈', ship: 'Странник', money: [1000, 1400], hull: 100, cargo: 32, range: 285, speed: 1, description: 'Любопытство сильнее страха. Универсальный корабль и уверенный старт.' },
  malok: { name: 'Малоки', home: 'tron', color: '#df8272', symbol: '⬡', ship: 'Бастион', money: [650, 950], hull: 150, cargo: 38, range: 260, speed: 0.85, description: 'Тяжёлая броня, вместительный трюм. Сила, на которую можно положиться.' },
  peleng: { name: 'Пеленги', home: 'phedok', color: '#a5bc7d', symbol: '⟐', ship: 'Тень', money: [1200, 1700], hull: 85, cargo: 28, range: 300, speed: 1.15, description: 'Риск — часть сделки. Больше кредитов и быстрый корабль, но слабее броня.' },
  faeyan: { name: 'Фэяне', home: 'feya', color: '#8bbecb', symbol: '✳', ship: 'Спектр', money: [800, 1150], hull: 90, cargo: 30, range: 340, speed: 1.1, description: 'Технологии открывают путь. Самый дальнобойный стартовый двигатель.' },
  gaalian: { name: 'Гаальцы', home: 'kraa', color: '#b4a0d1', symbol: '⌘', ship: 'Гармония', money: [900, 1250], hull: 110, cargo: 42, range: 280, speed: 0.95, description: 'Равновесие во всём. Большой трюм для тех, кто мыслит на несколько рейсов вперёд.' },
};

const sectors = [
  ['human', 280, 340, ['Солнце', 'Альтаир', 'Сириус', 'Вега', 'Процион', 'Денеб', 'Тау Кита', 'Арктур', 'Поллукс', 'Эридан']],
  ['malok', 730, 180, ['Трон', 'Харг', 'Гром', 'Зарг', 'Тарос', 'Ригель', 'Крон', 'Багор', 'Дракон', 'Феррум']],
  ['peleng', 280, 160, ['Пхедок', 'Пелла', 'Шелез', 'Ксарон', 'Мираж', 'Зигур', 'Хадар', 'Атлас', 'Шарг', 'Искра']],
  ['faeyan', 730, 490, ['Фэя', 'Элион', 'Лира', 'Нимб', 'Селена', 'Аврора', 'Эфир', 'Альциона', 'Терра', 'Орион']],
  ['gaalian', 360, 550, ['Краа', 'Аэлис', 'Ирида', 'Эдем', 'Нова', 'Аурис', 'Таури', 'Меридиан', 'Кассиопея', 'Мира']],
];
// Hand-spaced offsets keep labels legible; coordinates are light years.
const offsets = [[0, 0], [100, -30], [-105, -28], [40, -88], [-34, -90], [155, 40], [-155, 40], [65, 65], [-65, 65], [165, -65]];
export const STARS = sectors.flatMap(([race, x, y, names]) => names.map((name, i) => ({
  id: i ? `${race}-${i}` : RACES[race].home, name, race,
  x: x + offsets[i][0], y: y + offsets[i][1], capital: i === 0,
  economy: ['Промышленность', 'Научный центр', 'Торговый узел', 'Аграрный мир'][i % 4],
})));
export const STAR_BY_ID = Object.fromEntries(STARS.map(star => [star.id, star]));
export const distance = (a, b) => Math.round(Math.hypot(a.x - b.x, a.y - b.y));
export const fuelCost = (a, b) => Math.max(4, Math.ceil(distance(a, b) / 9));
export const flightSeconds = (a, b, speed) => Math.max(5, Math.round(distance(a, b) / (22 * speed)));
export const cargoUsed = player => player.contracts.reduce((sum, contract) => sum + contract.weight, 0);
export const repairCost = player => Math.ceil((player.maxHull - player.hull) * 3);
export const refuelCost = player => (80 - player.fuel) * 3;
export const upgradeCost = player => 900 + player.upgrades * 650;

export const SAFE_SYSTEMS = new Set(Object.values(RACES).map(race => race.home));
export const ESCAPE_MS = 400;
export const weaponDamage = player => ({ min: 2 + (player.weaponLevel || 0) * 1.5, max: 4.5 + (player.weaponLevel || 0) * 2.5 });
export const weaponCost = player => 650 + (player.weaponLevel || 0) * 500;
