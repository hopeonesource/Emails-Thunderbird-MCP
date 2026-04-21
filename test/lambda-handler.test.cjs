"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { handler } = require("../pipeline/lambda-handler.js");

describe("lambda-handler", () => {
  it("returns summary for dry-run with fixture memory", async () => {
    const memoryDir = path.join(__dirname, "..", "fixtures", "email-history-memory");
    const out = await handler({
      dryRun: true,
      memoryDir,
      memoryDays: 500,
    });
    assert.equal(out.ok, true);
    assert.equal(out.salesforce.dryRun, true);
    assert.ok(out.memory.recentSummariesCount >= 1);
    assert.ok(out.memory.priorSendMetadataCount >= 1);
  });
});
