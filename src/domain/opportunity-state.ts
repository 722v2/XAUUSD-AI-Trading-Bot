import type { OpportunityStatus } from "./types.js";
const TRANSITIONS: Readonly<Record<OpportunityStatus, readonly OpportunityStatus[]>> = {
  DETECTED: ["ANALYZING", "REJECTED", "EXPIRED", "CANCELLED"],
  ANALYZING: ["AI_PENDING", "DECIDED", "REJECTED", "EXPIRED", "CANCELLED"],
  AI_PENDING: ["DECIDED", "REJECTED", "EXPIRED", "CANCELLED"],
  DECIDED: ["RISK_CHECK", "REJECTED", "EXPIRED", "CANCELLED"],
  RISK_CHECK: ["EXECUTION_PENDING", "REJECTED", "EXPIRED", "CANCELLED"],
  EXECUTION_PENDING: ["OPEN", "EXECUTION_FAILED", "EXECUTION_UNKNOWN", "RECONCILIATION_REQUIRED", "CANCELLED"],
  OPEN: ["MANAGING", "CLOSED", "RECONCILIATION_REQUIRED"],
  MANAGING: ["CLOSED", "RECONCILIATION_REQUIRED"],
  CLOSED: [], REJECTED: [], EXPIRED: [], CANCELLED: [],
  EXECUTION_FAILED: ["RECONCILIATION_REQUIRED"],
  EXECUTION_UNKNOWN: ["OPEN", "EXECUTION_FAILED", "RECONCILIATION_REQUIRED"],
  RECONCILIATION_REQUIRED: ["OPEN", "CLOSED", "EXECUTION_FAILED", "EXECUTION_UNKNOWN"]
};
export function canTransitionOpportunity(from: OpportunityStatus, to: OpportunityStatus): boolean { return TRANSITIONS[from].includes(to); }
export function transitionOpportunity(from: OpportunityStatus, to: OpportunityStatus): OpportunityStatus {
  if (!canTransitionOpportunity(from, to)) throw new Error(`Invalid opportunity transition: ${from} -> ${to}`);
  return to;
}
export function allowedOpportunityTransitions(from: OpportunityStatus): readonly OpportunityStatus[] { return TRANSITIONS[from]; }
