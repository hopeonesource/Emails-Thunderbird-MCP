"use strict";

const { runWeeklyDrafts } = require("./lib/run-weekly-drafts.cjs");

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
 * AWS Lambda handler (Node.js 20.x). Trigger weekly via EventBridge.
 *
 * Set the Lambda handler to: pipeline/weekly-drafts-handler.handler
 *
 * Event (optional):
 *   { dryRun: true, fixturePath: "/var/task/fixtures/weekly-eligible-accounts.json", nowIso: "2026-04-30T12:00:00Z" }
 */
exports.handler = async (event = {}) => {
  const dryRun = eventBool(event, "dryRun") || envBool("WEEKLY_DRAFTS_DRY_RUN");
  const summary = await runWeeklyDrafts({
    dryRun,
    fixturePath: event.fixturePath,
    nowIso: event.nowIso,
  });
  return {
    ok: summary.failed === 0,
    weekStart: summary.weekStart,
    weekEnd: summary.weekEnd,
    dryRun: summary.dryRun,
    totalEligible: summary.totalEligible,
    draftsCreated: summary.draftsCreated,
    skipped: summary.skipped,
    failed: summary.failed,
    perAccount: summary.perAccount.map((a) => ({
      accountId: a.accountId,
      accountName: a.accountName,
      status: a.status,
      modelId: a.modelId,
      gmailDraftId: a.gmailDraftId,
      historicalDataId: a.historicalDataId,
      error: a.error,
    })),
  };
};
