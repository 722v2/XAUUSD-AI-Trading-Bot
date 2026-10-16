import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionOpportunity, transitionOpportunity, validateRiskSettings, targetRiskAmount, checkSecretReadiness, requireSecret, createNotReadyPipelineResult, RuntimeConfigStore, DEFAULT_RUNTIME_CONFIG } from '../dist/index.js';
const validPercentRisk = { mode: 'PERCENT_OF_CAPITAL', referenceCapital: 100, riskPercent: 1, minimumRiskRewardRatio: 2 };
const validCashRisk = { mode: 'FIXED_CASH', referenceCapital: 100, riskCash: 3, minimumRiskRewardRatio: 1.5 };

test('opportunity lifecycle accepts only declared transitions', () => {
  assert.equal(canTransitionOpportunity('DETECTED', 'ANALYZING'), true);
  assert.equal(canTransitionOpportunity('CLOSED', 'OPEN'), false);
  assert.equal(transitionOpportunity('DETECTED', 'ANALYZING'), 'ANALYZING');
  assert.throws(() => transitionOpportunity('CLOSED', 'OPEN'), /Invalid opportunity transition/);
});
test('risk settings support percentage and fixed-cash modes', () => {
  assert.equal(validateRiskSettings(validPercentRisk), null);
  assert.equal(targetRiskAmount(validPercentRisk), 1);
  assert.equal(validateRiskSettings(validCashRisk), null);
  assert.equal(targetRiskAmount(validCashRisk), 3);
});
test('risk settings reject invalid values without app-specific caps', () => {
  assert.equal(validateRiskSettings({ ...validPercentRisk, referenceCapital: 0 }), 'INVALID_REFERENCE_CAPITAL');
  assert.equal(validateRiskSettings({ ...validPercentRisk, riskPercent: Number.NaN }), 'INVALID_RISK_PERCENT');
  assert.equal(validateRiskSettings({ ...validCashRisk, riskCash: -1 }), 'INVALID_RISK_CASH');
  assert.equal(validateRiskSettings({ ...validCashRisk, riskPercent: 1 }), 'UNEXPECTED_RISK_FIELD');
  assert.equal(validateRiskSettings({ ...validPercentRisk, minimumRiskRewardRatio: -0.1 }), 'INVALID_MINIMUM_RR');
});
test('security readiness fails closed for missing or blank secrets', () => {
  assert.deepEqual(checkSecretReadiness(undefined), { configured: false, reason: 'MISSING_OR_BLANK' });
  assert.deepEqual(checkSecretReadiness('   '), { configured: false, reason: 'MISSING_OR_BLANK' });
  assert.deepEqual(checkSecretReadiness('configured-secret'), { configured: true });
  assert.throws(() => requireSecret(undefined, 'AI_API_KEY'), /Required secret is not configured/);
});
test('phase 1 pipeline returns explicit not-ready state rather than fake signals', () => {
  assert.deepEqual(createNotReadyPipelineResult('test-correlation', 'TECHNICAL_ANALYSIS', 'PHASE_NOT_IMPLEMENTED'), {
    status: 'NOT_READY', failedStage: 'TECHNICAL_ANALYSIS', reason: 'PHASE_NOT_IMPLEMENTED', correlationId: 'test-correlation'
  });
});
test('runtime configuration is versioned and keeps live trading disabled', () => {
  const store = new RuntimeConfigStore();
  const initial = store.getSnapshot();
  assert.equal(initial.config.defaultEnvironment, 'DEMO');
  assert.equal(initial.config.liveTradingEnabled, false);
  assert.equal(initial.config.scannerIntervalSeconds, 60);
  const updated = store.update('aiProviderId', 'provider-example', initial.version);
  assert.equal(updated.ok, true);
  if (updated.ok) assert.equal(updated.snapshot.config.aiProviderId, 'provider-example');
  assert.equal(store.update('scannerEnabled', true, initial.version).ok, false);
  assert.equal(DEFAULT_RUNTIME_CONFIG.liveTradingEnabled, false);
});
