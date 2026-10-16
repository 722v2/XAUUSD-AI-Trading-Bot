export interface RuntimeConfig {
  readonly appName: "XAUUSD-AI-Trading-Bot";
  readonly scannerIntervalSeconds: 60;
  readonly defaultSymbol: "XAUUSD";
  readonly defaultEnvironment: "DEMO";
  readonly uiLocale: "ar";
  readonly uiDirection: "rtl";
  readonly liveTradingEnabled: false;
  readonly scannerEnabled: boolean;
  readonly aiProviderId: string | null;
  readonly aiModelId: string | null;
}
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = Object.freeze({
  appName: "XAUUSD-AI-Trading-Bot", scannerIntervalSeconds: 60, defaultSymbol: "XAUUSD",
  defaultEnvironment: "DEMO", uiLocale: "ar", uiDirection: "rtl", liveTradingEnabled: false,
  scannerEnabled: false, aiProviderId: null, aiModelId: null
});
export type MutableRuntimeConfigKey = "scannerEnabled" | "aiProviderId" | "aiModelId";
export interface RuntimeConfigSnapshot { readonly version: number; readonly config: RuntimeConfig; }
export type ConfigUpdateError = "INVALID_VALUE" | "VERSION_CONFLICT";
export type ConfigUpdateResult = { readonly ok: true; readonly snapshot: RuntimeConfigSnapshot } | { readonly ok: false; readonly error: ConfigUpdateError };
/** In-memory, versioned Phase 1 store. Durable history is added in Phase 6. */
export class RuntimeConfigStore {
  #version = 1;
  #config: RuntimeConfig;
  constructor(initial: RuntimeConfig = DEFAULT_RUNTIME_CONFIG) { this.#config = Object.freeze({ ...initial }); }
  getSnapshot(): RuntimeConfigSnapshot { return Object.freeze({ version: this.#version, config: this.#config }); }
  update<K extends MutableRuntimeConfigKey>(key: K, value: RuntimeConfig[K], expectedVersion: number): ConfigUpdateResult {
    if (expectedVersion !== this.#version) return { ok: false, error: "VERSION_CONFLICT" };
    if (key === "scannerEnabled" && typeof value !== "boolean") return { ok: false, error: "INVALID_VALUE" };
    if ((key === "aiProviderId" || key === "aiModelId") && value !== null && (typeof value !== "string" || value.trim().length === 0)) return { ok: false, error: "INVALID_VALUE" };
    this.#config = Object.freeze({ ...this.#config, [key]: value });
    this.#version += 1;
    return { ok: true, snapshot: this.getSnapshot() };
  }
}
