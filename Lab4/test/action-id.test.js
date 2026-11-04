import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createActionId } from '../public/shared.js';
import { newWorld, newPlayer, applyAction } from '../server/game.js';

test('HTTP without randomUUID: action IDs pass server validation and deduplicate retries', () => {
  const httpCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
  const world = newWorld();
  const player = newPlayer('HttpPilot', 'human');
  world.users[player.id] = { player };
  const contract = world.contracts.find(c => c.origin === player.location);
  const action = { id: createActionId(httpCrypto), revision: player.revision, type: 'accept', contractId: contract.id };
  assert.match(action.id, /^[a-f0-9]{32}$/);
  applyAction(world, player.id, action);
  assert.equal(applyAction(world, player.id, action).duplicate, true);
  assert.equal(player.contracts.length, 1);
  assert.notEqual(createActionId(httpCrypto), action.id);
});

test('HTTPS continues using the native UUID generator', () => {
  assert.match(createActionId(webcrypto), /^[a-f0-9-]{36}$/);
});
