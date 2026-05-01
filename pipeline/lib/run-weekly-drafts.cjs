"use strict";

const fs = require("fs");
const path = require("path");

const { getJwtAccessToken } = require("./salesforce-jwt.cjs");
const { fetchEligibleAccounts, FIELD_DEFAULTS: ELIG_DEFAULTS } = require("./eligibility.cjs");
const { generateWeeklyEmail } = require("./bedrock-email.cjs");
const { getAccessToken: getGoogleAccessToken } = require("./google-jwt.cjs");
const { createDraft } = require("./gmail-draft.cjs");
const {
  existsForWeek: existsForWeekDefault,
  recordWeeklyHistory: recordWeeklyHistoryDefault,
} = require("./historical-data.cjs");
const { isoWeekWindow } = require("./week-window.cjs");

/**
 * Orchestrate one weekly run.
 *
 * options:
 *   dryRun         (bool) - skip Bedrock/Gmail/Salesforce-write side effects, return planned actions
 *   fixturePath    (string) - dry-run accounts fixture
 *   nowIso         (string) - override current time (for tests)
 *   bedrockGenerate(account) -> { subject, htmlBody, markdownBody, modelId, sourceDataHash }
 *   gmailCreateDraft({ subject, htmlBody, accountId }) -> { draftId, threadId, messageId }
 *   sf             { instanceUrl, accessToken } - inject for tests; otherwise built from JWT
 *   recipients     {[accountId]: [emails]} - reviewer recipient for the draft
 *
 * Account isolation invariant: every Bedrock call, every Gmail draft, and every
 * Salesforce write is keyed strictly by the Salesforce Account.Id of the record
 * we just read. We never cross-reference data between accounts.
 */
async function runWeeklyDrafts(options = {}) {
  const dryRun = options.dryRun === true;
  const now = options.nowIso ? new Date(options.nowIso) : new Date();
  const { weekStart, weekEnd } = isoWeekWindow(now);
  const existsForWeek = options.existsForWeek || existsForWeekDefault;
  const recordWeeklyHistory = options.recordWeeklyHistory || recordWeeklyHistoryDefault;

  const summary = {
    runStartedAt: now.toISOString(),
    weekStart,
    weekEnd,
    dryRun,
    totalEligible: 0,
    draftsCreated: 0,
    skipped: 0,
    failed: 0,
    perAccount: [],
  };

  const accounts = await loadEligibleAccounts(options, dryRun);
  summary.totalEligible = accounts.length;

  for (const acct of accounts) {
    const accountId = acct.Id;
    const accountName = acct.Name;
    const perAccount = { accountId, accountName, status: "pending" };

    try {
      if (!dryRun) {
        const sf = options.sf || (await getInjectedOrLiveSf(options));
        if (await existsForWeek(sf, accountId, weekStart)) {
          perAccount.status = "skipped_existing";
          summary.skipped += 1;
          summary.perAccount.push(perAccount);
          continue;
        }
      }

      const accountWeeklyData = buildAccountWeeklyData(acct, weekStart, weekEnd);

      let generated;
      if (options.bedrockGenerate) {
        generated = await options.bedrockGenerate(accountWeeklyData);
      } else if (dryRun) {
        generated = buildStubEmail(accountWeeklyData);
      } else {
        generated = await generateWeeklyEmail(accountWeeklyData);
      }

      perAccount.subject = generated.subject;
      perAccount.modelId = generated.modelId;
      perAccount.sourceDataHash = generated.sourceDataHash;

      if (dryRun) {
        perAccount.status = "dry_run";
        perAccount.htmlPreview = generated.htmlBody.slice(0, 200);
        summary.perAccount.push(perAccount);
        continue;
      }

      const recipients = (options.recipients && options.recipients[accountId]) || [
        process.env.GMAIL_REVIEW_RECIPIENT || process.env.GMAIL_SUBJECT,
      ];
      const fromAddress =
        process.env.GMAIL_FROM ||
        `Hope1Source Check-ins <${process.env.GMAIL_SUBJECT || "checkins@hopewithlove.org"}>`;

      const draft = options.gmailCreateDraft
        ? await options.gmailCreateDraft({
            subject: generated.subject,
            htmlBody: generated.htmlBody,
            to: recipients,
            from: fromAddress,
            accountId,
          })
        : await createGmailDraftLive({ generated, recipients, fromAddress });

      perAccount.gmailDraftId = draft.draftId;
      perAccount.gmailThreadId = draft.threadId;

      const sf = options.sf || (await getInjectedOrLiveSf(options));
      const history = await recordWeeklyHistory(sf, {
        accountId,
        weekStartIso: weekStart,
        weekEndIso: weekEnd,
        draftId: draft.draftId,
        threadId: draft.threadId,
        bedrockModelId: generated.modelId,
        sourceDataHash: generated.sourceDataHash,
        markdownBody: generated.markdownBody,
        status: "draft_created",
      });

      perAccount.historicalDataId = history.recordId;
      perAccount.markdownContentDocumentId = history.contentDocumentId;
      perAccount.status = "draft_created";
      summary.draftsCreated += 1;
    } catch (e) {
      perAccount.status = "failed";
      perAccount.error = e.message || String(e);
      summary.failed += 1;
    }

    summary.perAccount.push(perAccount);
  }

  return summary;
}

