import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { newWorld, newPlayer, applyAction, finishFlights, snapshot } from '../server/game.js';
import { Store } from '../server/store.js';
import { RACES, STARS, STAR_BY_ID, distance, fuelCost } from '../public/shared.js';

function setup(race = 'human') {
  const world = newWorld();
  const player = newPlayer('Тестовый', race);
  world.users[player.id] = { player };
  return { world, player, act: (type, extra = {}) => applyAction(world, player.id, { id: randomUUID(), revision: player.revision, type, ...extra }) };
}

test('50 unique systems, correct homes and connected galaxy for the shortest-range ship', () => {
  assert.equal(STARS.length, 50);
  assert.equal(new Set(STARS.map(s => s.id)).size, 50);
  const expected = { human: 'Солнце', malok: 'Трон', peleng: 'Пхедок', faeyan: 'Фэя', gaalian: 'Краа' };
  for (const [id, race] of Object.entries(RACES)) {
    const player = newPlayer('Капитан', id);
    assert.equal(STAR_BY_ID[player.location].name, expected[id]);
    assert.ok(player.credits >= race.money[0] && player.credits <= race.money[1]);
    assert.equal(player.capacity, race.cargo);
    assert.equal(player.hull, race.cargo);
  }
  const visited = new Set(['sol']), queue = [STAR_BY_ID.sol];
  while (queue.length) {
    const star = queue.shift();
    for (const neighbor of STARS) if (!visited.has(neighbor.id) && distance(star, neighbor) <= 260) { visited.add(neighbor.id); queue.push(neighbor); }
  }
  assert.equal(visited.size, 50);
});

test('all initial contracts are reachable, profitable and fit every starter ship', () => {
  const world = newWorld();
  assert.equal(world.contracts.length, 150);
  for (const c of world.contracts) {
    assert.ok(distance(STAR_BY_ID[c.origin], STAR_BY_ID[c.target]) <= 250);
    assert.ok(c.weight <= 28);
    assert.ok(c.reward > 6 * fuelCost(STAR_BY_ID[c.origin], STAR_BY_ID[c.target]) + 12);
  }
});

test('complete delivery, idempotent reward and persistent claim replacement', () => {
  const { world, player, act } = setup();
  const contract = world.contracts.find(c => c.origin === player.location);
  const credits = player.credits;
  act('accept', { contractId: contract.id });
  assert.equal(player.contracts.length, 1);
  assert.throws(() => act('deliver', { contractId: contract.id }), /назначения/);
  act('jump', { target: contract.target });
  assert.throws(() => act('refuel'), /перелёта/);
  assert.ok(player.fuel < 80);
  finishFlights(world, player.journey.arrivesAt + 1);
  assert.equal(player.location, contract.target);
  const action = { id: randomUUID(), revision: player.revision, type: 'deliver', contractId: contract.id };
  applyAction(world, player.id, action);
  assert.equal(player.credits, credits + contract.reward);
  assert.equal(player.completed, 1);
  assert.equal(player.contracts.length, 0);
  assert.equal(world.contracts.length, 150);
  assert.equal(applyAction(world, player.id, action).duplicate, true);
  assert.equal(player.credits, credits + contract.reward);
});

test('shared order can be claimed by exactly one player', () => {
  const { world, player, act } = setup();
  const other = newPlayer('Второй', 'human');
  world.users[other.id] = { player: other };
  const contract = world.contracts.find(c => c.origin === 'sol');
  act('accept', { contractId: contract.id });
  assert.throws(() => applyAction(world, other.id, { id: randomUUID(), revision: 0, type: 'accept', contractId: contract.id }), /другой капитан/);
  assert.equal(other.contracts.length, 0);
  assert.equal(player.contracts.length, 1);
});

test('reject stale revisions, invalid travel, remote claims and overfilled cargo', () => {
  const { world, player, act } = setup();
  assert.throws(() => applyAction(world, player.id, { id: randomUUID(), revision: -1, type: 'upgrade' }), /Состояние изменилось/);
  assert.throws(() => act('jump', { target: 'not-a-star' }), /другую систему/);
  assert.throws(() => act('jump', { target: 'feya' }), /вне дальности/);
  assert.throws(() => act('accept', { contractId: world.contracts.find(c => c.origin !== player.location).id }), /отправления/);
  player.capacity = 1;
  assert.throws(() => act('accept', { contractId: world.contracts.find(c => c.origin === player.location).id }), /трюме/);
  player.fuel = 0;
  assert.throws(() => act('jump', { target: 'human-1' }), /топлива/);
});

test('station services and recovery cannot strand or give free credits', () => {
  const { player, act } = setup();
  player.credits = 5000;
  player.fuel = 0; player.hull = 10;
  act('refuel'); assert.equal(player.fuel, 80); assert.equal(player.credits, 4760);
  act('repair'); assert.equal(player.hull, player.maxHull); assert.equal(player.credits, 4694);
  const range = player.range, capacity = player.capacity;
  act('upgrade'); assert.equal(player.range, range + 35); assert.equal(player.capacity, capacity + 8);
  player.credits = 0; player.fuel = 0; player.hull = 10;
  act('rescue'); assert.equal(player.fuel, 30); assert.equal(player.hull, 30); assert.equal(player.credits, 0);
  assert.throws(() => act('rescue'), /не требуется/);
});

test('snapshots hide credentials, sessions and action receipts', () => {
  const { world, player } = setup();
  world.users[player.id].passwordHash = 'secret-hash';
  world.sessions['secret-session'] = { playerId: player.id };
  player.receipts.push({ id: 'secret-action' });
  const data = JSON.stringify(snapshot(world, player.id));
  assert.ok(!data.includes('secret-'));
  assert.ok(!data.includes('passwordHash'));
});

test('atomic store survives restart; failed transactions leave no partial state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-store-'));
  try {
    const store = new Store(dir);
    const player = newPlayer('Капитан', 'faeyan');
    store.transact(world => { world.users[player.id] = { player }; });
    const saved = JSON.stringify(store.state);
    assert.throws(() => store.transact(world => { world.users[player.id].player.credits = 0; throw new Error('abort'); }));
    assert.equal(JSON.stringify(store.state), saved);
    assert.equal(JSON.stringify(new Store(dir).state), saved);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
