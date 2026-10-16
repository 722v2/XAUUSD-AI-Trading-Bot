import type { OpportunityId, OpportunityStatus, TechnicalEvidence } from "../domain/types.js";
import { canTransitionOpportunity, transitionOpportunity } from "../domain/opportunity-state.js";

export interface OpportunityRecord {
  readonly id: OpportunityId;
  readonly dedupeKey: string;
  readonly evidence: TechnicalEvidence;
  readonly status: OpportunityStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly terminalReason?: string;
}
export interface OpportunityEvent {
  readonly opportunityId: OpportunityId;
  readonly from: OpportunityStatus | null;
  readonly to: OpportunityStatus;
  readonly at: string;
  readonly reasonCode: string;
}
export type RegisterOpportunityResult =
  | { readonly ok: true; readonly created: true; readonly opportunity: OpportunityRecord }
  | { readonly ok: true; readonly created: false; readonly opportunity: OpportunityRecord }
  | { readonly ok: false; readonly error: "INVALID_INPUT" | "EXPIRED_EVIDENCE" | "DUPLICATE_ID" };
export type TransitionOpportunityResult =
  | { readonly ok: true; readonly opportunity: OpportunityRecord }
  | { readonly ok: false; readonly error: "NOT_FOUND" | "INVALID_TRANSITION" | "VERSION_CONFLICT" | "EXPIRED_EVIDENCE" };

export class OpportunityLifecycleService {
  readonly #byId = new Map<string, OpportunityRecord>();
  readonly #idByDedupeKey = new Map<string, string>();
  readonly #events: OpportunityEvent[] = [];

  register(input: { id: OpportunityId; dedupeKey: string; evidence: TechnicalEvidence; now: string }): RegisterOpportunityResult {
    const nowMs = Date.parse(input.now);
    const expiresAt = Date.parse(input.evidence.expiresAt);
    if (!input.id || !input.dedupeKey.trim() || !Number.isFinite(nowMs) ||
        !Number.isFinite(Date.parse(input.evidence.createdAt)) || !Number.isFinite(expiresAt) ||
        !Number.isFinite(input.evidence.entryPrice) || !Number.isFinite(input.evidence.stopLoss) ||
        !Number.isFinite(input.evidence.takeProfit) || input.evidence.entryPrice <= 0 ||
        input.evidence.stopLoss <= 0 || input.evidence.takeProfit <= 0) {
      return { ok: false, error: "INVALID_INPUT" };
    }
    const existingId = this.#idByDedupeKey.get(input.dedupeKey);
    if (existingId) return { ok: true, created: false, opportunity: this.#byId.get(existingId)! };
    if (expiresAt <= nowMs) return { ok: false, error: "EXPIRED_EVIDENCE" };
    if (this.#byId.has(input.id)) return { ok: false, error: "DUPLICATE_ID" };
    const record: OpportunityRecord = Object.freeze({
      id: input.id, dedupeKey: input.dedupeKey, evidence: Object.freeze({ ...input.evidence }),
      status: "DETECTED", createdAt: input.now, updatedAt: input.now, version: 1
    });
    this.#byId.set(input.id, record);
    this.#idByDedupeKey.set(input.dedupeKey, input.id);
    this.#events.push({ opportunityId: input.id, from: null, to: "DETECTED", at: input.now, reasonCode: "CANDIDATE_REGISTERED" });
    return { ok: true, created: true, opportunity: record };
  }

  transition(input: { id: OpportunityId; to: OpportunityStatus; now: string; reasonCode: string; expectedVersion: number }): TransitionOpportunityResult {
    const current = this.#byId.get(input.id);
    if (!current) return { ok: false, error: "NOT_FOUND" };
    if (current.version !== input.expectedVersion) return { ok: false, error: "VERSION_CONFLICT" };
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs) || !input.reasonCode.trim()) return { ok: false, error: "INVALID_TRANSITION" };
    if (Date.parse(current.evidence.expiresAt) <= nowMs && !["EXPIRED", "REJECTED", "CANCELLED", "CLOSED", "EXECUTION_FAILED"].includes(input.to)) {
      return { ok: false, error: "EXPIRED_EVIDENCE" };
    }
    if (!canTransitionOpportunity(current.status, input.to)) return { ok: false, error: "INVALID_TRANSITION" };
    const status = transitionOpportunity(current.status, input.to);
    const updated: OpportunityRecord = Object.freeze({
      ...current, status, updatedAt: input.now, version: current.version + 1,
      ...(status === "REJECTED" || status === "EXPIRED" || status === "CANCELLED" || status === "EXECUTION_FAILED" ? { terminalReason: input.reasonCode } : {})
    });
    this.#byId.set(input.id, updated);
    this.#events.push({ opportunityId: input.id, from: current.status, to: status, at: input.now, reasonCode: input.reasonCode });
    return { ok: true, opportunity: updated };
  }

  expireDue(now: string): readonly OpportunityId[] {
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) return [];
    const expired: OpportunityId[] = [];
    for (const current of this.#byId.values()) {
      if (Date.parse(current.evidence.expiresAt) <= nowMs &&
          ["DETECTED", "ANALYZING", "AI_PENDING", "DECIDED", "RISK_CHECK"].includes(current.status)) {
        const updated: OpportunityRecord = Object.freeze({
          ...current, status: "EXPIRED", updatedAt: now, version: current.version + 1, terminalReason: "EVIDENCE_EXPIRED"
        });
        this.#byId.set(current.id, updated);
        this.#events.push({ opportunityId: current.id, from: current.status, to: "EXPIRED", at: now, reasonCode: "EVIDENCE_EXPIRED" });
        expired.push(current.id);
      }
    }
    return expired;
  }

  get(id: OpportunityId): OpportunityRecord | null { return this.#byId.get(id) ?? null; }
  list(): readonly OpportunityRecord[] { return [...this.#byId.values()]; }
  events(): readonly OpportunityEvent[] { return [...this.#events]; }
}
