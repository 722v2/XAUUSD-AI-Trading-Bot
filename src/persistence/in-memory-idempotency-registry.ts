import type { IdempotencyKey } from "../domain/types.js";
/** Test/Phase 1 helper only. Not suitable for live or durable execution. */
export class InMemoryIdempotencyRegistry {
  readonly #keys = new Set<string>();
  claim(key: IdempotencyKey): boolean { if (this.#keys.has(key)) return false; this.#keys.add(key); return true; }
  has(key: IdempotencyKey): boolean { return this.#keys.has(key); }
}
