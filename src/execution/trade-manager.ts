import type { Direction } from "../domain/types.js";

export interface ManagedPositionInput {
  readonly ticket: number;
  readonly direction: Direction;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
}
export interface TradeManagementPolicy {
  readonly breakEvenAtR: number;
  readonly trailingStartsAtR: number;
  readonly trailingAtrMultiplier: number;
  readonly priceDigits: number;
  readonly tickSize: number;
  readonly minimumStopDistance: number;
}
export type TradeManagementResult =
  | { readonly action: "NO_ACTION"; readonly reason: "INVALID_POSITION" | "ATR_UNAVAILABLE" | "NOT_PROFITABLE_ENOUGH" | "STOP_NOT_TIGHTER" | "STOP_TOO_CLOSE" }
  | { readonly action: "MODIFY_STOP"; readonly reason: "BREAK_EVEN" | "ATR_TRAILING"; readonly ticket: number; readonly stopLoss: number; readonly takeProfit: number };

/**
 * Deterministic Demo position protection. Never loosens a stop and never changes TP.
 * At 1R it moves SL to entry; at 1.5R it trails at a configurable ATR distance.
 */
export function managePositionStop(
  position: ManagedPositionInput,
  currentPrice: number,
  atrValue: number,
  policy: TradeManagementPolicy
): TradeManagementResult {
  const numbers = [position.entryPrice, position.stopLoss, position.takeProfit, currentPrice, atrValue, policy.tickSize, policy.minimumStopDistance];
  if (!Number.isInteger(position.ticket) || numbers.some(value => !Number.isFinite(value)) ||
      position.entryPrice <= 0 || position.stopLoss <= 0 || position.takeProfit <= 0 ||
      currentPrice <= 0 || policy.tickSize <= 0 || policy.minimumStopDistance < 0 ||
      !Number.isInteger(policy.priceDigits) || policy.priceDigits < 0 || policy.priceDigits > 10 ||
      policy.breakEvenAtR <= 0 || policy.trailingStartsAtR < policy.breakEvenAtR || policy.trailingAtrMultiplier <= 0) {
    return { action: "NO_ACTION", reason: "INVALID_POSITION" };
  }
  if (!Number.isFinite(atrValue) || atrValue <= 0) return { action: "NO_ACTION", reason: "ATR_UNAVAILABLE" };
  const risk = position.direction === "BUY" ? position.entryPrice - position.stopLoss : position.stopLoss - position.entryPrice;
  if (risk <= 0) return { action: "NO_ACTION", reason: "INVALID_POSITION" };
  const favorable = position.direction === "BUY" ? currentPrice - position.entryPrice : position.entryPrice - currentPrice;
  const rMultiple = favorable / risk;
  if (rMultiple < policy.breakEvenAtR) return { action: "NO_ACTION", reason: "NOT_PROFITABLE_ENOUGH" };

  let desiredStop = position.entryPrice;
  let reason: "BREAK_EVEN" | "ATR_TRAILING" = "BREAK_EVEN";
  if (rMultiple >= policy.trailingStartsAtR) {
    const trailing = position.direction === "BUY"
      ? currentPrice - atrValue * policy.trailingAtrMultiplier
      : currentPrice + atrValue * policy.trailingAtrMultiplier;
    desiredStop = position.direction === "BUY" ? Math.max(position.entryPrice, trailing) : Math.min(position.entryPrice, trailing);
    reason = "ATR_TRAILING";
  }
  desiredStop = Number(desiredStop.toFixed(policy.priceDigits));
  const tighter = position.direction === "BUY"
    ? desiredStop > position.stopLoss + policy.tickSize / 2
    : desiredStop < position.stopLoss - policy.tickSize / 2;
  if (!tighter) return { action: "NO_ACTION", reason: "STOP_NOT_TIGHTER" };
  const distance = position.direction === "BUY" ? currentPrice - desiredStop : desiredStop - currentPrice;
  if (distance < policy.minimumStopDistance) return { action: "NO_ACTION", reason: "STOP_TOO_CLOSE" };
  return { action: "MODIFY_STOP", reason, ticket: position.ticket, stopLoss: desiredStop, takeProfit: position.takeProfit };
}
