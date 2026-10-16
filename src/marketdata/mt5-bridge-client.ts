import type { Candle, ExecutionIntent, Timeframe } from "../domain/types.js";
import type { RawCandle } from "./normalize.js";

export type MT5BridgeErrorCode = "NOT_CONFIGURED" | "UNAUTHORIZED" | "UNAVAILABLE" | "INVALID_RESPONSE" | "BROKER_REJECTED" | "RECONCILIATION_REQUIRED";
export interface MT5BridgeHealth {
  readonly state: "CONNECTED" | "DISCONNECTED" | "NOT_CONFIGURED" | "BLOCKED";
  readonly reason: string;
  readonly environment: "DEMO" | "BLOCKED";
  readonly liveTradingEnabled: false;
  readonly accountLogin?: string;
  readonly executionReady?: boolean;
}
export type BridgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly errorCode: MT5BridgeErrorCode; readonly message: string };
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Authenticated client for the local Python bridge; intended for server-side use only. */
export class MT5BridgeClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  constructor(config: { readonly baseUrl: string; readonly token: string; readonly timeoutMs?: number }, fetchImpl: FetchLike = fetch) {
    let url: URL;
    try { url = new URL(config.baseUrl); } catch { throw new Error("MT5 bridge URL is invalid"); }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "::1") {
      throw new Error("MT5 bridge must use HTTPS outside localhost");
    }
    if (!config.token.trim()) throw new Error("MT5 bridge authentication token is required");
    this.#baseUrl = url.toString().replace(/\/$/, "");
    this.#token = config.token;
    this.#timeoutMs = config.timeoutMs ?? 2500;
    this.#fetch = fetchImpl;
  }
  async #request<T>(path: string, init: RequestInit = {}): Promise<BridgeResult<T>> {
    let response: Response;
    try {
      response = await this.#fetch(this.#baseUrl + path, {
        ...init,
        headers: { "content-type": "application/json", "X-Bridge-Token": this.#token, ...((init.headers ?? {}) as Record<string,string>) },
        signal: AbortSignal.timeout(this.#timeoutMs)
      });
    } catch {
      return { ok: false, status: 0, errorCode: "UNAVAILABLE", message: "MT5 bridge request failed or timed out" };
    }
    let body: unknown;
    try { body = await response.json(); } catch { return { ok: false, status: response.status, errorCode: "INVALID_RESPONSE", message: "MT5 bridge returned invalid JSON" }; }
    if (!response.ok) {
      const error = isRecord(body) && typeof body.error === "string" ? body.error : "BRIDGE_ERROR";
      const code: MT5BridgeErrorCode = response.status === 401 ? "UNAUTHORIZED" : response.status === 202 || response.status === 409 ? "RECONCILIATION_REQUIRED" : response.status >= 500 ? "UNAVAILABLE" : "BROKER_REJECTED";
      return { ok: false, status: response.status, errorCode: code, message: error };
    }
    return { ok: true, value: body as T };
  }
  health(): Promise<BridgeResult<MT5BridgeHealth>> { return this.#request("/health"); }
  quote(): Promise<BridgeResult<{ readonly symbol: "XAUUSD"; readonly bid: number; readonly ask: number; readonly tickTime: string; readonly receivedAt: string }>> {
    return this.#request("/market/quote");
  }
  symbolSpec(): Promise<BridgeResult<{ readonly symbol: "XAUUSD"; readonly tickSize: number; readonly tickValuePerLot: number; readonly volumeMin: number; readonly volumeMax: number; readonly volumeStep: number; readonly priceDigits: number; readonly point: number; readonly stopsLevelPoints: number }>> {
    return this.#request("/market/spec");
  }
  candles(timeframe: Timeframe, count = 100): Promise<BridgeResult<{ readonly symbol: "XAUUSD"; readonly timeframe: Timeframe; readonly candles: readonly RawCandle[] }>> {
    return this.#request(`/market/candles?timeframe=${encodeURIComponent(timeframe)}&count=${count}`);
  }
  submitDemoOrder(input: {
    readonly intent: ExecutionIntent;
  }): Promise<BridgeResult<{ readonly state: "CONFIRMED" | "REJECTED" | "RECONCILIATION_REQUIRED"; readonly brokerOrderId?: string; readonly error?: string }>> {
    if (input.intent.environment !== "DEMO") {
      return Promise.resolve({ ok: false, status: 403, errorCode: "BROKER_REJECTED", message: "LIVE_DISABLED" });
    }
    return this.#request("/orders", {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: input.intent.idempotencyKey, environment: "DEMO", symbol: "XAUUSD",
        direction: input.intent.direction, volume: input.intent.volume,
        stopLoss: input.intent.stopLoss, takeProfit: input.intent.takeProfit
      })
    });
  }
  positions(): Promise<BridgeResult<{ readonly environment: "DEMO"; readonly accountLogin?: string; readonly positions: readonly { readonly ticket: number; readonly symbol: "XAUUSD"; readonly direction: "BUY" | "SELL"; readonly volume: number; readonly entryPrice: number; readonly stopLoss: number; readonly takeProfit: number; readonly profit: number; readonly openedAt: string; readonly comment: string }[] }>> {
    return this.#request("/positions");
  }
  modifyPosition(input: { readonly ticket: number; readonly stopLoss?: number; readonly takeProfit?: number }): Promise<BridgeResult<{ readonly state: "CONFIRMED" | "REJECTED" | "RECONCILIATION_REQUIRED"; readonly ticket?: number }>> {
    return this.#request("/positions/modify", { method: "POST", body: JSON.stringify(input) });
  }
  closePosition(input: { readonly ticket: number; readonly idempotencyKey: string }): Promise<BridgeResult<{ readonly state: "CONFIRMED" | "REJECTED" | "RECONCILIATION_REQUIRED"; readonly ticket?: number; readonly brokerOrderId?: string }>> {
    return this.#request("/positions/close", { method: "POST", body: JSON.stringify(input) });
  }
  lookupOrder(idempotencyKey: string): Promise<BridgeResult<{ readonly state: string; readonly brokerOrderId?: string }>> {
    return this.#request(`/orders/lookup?idempotencyKey=${encodeURIComponent(idempotencyKey)}`);
  }
}
