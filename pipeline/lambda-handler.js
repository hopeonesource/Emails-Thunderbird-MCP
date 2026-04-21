"use strict";

const path = require("path");
const { runIngestStep1 } = require("./lib/run-ingest-step1.cjs");

function envBool(name) {
  const v = process.env[name];
  if (v === undefined || v === "") return false;
  return /^(1|true|yes)$/i.test(String(v));
}

function eventBool(event, key) {
  if (!event || event[key] === undefined) return false;
  const v = event[key];
  if (typeof v === "boolean") return v;
  return /^(1|true|yes)$/i.test(String(v));
}

/**
 * AWS Lambda handler (Node.js 20.x). If the deployment zip keeps this file at
 * pipeline/lambda-handler.js, set the Lambda handler to: pipeline/lambda-handler.handler
 *
 * Environment (optional): INGEST_DRY_RUN, EMAIL_MEMORY_DIR, EMAIL_HISTORY_DIR,
 * EMAIL_MEMORY_WINDOW_DAYS, INGEST_FIXTURE_SF_PATH (dry-run fixture path inside the deployment package).
 *
 * Event (optional): dryRun, memoryDir, memoryDays, fixtureSf, includeFullPayload
 */
exports.handler = async (event = {}) => {
  const dryRun = eventBool(event, "dryRun") || envBool("INGEST_DRY_RUN");
  const memoryDir =
    (event.memoryDir && String(event.memoryDir)) ||
    process.env.EMAIL_MEMORY_DIR ||
    process.env.EMAIL_HISTORY_DIR ||
    "/tmp/email-history";
  const memoryDays = Number(
    event.memoryDays !== undefined && event.memoryDays !== null && event.memoryDays !== ""
      ? event.memoryDays
      : process.env.EMAIL_MEMORY_WINDOW_DAYS || 45
  );
  const fixtureSf =
    (event.fixtureSf && String(event.fixtureSf)) ||
    process.env.INGEST_FIXTURE_SF_PATH ||
    path.join(__dirname, "..", "fixtures", "salesforce-ingest-sample.json");

  const { payload } = await runIngestStep1({
    dryRun,
    memoryDir,
    memoryDays,
    fixtureSf,
  });

  if (eventBool(event, "includeFullPayload") || envBool("INGEST_LAMBDA_RETURN_FULL_PAYLOAD")) {
    return payload;
  }

  return {
    ok: true,
    step: payload.step,
    name: payload.name,
    ingestedAt: payload.ingestedAt,
    salesforce: {
      dryRun: payload.salesforce.dryRun,
      totalSize: payload.salesforce.totalSize,
      done: payload.salesforce.done,
    },
    memory: {
      windowDays: payload.memory.windowDays,
      memoryDir: payload.memory.memoryDir,
      recentSummariesCount: payload.memory.recentSummaries.length,
      priorSendMetadataCount: payload.memory.priorSendMetadata.length,
      skippedFilesOutOfWindow: payload.memory.skippedFilesOutOfWindow,
    },
  };
};
