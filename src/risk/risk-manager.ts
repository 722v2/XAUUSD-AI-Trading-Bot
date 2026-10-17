import type { Direction, ExecutionIntentId, IdempotencyKey, OpportunityId, RiskSettings } from "../domain/types.js";
import { targetRiskAmount, validateRiskSettings } from "../domain/risk-settings.js";

export interface BrokerSymbolSpec {
  readonly symbol: "XAUUSD";
  readonly tickSize: number;
  readonly tickValuePerLot: number;
  readonly volumeMin: number;
  readonly volumeMax: number;
  readonly volumeStep: number;
  readonly priceDigits: number;
}
export interface RiskTradeRequest {
  readonly direction: Direction;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly minimumRiskRewardRatio: number;
}
export type RiskRejection =
  | "INVALID_RISK_SETTINGS"
  | "INVALID_BROKER_SPEC"
  | "INVALID_TRADE_GEOMETRY"
  | "RR_BELOW_MINIMUM"
  | "RISK_BELOW_BROKER_MINIMUM"
  | "RISK_EXCEEDS_BROKER_CAPACITY"
  | "INVALID_COMPUTATION";
export type RiskAssessment =
  | { readonly accepted: true; readonly requestedRiskCash: number; readonly estimatedRiskCash: number; readonly volume: number; readonly riskRewardRatio: number; readonly stopDistance: number; readonly takeProfitDistance: number }
  | { readonly accepted: false; readonly reason: RiskRejection; readonly requestedRiskCash?: number; readonly details?: string };

function isPositive(value: number): boolean { return Number.isFinite(value) && value > 0; }
function floorToStep(value: number, step: number): number {
  const precision = Math.min(10, Math.max(0, (step.toString().split(".")[1] ?? "").length));
  return Number((Math.floor((value + step * 1e-10) / step) * step).toFixed(precision));
}
export function assessTradeRisk(settings: RiskSettings, trade: RiskTradeRequest, spec: BrokerSymbolSpec): RiskAssessment {
  if (validateRiskSettings(settings) !== null || settings.minimumRiskRewardRatio !== trade.minimumRiskRewardRatio) {
    return { accepted: false, reason: "INVALID_RISK_SETTINGS" };
  }
  if (spec.symbol !== "XAUUSD" || !isPositive(spec.tickSize) || !isPositive(spec.tickValuePerLot) ||
      !isPositive(spec.volumeMin) || !isPositive(spec.volumeMax) || !isPositive(spec.volumeStep) ||
      !Number.isInteger(spec.priceDigits) || spec.priceDigits < 0 || spec.volumeMin > spec.volumeMax) {
    return { accepted: false, reason: "INVALID_BROKER_SPEC" };
  }
  if (![trade.entryPrice, trade.stopLoss, trade.takeProfit].every(isPositive)) return { accepted: false, reason: "INVALID_TRADE_GEOMETRY" };
  const stopDistance = Math.abs(trade.entryPrice - trade.stopLoss);
  const takeProfitDistance = Math.abs(trade.takeProfit - trade.entryPrice);
  const directionValid = trade.direction === "BUY"
    ? trade.stopLoss < trade.entryPrice && trade.takeProfit > trade.entryPrice
    : trade.stopLoss > trade.entryPrice && trade.takeProfit < trade.entryPrice;
  if (!directionValid || stopDistance <= 0 || takeProfitDistance <= 0) return { accepted: false, reason: "INVALID_TRADE_GEOMETRY" };
  const riskRewardRatio = takeProfitDistance / stopDistance;
  if (!Number.isFinite(riskRewardRatio) || riskRewardRatio < settings.minimumRiskRewardRatio) {
    return { accepted: false, reason: "RR_BELOW_MINIMUM", details: `Actual RR ${riskRewardRatio} is below minimum ${settings.minimumRiskRewardRatio}` };
  }
  const requestedRiskCash = targetRiskAmount(settings);
  const lossPerLot = (stopDistance / spec.tickSize) * spec.tickValuePerLot;
  if (!isPositive(lossPerLot) || !isPositive(requestedRiskCash)) return { accepted: false, reason: "INVALID_COMPUTATION" };
  const rawVolume = requestedRiskCash / lossPerLot;
  if (!Number.isFinite(rawVolume) || rawVolume < spec.volumeMin) return { accepted: false, reason: "RISK_BELOW_BROKER_MINIMUM", requestedRiskCash };
  if (rawVolume > spec.volumeMax) return { accepted: false, reason: "RISK_EXCEEDS_BROKER_CAPACITY", requestedRiskCash };
  const volume = floorToStep(rawVolume, spec.volumeStep);
  if (!isPositive(volume) || volume < spec.volumeMin) return { accepted: false, reason: "RISK_BELOW_BROKER_MINIMUM", requestedRiskCash };
  if (volume > spec.volumeMax) return { accepted: false, reason: "RISK_EXCEEDS_BROKER_CAPACITY", requestedRiskCash };
  const estimatedRiskCash = volume * lossPerLot;
  if (!Number.isFinite(estimatedRiskCash) || estimatedRiskCash > requestedRiskCash + Math.max(1e-8, requestedRiskCash * 1e-9)) {
    return { accepted: false, reason: "INVALID_COMPUTATION", requestedRiskCash };
  }
  return { accepted: true, requestedRiskCash, estimatedRiskCash, volume, riskRewardRatio, stopDistance, takeProfitDistance };
}

export type ExecutionPreparation =
  | { readonly accepted: true; readonly intent: { readonly id: ExecutionIntentId; readonly idempotencyKey: IdempotencyKey; readonly opportunityId: OpportunityId; readonly decisionId: import("../domain/types.js").DecisionId; readonly environment: "DEMO" | "LIVE"; readonly symbol: "XAUUSD"; readonly direction: Direction; readonly volume: number; readonly stopLoss: number; readonly takeProfit: number; readonly createdAt: string } }
  | { readonly accepted: false; readonly reason: "LIVE_DISABLED" | "RISK_REJECTED"; readonly risk?: RiskAssessment };

/** Phase 4 creates an execution intent only; broker submission is implemented and validated separately. */
export function prepareExecutionIntent(input: {
  readonly id: ExecutionIntentId;
  readonly idempotencyKey: IdempotencyKey;
  readonly opportunityId: OpportunityId;
  readonly decisionId: import("../domain/types.js").DecisionId;
  readonly environment: "DEMO" | "LIVE";
  readonly settings: RiskSettings;
  readonly trade: RiskTradeRequest;
  readonly spec: BrokerSymbolSpec;
  readonly now: string;
}): ExecutionPreparation {
  const risk = assessTradeRisk(input.settings, input.trade, input.spec);
  if (!risk.accepted) return { accepted: false, reason: "RISK_REJECTED", risk };
  return {
    accepted: true,
    intent: {
      id: input.id, idempotencyKey: input.idempotencyKey, opportunityId: input.opportunityId, decisionId: input.decisionId,
      environment: input.environment, symbol: "XAUUSD", direction: input.trade.direction, volume: risk.volume,
      stopLoss: input.trade.stopLoss, takeProfit: input.trade.takeProfit, createdAt: input.now
    }
  };
}
