import type { RiskSettings } from "./types.js";
export type RiskSettingsValidationError = "INVALID_REFERENCE_CAPITAL" | "INVALID_MINIMUM_RR" | "INVALID_RISK_PERCENT" | "INVALID_RISK_CASH" | "UNEXPECTED_RISK_FIELD";
/** Validate user-entered values without imposing application-defined risk caps/floors. */
export function validateRiskSettings(input: RiskSettings): RiskSettingsValidationError | null {
  if (!Number.isFinite(input.referenceCapital) || input.referenceCapital <= 0) return "INVALID_REFERENCE_CAPITAL";
  if (!Number.isFinite(input.minimumRiskRewardRatio) || input.minimumRiskRewardRatio < 0) return "INVALID_MINIMUM_RR";
  if (input.mode === "PERCENT_OF_CAPITAL") {
    if (input.riskPercent === undefined || !Number.isFinite(input.riskPercent) || input.riskPercent <= 0) return "INVALID_RISK_PERCENT";
    if (input.riskCash !== undefined) return "UNEXPECTED_RISK_FIELD";
    return null;
  }
  if (input.riskCash === undefined || !Number.isFinite(input.riskCash) || input.riskCash <= 0) return "INVALID_RISK_CASH";
  if (input.riskPercent !== undefined) return "UNEXPECTED_RISK_FIELD";
  return null;
}
export function targetRiskAmount(input: RiskSettings): number {
  const validationError = validateRiskSettings(input);
  if (validationError !== null) throw new Error(`Invalid risk settings: ${validationError}`);
  return input.mode === "PERCENT_OF_CAPITAL" ? input.referenceCapital * (input.riskPercent as number) / 100 : (input.riskCash as number);
}
