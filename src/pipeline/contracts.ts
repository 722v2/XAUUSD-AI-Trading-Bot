import type { AIAssessment, TechnicalEvidence, TradeDecision } from "../domain/types.js";
export interface AnalysisContext {
  readonly correlationId: string;
  readonly symbol: "XAUUSD";
  readonly marketDataValid: boolean;
  readonly technicalEvidence: readonly TechnicalEvidence[];
}
export interface TechnicalAnalysisPort { analyze(context: AnalysisContext): Promise<readonly TechnicalEvidence[]>; }
export interface AIDecisionPort { assess(context: AnalysisContext): Promise<AIAssessment>; }
export interface DecisionCoordinatorPort { decide(context: AnalysisContext, evidence: readonly TechnicalEvidence[], ai: AIAssessment): TradeDecision; }
export type PipelineStage = "DATA_VALIDATION" | "TECHNICAL_ANALYSIS" | "AI_ASSESSMENT" | "DECISION" | "RISK" | "EXECUTION";
export type PipelineUnavailableReason = "PHASE_NOT_IMPLEMENTED" | "INVALID_MARKET_DATA" | "AI_UNAVAILABLE";
export interface PipelineResult { readonly status: "NOT_READY"; readonly failedStage: PipelineStage; readonly reason: PipelineUnavailableReason; readonly correlationId: string; }
export function createNotReadyPipelineResult(correlationId: string, failedStage: PipelineStage, reason: PipelineUnavailableReason): PipelineResult {
  return { status: "NOT_READY", failedStage, reason, correlationId };
}
