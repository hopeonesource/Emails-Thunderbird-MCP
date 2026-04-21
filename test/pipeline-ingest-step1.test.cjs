"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { loadCommunicationMemory } = require("../pipeline/lib/load-memory.cjs");

describe("loadCommunicationMemory", () => {
  it("loads fixture summaries and metadata within window", async () => {
    const root = path.join(__dirname, "..", "fixtures", "email-history-memory");
    const { summaries, priorSendMetadata, skippedOutOfWindow } = await loadCommunicationMemory(root, 500);
    assert.ok(summaries.length >= 1);
    assert.ok(priorSendMetadata.length >= 1);
    assert.equal(summaries[0].summary.majorTopics[0], "response times");
    assert.equal(priorSendMetadata[0].metadata.gmailThreadId, "fixture-thread-abc");
    assert.ok(typeof skippedOutOfWindow === "number");
  });
});
