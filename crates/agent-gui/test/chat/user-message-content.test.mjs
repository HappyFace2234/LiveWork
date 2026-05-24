import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const userMessageContent = loader.loadModule("src/lib/chat/messages/userMessageContent.tsx");

test("user message skill mentions style only skill-like tokens", () => {
  assert.equal(userMessageContent.isSkillMentionToken("$code-review"), true);
  assert.equal(userMessageContent.isSkillMentionToken("$release_notes"), true);
  assert.equal(userMessageContent.isSkillMentionToken("$PATH"), false);
  assert.equal(userMessageContent.isSkillMentionToken("$PATH:"), false);
  assert.equal(userMessageContent.isSkillMentionToken("price$tag"), false);
  assert.equal(userMessageContent.isSkillMentionToken("$bad.name"), false);
});
