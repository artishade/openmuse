import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createApp } from "../apps/server/src/app.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";

let db: Store, directory: string, token: string;
let app: Awaited<ReturnType<typeof createApp>>["app"];
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-local-mode-"));
  db = await createStore();
  // No intelligenceApiKey: the API must boot into local mode and offer in-app setup.
  ({ app } = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  }));
  const session = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  token = (await session.json()).token;
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("a missing Intelligence key boots locally and asks for setup", async () => {
  const health = await (await app.request("/api/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.intelligenceConfigured, false);
  const snapshot = await (await app.request("/api/workspace", { headers: headers() })).json();
  assert.equal(snapshot.runtime.richThreads, false);
  assert.equal(snapshot.runtime.intelligenceConfigured, false);
  const main = await app.request("/api/main-thread", { headers: headers() });
  assert.equal(main.status, 503);
  assert.match((await main.json()).error, /CopilotKit Intelligence project key/);
});

test("saving a project key from the app switches the workspace to Rich Threads", async (t) => {
  const calls: Parameters<CopilotKitIntelligence["getOrCreateThread"]>[0][] = [];
  t.mock.method(
    CopilotKitIntelligence.prototype,
    "getOrCreateThread",
    async (input: Parameters<CopilotKitIntelligence["getOrCreateThread"]>[0]) => {
      calls.push(input);
      return { id: input.threadId };
    },
  );
  const saved = await app.request("/api/settings/intelligence", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ apiKey: "test-project-key-never-sent" }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).configured, true);
  const main = await (await app.request("/api/main-thread", { headers: headers() })).json();
  assert.equal(main.existing, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, "local-user");
  const snapshot = await (await app.request("/api/workspace", { headers: headers() })).json();
  assert.equal(snapshot.runtime.richThreads, true);
  assert.equal(snapshot.runtime.intelligenceConfigured, true);
  const health = await (await app.request("/api/health")).json();
  assert.equal(health.intelligenceConfigured, true);
  const cleared = await app.request("/api/settings/intelligence", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ apiKey: "" }),
  });
  assert.equal((await cleared.json()).configured, false);
});

test("the setup endpoint rejects implausibly short keys", async () => {
  const saved = await app.request("/api/settings/intelligence", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ apiKey: "short" }),
  });
  assert.equal(saved.status, 422);
});
