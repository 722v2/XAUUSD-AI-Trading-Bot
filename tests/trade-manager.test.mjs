import test from 'node:test';
import assert from 'node:assert/strict';
import { managePositionStop } from '../dist/index.js';

const policy={breakEvenAtR:1,trailingStartsAtR:1.5,trailingAtrMultiplier:1.2,priceDigits:2,tickSize:0.01,minimumStopDistance:0.1};
test('trade manager moves stop to break-even at one R without changing target',()=>{
  const result=managePositionStop({ticket:7,direction:'BUY',entryPrice:2000,stopLoss:1990,takeProfit:2030},2010,2,policy);
  assert.deepEqual(result,{action:'MODIFY_STOP',reason:'BREAK_EVEN',ticket:7,stopLoss:2000,takeProfit:2030});
});
test('trade manager trails only in the protective direction and never loosens stop',()=>{
  const result=managePositionStop({ticket:7,direction:'BUY',entryPrice:2000,stopLoss:2000,initialStopLoss:1990,takeProfit:2030},2020,2,policy);
  assert.equal(result.action,'MODIFY_STOP');
  if(result.action==='MODIFY_STOP'){assert.equal(result.reason,'ATR_TRAILING');assert.ok(result.stopLoss>2000);assert.equal(result.takeProfit,2030);}
  const sell=managePositionStop({ticket:8,direction:'SELL',entryPrice:2000,stopLoss:2010,takeProfit:1970},1980,2,policy);
  assert.equal(sell.action,'MODIFY_STOP');
  if(sell.action==='MODIFY_STOP') assert.ok(sell.stopLoss<2000);
});
test('trade manager refuses stale/invalid geometry and stops too close to price',()=>{
  assert.equal(managePositionStop({ticket:7,direction:'BUY',entryPrice:2000,stopLoss:1990,takeProfit:2030},2005,2,policy).reason,'NOT_PROFITABLE_ENOUGH');
  assert.equal(managePositionStop({ticket:7,direction:'BUY',entryPrice:2000,stopLoss:1990,takeProfit:2030},2010,0,policy).reason,'ATR_UNAVAILABLE');
  const result=managePositionStop({ticket:7,direction:'BUY',entryPrice:2000,stopLoss:1990,takeProfit:2030},2020,2,{...policy,minimumStopDistance:100});
  assert.equal(result.action,'NO_ACTION');
  assert.equal(result.reason,'STOP_TOO_CLOSE');
});
