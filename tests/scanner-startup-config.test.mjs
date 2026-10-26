import test from "node:test";
import assert from "node:assert/strict";
import { startupAISelections } from "../server.mjs";

test("startup AI selection prefers persisted provider/model", () => {
  assert.deepEqual(
    startupAISelections(
      { aiProviderId: "stored-provider", aiModelId: "stored-model" },
      { AI_PROVIDER_ID: "env-provider", AI_MODEL_ID: "env-model" },
    ),
    [
      { providerId: "stored-provider", modelId: "stored-model", source: "PERSISTED" },
      { providerId: "env-provider", modelId: "env-model", source: "ENVIRONMENT" },
    ],
  );
});

test("startup AI selection falls back to explicit environment pair when persistence is empty", () => {
  assert.deepEqual(
    startupAISelections({}, { AI_PROVIDER_ID: "openai-compatible", AI_MODEL_ID: "chosen-model" }),
    [{ providerId: "openai-compatible", modelId: "chosen-model", source: "ENVIRONMENT" }],
  );
});

test("startup AI selection never invents a provider or model", () => {
  assert.deepEqual(startupAISelections({}, { AI_PROVIDER_ID: "provider-without-model" }), []);
  assert.deepEqual(startupAISelections({}, { AI_MODEL_ID: "model-without-provider" }), []);
  assert.deepEqual(startupAISelections({}, {}), []);
});

test("startup AI selection removes duplicate persisted and environment pairs", () => {
  assert.deepEqual(
    startupAISelections(
      { aiProviderId: "p", aiModelId: "m" },
      { AI_PROVIDER_ID: "p", AI_MODEL_ID: "m" },
    ),
    [{ providerId: "p", modelId: "m", source: "PERSISTED" }],
  );
});