async function loadEligibleAccounts(options, dryRun) {
  if (Array.isArray(options.accounts)) return options.accounts;

  const useFixture =
    dryRun ||
    Boolean(options.fixturePath) ||
    Boolean(process.env.WEEKLY_DRAFTS_FIXTURE_PATH);

  if (useFixture) {
    const fixturePath =
      options.fixturePath ||
      process.env.WEEKLY_DRAFTS_FIXTURE_PATH ||
      path.join(__dirname, "..", "..", "fixtures", "weekly-eligible-accounts.json");
    const raw = fs.readFileSync(path.resolve(fixturePath), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.records || [];
  }

  const sf = options.sf || (await getInjectedOrLiveSf(options));
  return fetchEligibleAccounts(sf);
}

function buildStubEmail(accountWeeklyData) {
  const { accountId, accountName, weekStart, weekEnd, weeklyMetrics = {}, recentCheckins = [] } = accountWeeklyData;
  const metricsHtml = Object.entries(weeklyMetrics)
    .map(([k, v]) => `<tr><td style="padding:4px 8px;color:#555">${k}</td><td style="padding:4px 8px"><b>${v}</b></td></tr>`)
    .join("");
  const subject = `Your weekly check-in summary (${weekStart})`;
  const htmlBody = [
    `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f8">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">`,
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">`,
    `<tr><td style="padding:24px"><h1 style="margin:0;font-size:20px;color:#111">${accountName} - Weekly Check-in</h1>`,
    `<p style="color:#555">Window: ${weekStart} to ${weekEnd}</p>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${metricsHtml}</table>`,
    `<p style="color:#555">Recent check-ins: ${recentCheckins.length}</p>`,
    `<p style="font-size:12px;color:#888">[stub draft - account ${accountId}]</p>`,
    `</td></tr></table></td></tr></table></body></html>`,
  ].join("");
  const markdownBody = [
    `# ${accountName} - Weekly Check-in`,
    `Window: ${weekStart} to ${weekEnd}`,
    "",
    "## Metrics",
    ...Object.entries(weeklyMetrics).map(([k, v]) => `- **${k}**: ${v}`),
    "",
    `Recent check-ins: ${recentCheckins.length}`,
    "",
    `_[stub draft - account ${accountId}]_`,
  ].join("\n");
  return {
    subject,
    htmlBody,
    markdownBody,
    modelId: "stub",
    sourceDataHash: require("crypto")
      .createHash("sha256")
      .update(JSON.stringify(accountWeeklyData))
      .digest("hex"),
  };
}

async function getInjectedOrLiveSf(options) {
  if (options && options.sf) return options.sf;
  const { access_token, instance_url } = await getJwtAccessToken();
  return { instanceUrl: instance_url, accessToken: access_token };
}

async function createGmailDraftLive({ generated, recipients, fromAddress }) {
  const tok = await getGoogleAccessToken();
  return createDraft({
    accessToken: tok.access_token,
    from: fromAddress,
    to: recipients,
    subject: generated.subject,
    htmlBody: generated.htmlBody,
  });
}

function buildAccountWeeklyData(acct, weekStart, weekEnd) {
  const passthrough = { ...acct };
  delete passthrough.attributes;
  return {
    accountId: acct.Id,
    accountName: acct.Name,
    weekStart,
    weekEnd,
    eligibilityFields: {
      [ELIG_DEFAULTS.sendFeedback]: acct[ELIG_DEFAULTS.sendFeedback],
      [ELIG_DEFAULTS.emailOptOut]: acct[ELIG_DEFAULTS.emailOptOut],
      [ELIG_DEFAULTS.doNotContact]: acct[ELIG_DEFAULTS.doNotContact],
      [ELIG_DEFAULTS.aiInsights]: acct[ELIG_DEFAULTS.aiInsights],
    },
    weeklyMetrics: acct.weeklyMetrics || passthrough.weeklyMetrics || {},
    recentCheckins: acct.recentCheckins || passthrough.recentCheckins || [],
    notes: acct.notes || passthrough.notes || "",
  };
}

module.exports = { runWeeklyDrafts, buildAccountWeeklyData, buildStubEmail };
