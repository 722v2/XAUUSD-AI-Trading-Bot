import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTradeRisk, prepareExecutionIntent, submitDemoIntentSafely } from '../dist/index.js';

const settings = {mode:'FIXED_CASH',referenceCapital:100,riskCash:10,minimumRiskRewardRatio:2};
const spec = {symbol:'XAUUSD',tickSize:0.1,tickValuePerLot:1,volumeMin:0.01,volumeMax:100,volumeStep:0.01,priceDigits:2};
const trade = {direction:'BUY',entryPrice:2000,stopLoss:1990,takeProfit:2020,minimumRiskRewardRatio:2};

test('risk manager computes lot size from broker tick specifications', () => {
  const result = assessTradeRisk(settings,trade,spec);
  assert.equal(result.accepted,true);
  if (result.accepted) {
    assert.equal(result.volume,0.1);
    assert.equal(result.estimatedRiskCash,10);
    assert.equal(result.riskRewardRatio,2);
  }
});
test('risk manager rejects invalid geometry, RR and broker-minimum risk mismatch', () => {
  assert.equal(assessTradeRisk(settings,{...trade,stopLoss:2010},spec).accepted,false);
  assert.equal(assessTradeRisk(settings,{...trade,takeProfit:2010},spec).accepted,false);
  assert.equal(assessTradeRisk({...settings,riskCash:0.01},trade,spec).accepted,false);
});
test('execution intent is Demo-only and does not submit a live order', () => {
  const base = {id:'intent-1',idempotencyKey:'key-1',opportunityId:'opp-1',decisionId:'decision-1',settings,trade,spec,now:'2026-10-16T12:00:00Z'};
  assert.deepEqual(prepareExecutionIntent({...base,environment:'LIVE'}),{accepted:false,reason:'LIVE_DISABLED'});
  assert.equal(prepareExecutionIntent({...base,environment:'DEMO'}).accepted,true);
});
test('ambiguous MT5 submission reconciles by key and never retries blindly', async () => {
  let submits = 0;
  const states = [];
  const port = {
    getConnectionState: async () => 'CONNECTED',
    submit: async () => { submits += 1; throw new Error('timeout'); },
    findByIdempotencyKey: async () => null
  };
  const intent = {id:'intent-1',idempotencyKey:'key-1',opportunityId:'opp-1',environment:'DEMO',symbol:'XAUUSD',direction:'BUY',volume:0.1,stopLoss:1990,takeProfit:2020,createdAt:'2026-10-16T12:00:00Z'};
  const result = await submitDemoIntentSafely(intent,port,async (state) => { states.push(state); });
  assert.equal(result.state,'RECONCILIATION_REQUIRED');
  assert.equal(submits,1);
  assert.deepEqual(states,['SUBMITTED','UNKNOWN','RECONCILIATION_REQUIRED']);
});
