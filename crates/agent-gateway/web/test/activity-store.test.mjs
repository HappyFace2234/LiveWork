import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const { createActivityStore } = loader.loadModule("src/lib/chat/stream/activityStore.ts");

test("activity events drive the running map with run identity", () => {
  const store = createActivityStore();
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: true,
    state: "running",
    workdir: "/workspace",
    updatedAt: 10,
  });
  assert.equal(store.isRunning("conv-1"), true);
  assert.equal(store.get("conv-1")?.runId, "run-1");
  assert.equal(notifications, 1);

  // Duplicate state is ignored.
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: true,
    state: "running",
    workdir: "/workspace",
    updatedAt: 11,
  });
  assert.equal(notifications, 1);

  // A stale event (older than what we show) is ignored.
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-0",
    running: true,
    state: "running",
    workdir: "/workspace",
    updatedAt: 5,
  });
  assert.equal(store.get("conv-1")?.runId, "run-1");

  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: false,
    state: null,
    workdir: null,
    updatedAt: 20,
  });
  assert.equal(store.isRunning("conv-1"), false);
  assert.equal(notifications, 2);
});

test("hydration drops stale entries and adopts the snapshot", () => {
  const store = createActivityStore();
  store.applyActivityEvent({
    conversationId: "conv-stale",
    runId: "run-stale",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 1,
  });

  store.hydrate([
    { conversationId: "conv-1", runId: "run-1", state: "running", workdir: "/w", updatedAt: 2 },
    { conversationId: "conv-2", runId: "run-2", state: "cancelling", updatedAt: 3 },
  ]);

  assert.equal(
    store.isRunning("conv-stale"),
    false,
    "entry older than the snapshot batch is dropped",
  );
  assert.equal(store.get("conv-1")?.runId, "run-1");
  assert.equal(store.get("conv-2")?.state, "cancelling");
});

test("hydration is an ordered merge: pushes newer than the snapshot win", () => {
  const store = createActivityStore();
  // A chat.activity push arrived after the history.list response was built.
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-2",
    running: true,
    state: "running",
    workdir: "/w",
    clientRequestId: null,
    updatedAt: 30,
  });
  store.applyActivityEvent({
    conversationId: "conv-live",
    runId: "run-live",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 50,
  });

  store.hydrate([
    // Stale row for conv-1 (the snapshot predates the run-2 handoff).
    { conversationId: "conv-1", runId: "run-1", state: "running", workdir: "/w", updatedAt: 10 },
    { conversationId: "conv-other", runId: "run-9", state: "running", updatedAt: 40 },
  ]);

  assert.equal(store.get("conv-1")?.runId, "run-2", "newer push beats the stale snapshot row");
  assert.equal(
    store.isRunning("conv-live"),
    true,
    "entry newer than the whole batch survives despite being absent from it",
  );
  assert.equal(store.get("conv-other")?.runId, "run-9");
});

test("an empty hydration snapshot means idle everywhere", () => {
  const store = createActivityStore();
  store.applyActivityEvent({
    conversationId: "conv-1",
    runId: "run-1",
    running: true,
    state: "running",
    workdir: null,
    clientRequestId: null,
    updatedAt: 100,
  });
  store.hydrate([]);
  assert.equal(store.isRunning("conv-1"), false);
});
