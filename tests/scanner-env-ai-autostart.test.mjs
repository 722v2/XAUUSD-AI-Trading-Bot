import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer } from "../server.mjs";

test("scanner auto-start restores an explicitly configured environment AI model without Supabase", async () => {
  const server = createAppServer({
    HOST: "127.0.0.1",
    AI_PROVIDER_ID: "openai-compatible",
    AI_MODEL_ID: "test-model",
    AI_BASE_URL: "https://api.example.com/v1",
    AI_API_KEY: "test-only-key",
    AI_ALLOWED_MODELS: "test-model",
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    // Let the listening hook hydrate settings and call startScanner().
    await new Promise(resolve => setTimeout(resolve, 50));
    const response = await fetch(origin + "/api/config");
    assert.equal(response.status, 200);
    const config = await response.json();
    assert.equal(config.scannerEnabled, true);
    assert.equal(config.aiProviderId, "openai-compatible");
    assert.equal(config.aiModelId, "test-model");
  } finally {
    await fetch(origin + "/api/scanner/enabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }).catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
});
