import type { ExecutionIntent, ExecutionIntentId, IdempotencyKey } from "../domain/types.js";
import type { ExecutionIntentRepository, PersistResult, RuntimeSettingsRepository } from "./contracts.js";

export interface SupabaseRestConfig {
  readonly projectUrl: string;
  readonly serviceRoleKey: string;
}
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
interface IntentRow {
  id: string; idempotency_key: string; candidate_id: string; decision_id: string; environment: "DEMO" | "LIVE";
  symbol: "XAUUSD"; direction: "BUY" | "SELL"; volume: number; stop_loss: number; take_profit: number; created_at: string;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function toIntent(row: IntentRow): ExecutionIntent {
  return {
    id: row.id as ExecutionIntentId, idempotencyKey: row.idempotency_key as IdempotencyKey,
    opportunityId: row.candidate_id as ExecutionIntent["opportunityId"], decisionId: row.decision_id as ExecutionIntent["decisionId"],
    environment: row.environment, symbol: row.symbol, direction: row.direction, volume: Number(row.volume),
    stopLoss: Number(row.stop_loss), takeProfit: Number(row.take_profit), createdAt: row.created_at as ExecutionIntent["createdAt"]
  };
}

/** Server-only Supabase REST adapters. Never instantiate with a browser-visible anon key. */
export class SupabaseRestRepository implements ExecutionIntentRepository, RuntimeSettingsRepository {
  readonly #base: string;
  readonly #key: string;
  readonly #fetch: FetchLike;
  constructor(config: SupabaseRestConfig, fetchImpl: FetchLike = fetch) {
    let url: URL;
    try { url = new URL(config.projectUrl); } catch { throw new Error("Invalid Supabase project URL"); }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new Error("Supabase must use HTTPS outside localhost");
    if (!config.serviceRoleKey.trim()) throw new Error("Supabase server credential is not configured");
    this.#base = url.toString().replace(/\/$/, "") + "/rest/v1";
    this.#key = config.serviceRoleKey;
    this.#fetch = fetchImpl;
  }
  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.#key, authorization: `Bearer ${this.#key}`, "content-type": "application/json", ...extra };
  }
  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    try { return await this.#fetch(this.#base + path, { ...init, headers: this.#headers((init.headers ?? {}) as Record<string, string>) }); }
    catch { throw new Error("Supabase storage request failed"); }
  }
  async findById(id: ExecutionIntentId): Promise<ExecutionIntent | null> {
    if (!isUuid(id)) return null;
    const response = await this.#request(`/execution_intents?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!response.ok) throw new Error("Supabase intent lookup failed");
    const data: unknown = await response.json();
    if (!Array.isArray(data) || !data[0] || !isRecord(data[0])) return null;
    return toIntent(data[0] as unknown as IntentRow);
  }
  async findByIdempotencyKey(key: IdempotencyKey): Promise<ExecutionIntent | null> {
    const response = await this.#request(`/execution_intents?idempotency_key=eq.${encodeURIComponent(key)}&select=*`);
    if (!response.ok) throw new Error("Supabase idempotency lookup failed");
    const data: unknown = await response.json();
    if (!Array.isArray(data) || !data[0] || !isRecord(data[0])) return null;
    return toIntent(data[0] as unknown as IntentRow);
  }
  async createIfAbsent(intent: ExecutionIntent): Promise<PersistResult<{ readonly created: boolean; readonly intent: ExecutionIntent }>> {
    if (!isUuid(intent.id) || !isUuid(intent.opportunityId) || !isUuid(intent.decisionId) ||
        !Number.isFinite(intent.volume) || intent.volume <= 0 || !Number.isFinite(Date.parse(intent.createdAt))) {
      return { ok: false, errorCode: "UNKNOWN" };
    }
    const payload = {
      id: intent.id, idempotency_key: intent.idempotencyKey, candidate_id: intent.opportunityId,
      decision_id: intent.decisionId, environment: intent.environment, symbol: intent.symbol,
      direction: intent.direction, volume: intent.volume, stop_loss: intent.stopLoss, take_profit: intent.takeProfit,
      status: "CREATED", created_at: intent.createdAt
    };
    let response: Response;
    try {
      response = await this.#request("/execution_intents?on_conflict=idempotency_key", {
        method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(payload)
      });
    } catch { return { ok: false, errorCode: "STORAGE_UNAVAILABLE" }; }
    if (!response.ok) {
      if (response.status === 409) {
        const existing = await this.findByIdempotencyKey(intent.idempotencyKey).catch(() => null);
        if (existing) return { ok: true, value: { created: false, intent: existing } };
        return { ok: false, errorCode: "ALREADY_EXISTS" };
      }
      return { ok: false, errorCode: response.status >= 500 ? "STORAGE_UNAVAILABLE" : "UNKNOWN" };
    }
    let data: unknown;
    try { data = await response.json(); } catch { return { ok: false, errorCode: "UNKNOWN" }; }
    if (Array.isArray(data) && data[0] && isRecord(data[0])) {
      return { ok: true, value: { created: true, intent: toIntent(data[0] as unknown as IntentRow) } };
    }
    const existing = await this.findByIdempotencyKey(intent.idempotencyKey).catch(() => null);
    if (existing) return { ok: true, value: { created: false, intent: existing } };
    return { ok: false, errorCode: "UNKNOWN" };
  }
  async insertRecord(
    table: "scanner_runs" | "strategy_candidates" | "ai_assessments" | "trade_decisions" | "broker_orders" | "trade_events" | "audit_events",
    payload: Readonly<Record<string, unknown>>
  ): Promise<PersistResult<Readonly<Record<string, unknown>>>> {
    const response = await this.#request("/" + table, {
      method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(payload)
    }).catch(() => null);
    if (!response) return { ok: false, errorCode: "STORAGE_UNAVAILABLE" };
    if (!response.ok) return { ok: false, errorCode: response.status === 409 ? "ALREADY_EXISTS" : response.status >= 500 ? "STORAGE_UNAVAILABLE" : "UNKNOWN" };
    let data: unknown;
    try { data = await response.json(); } catch { return { ok: false, errorCode: "UNKNOWN" }; }
    if (!Array.isArray(data) || !data[0] || !isRecord(data[0])) return { ok: false, errorCode: "UNKNOWN" };
    return { ok: true, value: Object.freeze({ ...data[0] }) };
  }
  async findCandidateByKey(key: string): Promise<Readonly<Record<string, unknown>> | null> {
    const response = await this.#request(`/strategy_candidates?candidate_key=eq.${encodeURIComponent(key)}&select=*`);
    if (!response.ok) throw new Error("Supabase candidate lookup failed");
    const data: unknown = await response.json();
    if (!Array.isArray(data) || !data[0] || !isRecord(data[0])) return null;
    return Object.freeze({ ...data[0] });
  }
  async updateRecord(
    table: "scanner_runs" | "strategy_candidates" | "execution_intents",
    id: string,
    payload: Readonly<Record<string, unknown>>
  ): Promise<PersistResult<{ readonly updated: boolean }>> {
    if (!isUuid(id)) return { ok: false, errorCode: "UNKNOWN" };
    const response = await this.#request(`/${table}?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(payload)
    }).catch(() => null);
    if (!response) return { ok: false, errorCode: "STORAGE_UNAVAILABLE" };
    if (!response.ok) return { ok: false, errorCode: response.status >= 500 ? "STORAGE_UNAVAILABLE" : "UNKNOWN" };
    let data: unknown;
    try { data = await response.json(); } catch { return { ok: false, errorCode: "UNKNOWN" }; }
    return { ok: true, value: { updated: Array.isArray(data) && data.length > 0 } };
  }
  async updateExecutionIntentStatus(
    id: ExecutionIntentId,
    status: "SUBMITTED" | "CONFIRMED" | "REJECTED" | "UNKNOWN" | "RECONCILIATION_REQUIRED" | "CANCELLED"
  ): Promise<PersistResult<{ readonly updated: boolean }>> {
    if (!isUuid(id)) return { ok: false, errorCode: "UNKNOWN" };
    const response = await this.#request(`/execution_intents?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() })
    }).catch(() => null);
    if (!response) return { ok: false, errorCode: "STORAGE_UNAVAILABLE" };
    if (!response.ok) return { ok: false, errorCode: response.status >= 500 ? "STORAGE_UNAVAILABLE" : "UNKNOWN" };
    let data: unknown;
    try { data = await response.json(); } catch { return { ok: false, errorCode: "UNKNOWN" }; }
    return { ok: true, value: { updated: Array.isArray(data) && data.length > 0 } };
  }
  async readCurrent(): Promise<Readonly<Record<string, unknown>>> {
    const response = await this.#request("/app_settings?setting_key=eq.runtime_config&select=setting_value,version");
    if (!response.ok) throw new Error("Supabase runtime settings read failed");
    const data: unknown = await response.json();
    if (!Array.isArray(data) || !data[0] || !isRecord(data[0]) || !isRecord(data[0].setting_value)) return {};
    return Object.freeze({ ...(data[0].setting_value as Record<string, unknown>), _version: data[0].version });
  }
  async writeVersioned(settings: Readonly<Record<string, unknown>>, expectedVersion: number): Promise<PersistResult<{ readonly version: number }>> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return { ok: false, errorCode: "UNKNOWN" };
    let response: Response;
    try {
      response = await this.#request("/rpc/write_runtime_settings", {
        method: "POST", body: JSON.stringify({ p_settings: settings, p_expected_version: expectedVersion }),
        headers: { Prefer: "return=representation" }
      });
    } catch { return { ok: false, errorCode: "STORAGE_UNAVAILABLE" }; }
    if (!response.ok) return { ok: false, errorCode: response.status >= 500 ? "STORAGE_UNAVAILABLE" : "UNKNOWN" };
    let data: unknown;
    try { data = await response.json(); } catch { return { ok: false, errorCode: "UNKNOWN" }; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!isRecord(row) || typeof row.version !== "number") return { ok: false, errorCode: "ALREADY_EXISTS" };
    return { ok: true, value: { version: row.version } };
  }
}
