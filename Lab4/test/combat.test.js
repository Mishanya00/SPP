import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newWorld, newPlayer, applyAction, advanceCombat, migrateWorld } from '../server/game.js';
import { RACES, weaponDamage } from '../public/shared.js';

function setup(count = 2) {
  const world = newWorld();
  const players = Array.from({ length: count }, (_, i) => newPlayer(`Pilot${i}`, 'human', 0));
  for (const p of players) { p.location = 'human-1'; world.users[p.id] = { player: p }; }
  const act = (p, type, extra = {}, time = 0) => applyAction(world, p.id, { id: randomUUID(), revision: p.revision, type, ...extra }, time);
  return { world, players, act };
}

test('DPS is simultaneous, fractional and independent of tick frequency', () => {
  const { world, players: [a, b], act } = setup();
  act(a, 'attack', { target: b.id });
  const copy = structuredClone(world);
  advanceCombat(world, 1000, () => 1);
  for (let t = 100; t <= 1000; t += 100) advanceCombat(copy, t, () => 1);
  assert.equal(a.hull, 27.5);
  assert.equal(b.hull, 27.5);
  assert.equal(copy.users[a.id].player.hull, a.hull);
  assert.equal(b.combatTarget, a.id);
});

test('multiple attackers, manual target selection and automatic retarget after escape', () => {
  const { world, players: [a, b, c], act } = setup(3);
  act(a, 'attack', { target: b.id });
  act(c, 'attack', { target: b.id });
  act(b, 'target', { target: c.id });
  advanceCombat(world, 1000, () => 0);
  assert.equal(b.hull, 28); assert.equal(c.hull, 30); assert.equal(a.hull, 32);
  act(c, 'jump', { target: 'sol' }, 1000);
  advanceCombat(world, 1400, () => 0);
  assert.equal(b.combatTarget, a.id);
  assert.equal(c.combatTarget, null);
});

test('jump is immediate even at low HP; damage stops at precisely 400 ms', () => {
  const { world, players: [a, b], act } = setup();
  a.hull = 5;
  act(a, 'attack', { target: b.id });
  act(a, 'jump', { target: 'sol' }, 100);
  const before = a.hull;
  // Fix both rolls so the boundary test is independent of random damage before jump.
  a.damageRoll = b.damageRoll = { second: 0, dps: 2 };
  advanceCombat(world, 499, () => 0);
  assert.ok(Math.abs(a.hull - (before - .798)) < .00001);
  advanceCombat(world, 500, () => 0);
  const escaped = a.hull;
  assert.ok(Math.abs(escaped - (before - .8)) < .00001);
  advanceCombat(world, 3000, () => 0);
  assert.equal(a.hull, escaped);
  assert.equal(world.engagements.length, 0);
  assert.throws(() => act(b, 'attack', { target: a.id }, 3000), /недоступна/);
});

test('all home systems prohibit PvP for any race; remote and self targets rejected', () => {
  const { players: [a, b], act } = setup();
  for (const race of Object.values(RACES)) {
    a.location = b.location = race.home;
    assert.throws(() => act(a, 'attack', { target: b.id }), /запрещено/);
  }
  a.location = 'human-1'; b.location = 'human-2';
  assert.throws(() => act(a, 'attack', { target: b.id }), /недоступна/);
  assert.throws(() => act(a, 'attack', { target: a.id }), /другого/);
});

test('death resets ship and weapons, releases cargo, preserves credits and prevents continued damage', () => {
  const { world, players: [a, b], act } = setup();
  b.credits = 5000;
  act(b, 'weapon'); act(b, 'upgrade');
  const order = world.contracts.find(c => c.origin === b.location);
  act(b, 'accept', { contractId: order.id });
  const credits = b.credits;
  b.hull = .5;
  act(a, 'attack', { target: b.id });
  assert.throws(() => act(b, 'repair'), /во время боя/);
  advanceCombat(world, 1000, () => 0);
  assert.equal(b.location, 'sol'); assert.equal(b.hull, 32); assert.equal(b.capacity, 32);
  assert.equal(b.weaponLevel, 0); assert.equal(b.upgrades, 0); assert.equal(b.contracts.length, 0);
  assert.equal(b.credits, credits); assert.equal(b.journey, null);
  assert.equal(world.contracts.length, 150);
  assert.equal(world.contracts.some(c => c.id === order.id), false);
  assert.equal(a.combatTarget, null);
});

test('weapon upgrades are priced, bounded, affect DPS; old saves migrate without losing money', () => {
  const { world, players: [a], act } = setup();
  a.credits = 100000;
  act(a, 'weapon'); assert.equal(a.credits, 99350); assert.deepEqual(weaponDamage(a), { min: 3.5, max: 7 });
  for (let i = 1; i < 5; i++) act(a, 'weapon');
  assert.throws(() => act(a, 'weapon'), /полностью/);
  world.version = 1; a.hull = 50; a.maxHull = 100;
  const money = a.credits;
  migrateWorld(world, 123);
  assert.equal(a.hull, 16); assert.equal(a.maxHull, a.capacity); assert.equal(a.credits, money);
  assert.equal(world.version, 2);
});
