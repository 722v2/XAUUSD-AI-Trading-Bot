/** Canonical domain vocabulary. Keep analysis, decisions, risk, and execution distinct. */
export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type ISODateTime = Brand<string, "ISODateTime">;
export type OpportunityId = Brand<string, "OpportunityId">;
export type ExecutionIntentId = Brand<string, "ExecutionIntentId">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
export const TIMEFRAMES = ["M1", "M5", "M15", "H1"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export type EnvironmentMode = "DEMO" | "LIVE";
export type Direction = "BUY" | "SELL";
export type AnalysisOutcome = "BUY" | "SELL" | "WAIT" | "REJECT";
export type OpportunityStatus = "DETECTED" | "ANALYZING" | "AI_PENDING" | "DECIDED" | "RISK_CHECK" | "EXECUTION_PENDING" | "OPEN" | "MANAGING" | "CLOSED" | "REJECTED" | "EXPIRED" | "CANCELLED" | "EXECUTION_FAILED" | "EXECUTION_UNKNOWN" | "RECONCILIATION_REQUIRED";
export type RiskMode = "PERCENT_OF_CAPITAL" | "FIXED_CASH";
export type AIConnectionState = "CONNECTED" | "DEGRADED" | "DISCONNECTED" | "NOT_CONFIGURED";
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export interface MarketQuote {
  readonly symbol: "XAUUSD";
  readonly bid: number;
  readonly ask: number;
  readonly tickTime: ISODateTime;
  readonly receivedAt: ISODateTime;
}
export interface Candle {
  readonly symbol: "XAUUSD";
  readonly timeframe: Timeframe;
  readonly openTime: ISODateTime;
  readonly closeTime: ISODateTime;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly tickVolume: number;
  readonly isClosed: boolean;
}
export interface RiskSettings {
  readonly mode: RiskMode;
  readonly riskPercent?: number;
  readonly riskCash?: number;
  readonly referenceCapital: number;
  readonly minimumRiskRewardRatio: number;
}
export interface TechnicalEvidence {
  readonly strategyId: string;
  readonly direction: Direction;
  readonly evidenceCodes: readonly string[];
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly createdAt: ISODateTime;
  readonly expiresAt: ISODateTime;
}
export interface AIAssessment {
  readonly providerId: string;
  readonly modelId: string;
  readonly outcome: AnalysisOutcome;
  readonly rationaleCodes: readonly string[];
  readonly rationale: string;
  readonly assessedAt: ISODateTime;
  readonly expiresAt: ISODateTime;
}
export interface TradeDecision {
  readonly opportunityId: OpportunityId;
  readonly outcome: AnalysisOutcome;
  readonly reasonCodes: readonly string[];
  readonly decidedAt: ISODateTime;
  readonly expiresAt: ISODateTime;
  readonly technicalDirection?: Direction;
  readonly aiOutcome?: AnalysisOutcome;
}
export interface ExecutionIntent {
  readonly id: ExecutionIntentId;
  readonly idempotencyKey: IdempotencyKey;
  readonly opportunityId: OpportunityId;
  readonly environment: EnvironmentMode;
  readonly symbol: "XAUUSD";
  readonly direction: Direction;
  readonly volume: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly createdAt: ISODateTime;
}
export interface AIHealth {
  readonly state: AIConnectionState;
  readonly checkedAt: ISODateTime;
  readonly lastSuccessAt?: ISODateTime;
  readonly reasonCode?: string;
}
