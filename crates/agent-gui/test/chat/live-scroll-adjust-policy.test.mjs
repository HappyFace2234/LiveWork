import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const modulePath = path.join(rootDir, "src/lib/transcript-virtual/liveScrollAdjustPolicy.ts");
const { createLiveRowScrollAdjustPolicy } = createTsModuleLoader({ rootDir }).loadModule(
  modulePath,
);

const makeItem = ({ index = 5, start, size }) => ({
  index,
  key: index,
  start,
  size,
  end: start + size,
  lane: 0,
});

const makeInstance = ({ scrollOffset = 1000, scrollDirection = null, scrollAdjustments = 0 } = {}) => ({
  scrollOffset,
  scrollDirection,
  scrollAdjustments,
});

const makePolicy = ({ liveStartIndex = -1, following = false } = {}) =>
  createLiveRowScrollAdjustPolicy({
    getLiveStartIndex: () => liveStartIndex,
    isFollowing: () => following,
  });

test("row entirely above the viewport keeps the default compensation", () => {
  const policy = makePolicy();
  const item = makeItem({ index: 1, start: 100, size: 200 });
  assert.equal(policy(item, 40, makeInstance()), true);
  assert.equal(policy(item, -40, makeInstance()), true);
});

test("row starting at or below the viewport top never adjusts", () => {
  const policy = makePolicy();
  assert.equal(policy(makeItem({ start: 1000, size: 200 }), 40, makeInstance()), false);
  assert.equal(policy(makeItem({ start: 1200, size: 200 }), 40, makeInstance()), false);
});

test("active backward scrolling suppresses compensation (upstream default)", () => {
  const policy = makePolicy();
  const item = makeItem({ index: 1, start: 100, size: 200 });
  assert.equal(policy(item, 40, makeInstance({ scrollDirection: "backward" })), false);
  assert.equal(policy(item, 40, makeInstance({ scrollDirection: "forward" })), true);
});

test("detached reader inside the growing live row is left alone (streaming creep)", () => {
  const policy = makePolicy({ liveStartIndex: 5, following: false });
  // Live row spans 400..5400, viewport top at 3000: the reader scrolled up
  // into the streaming reply. Growth appends below the reading line.
  const item = makeItem({ index: 5, start: 400, size: 5000 });
  assert.equal(policy(item, 60, makeInstance({ scrollOffset: 3000 })), false);
});

test("the same live-row growth while following keeps compensating (pin assist)", () => {
  const policy = makePolicy({ liveStartIndex: 5, following: true });
  const item = makeItem({ index: 5, start: 400, size: 5000 });
  assert.equal(policy(item, 60, makeInstance({ scrollOffset: 3000 })), true);
});

test("live-row shrink keeps compensating so content under the reader stays put", () => {
  const policy = makePolicy({ liveStartIndex: 5, following: false });
  const item = makeItem({ index: 5, start: 400, size: 5000 });
  assert.equal(policy(item, -80, makeInstance({ scrollOffset: 3000 })), true);
});

test("settled row straddling the viewport keeps the default", () => {
  const policy = makePolicy({ liveStartIndex: 5, following: false });
  const item = makeItem({ index: 2, start: 400, size: 5000 });
  assert.equal(policy(item, 60, makeInstance({ scrollOffset: 3000 })), true);
});

test("idle transcript (liveStartIndex -1) keeps the default everywhere", () => {
  const policy = makePolicy({ liveStartIndex: -1, following: false });
  const item = makeItem({ index: 5, start: 400, size: 5000 });
  assert.equal(policy(item, 60, makeInstance({ scrollOffset: 3000 })), true);
});

test("live row entirely above the viewport still compensates", () => {
  const policy = makePolicy({ liveStartIndex: 5, following: false });
  // end (300) <= viewport top (1000): the growth lands above the reader.
  const item = makeItem({ index: 5, start: 100, size: 200 });
  assert.equal(policy(item, 40, makeInstance({ scrollOffset: 1000 })), true);
});

test("pending scroll adjustments fold into the viewport-top comparison", () => {
  const policy = makePolicy();
  const item = makeItem({ index: 1, start: 1040, size: 5 });
  // Without pending adjustments the row start sits below the viewport top…
  assert.equal(policy(item, 40, makeInstance({ scrollOffset: 1000 })), false);
  // …with 50px of un-echoed writes it counts as above, like upstream.
  assert.equal(policy(item, 40, makeInstance({ scrollOffset: 1000, scrollAdjustments: 50 })), true);
});

test("missing private scrollAdjustments field falls back to zero", () => {
  const policy = makePolicy();
  const item = makeItem({ index: 1, start: 100, size: 200 });
  assert.equal(policy(item, 40, { scrollOffset: 1000, scrollDirection: null }), true);
});
