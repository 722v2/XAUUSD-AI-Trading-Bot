import type { ExecutionIntent, ExecutionIntentId, IdempotencyKey } from "../domain/types.js";
export type PersistResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errorCode: "ALREADY_EXISTS" | "STORAGE_UNAVAILABLE" | "UNKNOWN" };
/** Implementations must enforce idempotency atomically at the storage layer. */
export interface ExecutionIntentRepository {
  createIfAbsent(intent: ExecutionIntent): Promise<PersistResult<{ readonly created: boolean; readonly intent: ExecutionIntent }>>;
  findById(id: ExecutionIntentId): Promise<ExecutionIntent | null>;
  findByIdempotencyKey(key: IdempotencyKey): Promise<ExecutionIntent | null>;
}
export interface RuntimeSettingsRepository {
  readCurrent(): Promise<Readonly<Record<string, unknown>>>;
  writeVersioned(settings: Readonly<Record<string, unknown>>, expectedVersion: number): Promise<PersistResult<{ readonly version: number }>>;
}
