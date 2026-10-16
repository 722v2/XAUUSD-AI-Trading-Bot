import test from 'node:test';
import assert from 'node:assert/strict';
import { OpportunityLifecycleService } from '../dist/index.js';

const evidence = (expiresAt = '2026-10-16T12:10:00.000Z') => ({
  strategyId: 'test', direction: 'BUY', evidenceCodes: ['TEST'], entryPrice: 2000,
  stopLoss: 1998, takeProfit: 2004, createdAt: '2026-10-16T12:00:00.000Z', expiresAt
});
const id = value => value;

test('opportunity lifecycle deduplicates candidates and records transitions', () => {
  const service = new OpportunityLifecycleService();
  const first = service.register({id:id('opp-1'),dedupeKey:'candidate-1',evidence:evidence(),now:'2026-10-16T12:01:00.000Z'});
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  const duplicate = service.register({id:id('opp-2'),dedupeKey:'candidate-1',evidence:evidence(),now:'2026-10-16T12:01:01.000Z'});
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.created, false);
  const moved = service.transition({id:id('opp-1'),to:'ANALYZING',now:'2026-10-16T12:02:00.000Z',reasonCode:'ANALYSIS_STARTED',expectedVersion:1});
  assert.equal(moved.ok, true);
  assert.equal(service.events().length, 2);
});
test('opportunity lifecycle rejects stale versions and illegal transitions', () => {
  const service = new OpportunityLifecycleService();
  service.register({id:id('opp-1'),dedupeKey:'candidate-1',evidence:evidence(),now:'2026-10-16T12:01:00.000Z'});
  assert.deepEqual(service.transition({id:id('opp-1'),to:'OPEN',now:'2026-10-16T12:02:00.000Z',reasonCode:'bad',expectedVersion:1}), {ok:false,error:'INVALID_TRANSITION'});
  assert.deepEqual(service.transition({id:id('opp-1'),to:'ANALYZING',now:'2026-10-16T12:02:00.000Z',reasonCode:'start',expectedVersion:99}), {ok:false,error:'VERSION_CONFLICT'});
});
test('expired evidence is rejected and pending opportunities expire deterministically', () => {
  const service = new OpportunityLifecycleService();
  assert.deepEqual(service.register({id:id('old'),dedupeKey:'old',evidence:evidence('2026-10-16T11:59:00.000Z'),now:'2026-10-16T12:00:00.000Z'}), {ok:false,error:'EXPIRED_EVIDENCE'});
  service.register({id:id('opp-2'),dedupeKey:'candidate-2',evidence:evidence(),now:'2026-10-16T12:01:00.000Z'});
  assert.deepEqual(service.expireDue('2026-10-16T12:11:00.000Z'), ['opp-2']);
  assert.equal(service.get(id('opp-2')).status, 'EXPIRED');
});
