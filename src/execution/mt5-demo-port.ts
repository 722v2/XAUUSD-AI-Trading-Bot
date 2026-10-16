import type { ExecutionIntent } from "../domain/types.js";

export type BrokerOperationState = "NOT_SUBMITTED" | "SUBMITTED" | "CONFIRMED" | "REJECTED" | "UNKNOWN" | "RECONCILIATION_REQUIRED";
export interface BrokerSubmission {
  readonly intentId: ExecutionIntent["id"];
  readonly idempotencyKey: ExecutionIntent["idempotencyKey"];
  readonly environment: "DEMO";
  readonly symbol: "XAUUSD";
  readonly direction: ExecutionIntent["direction"];
  readonly volume: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
}
export interface BrokerAcknowledgement {
  readonly state: "CONFIRMED" | "REJECTED" | "UNKNOWN";
  readonly brokerOrderId?: string;
  readonly brokerCode?: string;
  readonly message?: string;
}
export interface MT5DemoPort {
  submit(request: BrokerSubmission): Promise<BrokerAcknowledgement>;
  findByIdempotencyKey(key: ExecutionIntent["idempotencyKey"]): Promise<BrokerAcknowledgement | null>;
  getConnectionState(): Promise<"CONNECTED" | "DISCONNECTED">;
}
export type SafeSubmissionResult =
  | { readonly state: "CONFIRMED"; readonly brokerOrderId: string }
  | { readonly state: "REJECTED"; readonly brokerCode: string }
  | { readonly state: "UNKNOWN" | "RECONCILIATION_REQUIRED"; readonly reason: string };

/**
 * Safe orchestration contract. A durable repository and a real MT5 adapter are required before use.
 * An ambiguous submission is reconciled by idempotency key and never blindly retried.
 */
export async function submitDemoIntentSafely(
  intent: ExecutionIntent,
  port: MT5DemoPort,
  persistState: (state: BrokerOperationState, detail: string) => Promise<void>
): Promise<SafeSubmissionResult> {
  if (intent.environment !== "DEMO") return { state: "REJECTED", brokerCode: "LIVE_DISABLED" };
  const connection = await port.getConnectionState().catch(() => "DISCONNECTED" as const);
  if (connection !== "CONNECTED") {
    await persistState("NOT_SUBMITTED", "MT5_DISCONNECTED");
    return { state: "REJECTED", brokerCode: "MT5_DISCONNECTED" };
  }
  await persistState("SUBMITTED", "SUBMISSION_STARTED");
  let acknowledgement: BrokerAcknowledgement;
  try {
    acknowledgement = await port.submit({
      intentId: intent.id, idempotencyKey: intent.idempotencyKey, environment: "DEMO",
      symbol: "XAUUSD", direction: intent.direction, volume: intent.volume,
      stopLoss: intent.stopLoss, takeProfit: intent.takeProfit
    });
  } catch {
    await persistState("UNKNOWN", "SUBMISSION_RESULT_UNKNOWN");
    const reconciled = await port.findByIdempotencyKey(intent.idempotencyKey).catch(() => null);
    if (reconciled?.state === "CONFIRMED" && reconciled.brokerOrderId) {
      await persistState("CONFIRMED", "RECONCILED_CONFIRMED");
      return { state: "CONFIRMED", brokerOrderId: reconciled.brokerOrderId };
    }
    if (reconciled?.state === "REJECTED") {
      await persistState("REJECTED", reconciled.brokerCode ?? "BROKER_REJECTED");
      return { state: "REJECTED", brokerCode: reconciled.brokerCode ?? "BROKER_REJECTED" };
    }
    await persistState("RECONCILIATION_REQUIRED", "AMBIGUOUS_BROKER_ACKNOWLEDGEMENT");
    return { state: "RECONCILIATION_REQUIRED", reason: "Broker result is ambiguous; automatic retry is blocked." };
  }
  if (acknowledgement.state === "CONFIRMED" && acknowledgement.brokerOrderId) {
    await persistState("CONFIRMED", acknowledgement.brokerOrderId);
    return { state: "CONFIRMED", brokerOrderId: acknowledgement.brokerOrderId };
  }
  if (acknowledgement.state === "REJECTED") {
    const code = acknowledgement.brokerCode ?? "BROKER_REJECTED";
    await persistState("REJECTED", code);
    return { state: "REJECTED", brokerCode: code };
  }
  await persistState("RECONCILIATION_REQUIRED", "BROKER_RETURNED_UNKNOWN");
  return { state: "RECONCILIATION_REQUIRED", reason: "Broker returned an unknown result; automatic retry is blocked." };
}
