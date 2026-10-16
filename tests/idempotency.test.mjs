import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryIdempotencyRegistry } from '../dist/index.js';
test('in-memory idempotency helper rejects duplicate claims in one process', () => {
  const registry = new InMemoryIdempotencyRegistry();
  const key = 'intent:opportunity-1:DEMO';
  assert.equal(registry.claim(key), true);
  assert.equal(registry.claim(key), false);
  assert.equal(registry.has(key), true);
});
