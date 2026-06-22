import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

test("live stream store commits through timer fallback when animation frames are paused", async () => {
  const { createLiveConversationStreamStore } = loader.loadModule(
    "src/lib/liveConversationStreamStore.ts",
  );
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const cancelledFrames = [];
  let requestedFrame = false;
  let notifications = 0;

  try {
    delete globalThis.document;
    globalThis.window = {
      requestAnimationFrame() {
        requestedFrame = true;
        return 11;
      },
      cancelAnimationFrame(frameId) {
        cancelledFrames.push(frameId);
      },
      setTimeout,
      clearTimeout,
    };

    const store = createLiveConversationStreamStore();
    store.subscribe(() => {
      notifications += 1;
    });
    store.appendEvent({
      type: "token",
      text: "hello",
      conversation_id: "conversation-1",
      round: 1,
    });

    assert.equal(store.getSnapshot().entries.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 310));

    const snapshot = store.getSnapshot();
    assert.equal(requestedFrame, true);
    assert.deepEqual(cancelledFrames, [11]);
    assert.equal(notifications, 1);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].kind, "assistant");
    assert.equal(snapshot.entries[0].text, "hello");
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  }
});
