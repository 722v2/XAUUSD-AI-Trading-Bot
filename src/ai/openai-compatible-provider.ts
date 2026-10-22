import type { AIAssessment, AnalysisOutcome, TechnicalEvidence } from "../domain/types.js";

export interface AIProviderConfig {
  readonly providerId: string;
  readonly modelId: string;
  /** OpenAI-compatible endpoint base URL. Must be configured server-side. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly assessmentTtlMs?: number;
}
export interface AIAssessmentInput {
  readonly symbol: "XAUUSD";
  readonly evidence: readonly TechnicalEvidence[];
  readonly now: string;
  /** Optional recent closed M1 candles; caller must exclude forming/future bars. */
  readonly marketContext?: { readonly recentClosedM1: readonly { readonly time: string; readonly open: number; readonly high: number; readonly low: number; readonly close: number }[] };
}
export type AIProviderErrorCode = "NOT_CONFIGURED" | "INVALID_CONFIG" | "TIMEOUT" | "HTTP_ERROR" | "INVALID_RESPONSE" | "PROVIDER_ERROR";
export class AIProviderError extends Error {
  readonly code: AIProviderErrorCode;
  constructor(code: AIProviderErrorCode, message: string) { super(message); this.name = "AIProviderError"; this.code = code; }
}
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function outcome(value: unknown): value is AnalysisOutcome {
  return value === "BUY" || value === "SELL" || value === "WAIT" || value === "REJECT";
}
function safeRationale(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1200);
}
function safeCodes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string" && /^[A-Z0-9_:-]{1,64}$/.test(x)).slice(0, 16);
}
function parseJsonContent(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** OpenAI-compatible adapter. API keys are used only in server-side request headers and never returned. */
export class OpenAICompatibleAIProvider {
  readonly #config: AIProviderConfig;
  readonly #fetch: FetchLike;
  constructor(config: AIProviderConfig, fetchImpl: FetchLike = fetch) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  async assess(input: AIAssessmentInput): Promise<AIAssessment> {
    const { providerId, modelId, baseUrl, apiKey } = this.#config;
    if (!apiKey?.trim()) throw new AIProviderError("NOT_CONFIGURED", "AI provider credentials are not configured");
    let endpoint: URL;
    try { endpoint = new URL(baseUrl); } catch { throw new AIProviderError("INVALID_CONFIG", "AI provider URL is invalid"); }
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
      throw new AIProviderError("INVALID_CONFIG", "AI provider must use HTTPS outside localhost");
    }
    if (!providerId.trim() || !modelId.trim() || !Number.isFinite(Date.parse(input.now)) || !Number.isInteger(this.#config.timeoutMs ?? 30_000) || (this.#config.timeoutMs ?? 30_000) < 1_000 || (this.#config.timeoutMs ?? 30_000) > 45_000) {
      throw new AIProviderError("INVALID_CONFIG", "AI provider configuration or timestamp is invalid");
    }
    endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + (endpoint.pathname.endsWith("/chat/completions") ? "" : "/chat/completions");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        headers: { "authorization": `Bearer ${apiKey}`, "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: modelId,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "You are a trading research analyst, not an execution system. Assess only the supplied closed-bar technical evidence and optional recent closed M1 candle context. Use candle context to check structure and avoid chasing late moves; never treat it as permission to override risk rules. Return one JSON object with outcome BUY|SELL|WAIT|REJECT, rationale, and rationaleCodes (array of uppercase codes). Never invent market data, prices, indicators, or a trade. If evidence is weak or contradictory, return WAIT. This is not permission to execute an order." },
            { role: "user", content: JSON.stringify({ symbol: input.symbol, asOf: input.now, evidence: input.evidence, marketContext: input.marketContext }) }
          ]
        })
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof Error && error.name === "AbortError") throw new AIProviderError("TIMEOUT", "AI provider request timed out");
      throw new AIProviderError("PROVIDER_ERROR", "AI provider request failed");
    }
    if (!response.ok) {
      clearTimeout(timeout);
      throw new AIProviderError("HTTP_ERROR", `AI provider returned HTTP ${response.status}`);
    }
    let body: unknown;
    try { body = await response.json(); } catch (error) { clearTimeout(timeout); if (error instanceof Error && error.name === "AbortError") throw new AIProviderError("TIMEOUT", "AI provider response body timed out"); throw new AIProviderError("INVALID_RESPONSE", "AI provider returned invalid JSON"); }
    clearTimeout(timeout);
    const choices = typeof body === "object" && body !== null ? (body as { choices?: unknown }).choices : undefined;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const message = typeof first === "object" && first !== null ? (first as { message?: { content?: unknown } }).message : undefined;
    const parsed = parseJsonContent(message?.content);
    if (!parsed || !outcome(parsed.outcome)) throw new AIProviderError("INVALID_RESPONSE", "AI provider response did not match the assessment contract");
    const rationale = safeRationale(parsed.rationale);
    if (!rationale) throw new AIProviderError("INVALID_RESPONSE", "AI provider response omitted a rationale");
    const nowMs = Date.parse(input.now);
    const ttl = this.#config.assessmentTtlMs ?? 60_000;
    if (!Number.isFinite(ttl) || ttl <= 0) throw new AIProviderError("INVALID_CONFIG", "AI assessment TTL is invalid");
    return {
      providerId, modelId, outcome: parsed.outcome, rationaleCodes: safeCodes(parsed.rationaleCodes),
      rationale, assessedAt: new Date(nowMs).toISOString() as AIAssessment["assessedAt"],
      expiresAt: new Date(nowMs + ttl).toISOString() as AIAssessment["expiresAt"]
    };
  }
}

export type CoordinatedDecision =
  | { readonly outcome: "BUY" | "SELL"; readonly reasonCodes: readonly string[]; readonly direction: "BUY" | "SELL" }
  | { readonly outcome: "WAIT" | "REJECT"; readonly reasonCodes: readonly string[] };

export function coordinateTechnicalAndAI(evidence: readonly TechnicalEvidence[], ai: AIAssessment): CoordinatedDecision {
  if (evidence.length === 0) return { outcome: "REJECT", reasonCodes: ["NO_TECHNICAL_EVIDENCE"] };
  const directions = new Set(evidence.map(item => item.direction));
  if (directions.size !== 1) return { outcome: "WAIT", reasonCodes: ["TECHNICAL_DIRECTION_CONFLICT"] };
  const technicalDirection = evidence[0]!.direction;
  if (ai.outcome === "WAIT") return { outcome: "WAIT", reasonCodes: ["AI_WAIT", ...ai.rationaleCodes] };
  if (ai.outcome === "REJECT") return { outcome: "REJECT", reasonCodes: ["AI_REJECT", ...ai.rationaleCodes] };
  if (ai.outcome !== technicalDirection) return { outcome: "WAIT", reasonCodes: ["AI_TECHNICAL_DIRECTION_CONFLICT"] };
  return { outcome: technicalDirection, direction: technicalDirection, reasonCodes: ["AI_TECHNICAL_ALIGNMENT", ...ai.rationaleCodes] };
}
