"use strict";

const fs = require("fs");
const path = require("path");

const { getJwtAccessToken } = require("./salesforce-jwt.cjs");
const { fetchEligibleAccounts } = require("./eligibility.cjs");
const { generateWeeklyEmail } = require("./bedrock-email.cjs");
const { getAccessToken: getGoogleAccessToken } = require("./google-jwt.cjs");
const { createDraft } = require("./gmail-draft.cjs");
const {
  existsForWeek: existsForWeekDefault,
  fetchLatestHistoricalData: fetchLatestHistoricalDataDefault,
  fetchRecentClientFeedback: fetchRecentClientFeedbackDefault,
  recordWeeklyHistory: recordWeeklyHistoryDefault,
  stampFeedbackEmailSent: stampFeedbackEmailSentDefault,
} = require("./historical-data.cjs");
const { isoWeekWindow } = require("./week-window.cjs");

/**
 * Orchestrate one weekly run.
 *
 * options:
 *   dryRun         (bool) - skip Bedrock/Gmail/Salesforce-write side effects, return planned actions
 *   fixtureDraftOnly (bool) - use fixture data, call Bedrock/Gmail, skip Salesforce reads/writes
 *   fixturePath    (string) - dry-run account/recipient fixture
 *   nowIso         (string) - override current time (for tests)
 *   bedrockGenerate(account) -> { subject, htmlBody, markdownBody, modelId, sourceDataHash }
 *   gmailCreateDraft({ subject, htmlBody, accountId }) -> { draftId, threadId, messageId }
 *   sf             { instanceUrl, accessToken } - inject for tests; otherwise built from JWT
 *   recipients     {[accountId]: [emails]} - override recipients for the draft
 *
 * Account isolation invariant: every Bedrock call, every Gmail draft, and every
 * Salesforce write is keyed strictly by the Salesforce Account.Id of the record
 * we just read. We never cross-reference data between accounts.
 */
async function runWeeklyDrafts(options = {}) {
  const dryRun = options.dryRun === true;
  const fixtureDraftOnly = options.fixtureDraftOnly === true;
  const now = options.nowIso ? new Date(options.nowIso) : new Date();
  const { weekStart, weekEnd } = isoWeekWindow(now);
  const existsForWeek = options.existsForWeek || existsForWeekDefault;
  const fetchLatestHistoricalData = options.fetchLatestHistoricalData || fetchLatestHistoricalDataDefault;
  const fetchRecentClientFeedback = options.fetchRecentClientFeedback || fetchRecentClientFeedbackDefault;
  const recordWeeklyHistory = options.recordWeeklyHistory || recordWeeklyHistoryDefault;
  const stampFeedbackEmailSent = options.stampFeedbackEmailSent || stampFeedbackEmailSentDefault;

  const summary = {
    runStartedAt: now.toISOString(),
    weekStart,
    weekEnd,
    dryRun,
    fixtureDraftOnly,
    totalEligible: 0,
    draftsCreated: 0,
    skipped: 0,
    failed: 0,
    perAccount: [],
  };

  const accountContexts = applyAccountAllowlist(
    await loadEligibleAccounts(options, dryRun || fixtureDraftOnly),
    options
  );
  summary.totalEligible = accountContexts.length;

  for (const acct of accountContexts) {
    const accountId = acct.Id;
    const accountName = acct.Name;
    const perAccount = {
      accountId,
      accountName,
      status: "pending",
      recipientCount: Array.isArray(acct.recipients) ? acct.recipients.length : 0,
    };

    try {
      const sf = options.sf || (dryRun || fixtureDraftOnly ? null : await getInjectedOrLiveSf(options));
      if (!dryRun && !fixtureDraftOnly) {
        if (await existsForWeek(sf, accountId, weekStart)) {
          perAccount.status = "skipped_existing";
          summary.skipped += 1;
          summary.perAccount.push(perAccount);
          continue;
        }
      }

      const historicalData =
        acct.historicalData ||
        (dryRun || fixtureDraftOnly ? null : await fetchLatestHistoricalData(sf, accountId));
      if (!dryRun && !fixtureDraftOnly && !historicalData) {
        throw new Error(`No Historical_Data__c found for Account ${accountId}`);
      }

      const recentFeedback =
        acct.recentFeedback ||
        acct.recentCheckins ||
        (dryRun || fixtureDraftOnly ? [] : await fetchRecentClientFeedback(sf, accountId));

      const accountWeeklyData = buildAccountWeeklyData(acct, weekStart, weekEnd, historicalData, recentFeedback);

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

      const recipients = resolveDraftRecipients(acct, accountId, options);
      if (recipients.length === 0) {
        throw new Error(`No eligible Service Provider recipient email found for Account ${accountId}`);
      }
      const fromAddress =
        process.env.GMAIL_FROM ||
        `Hope1Source Check-ins <${process.env.GMAIL_SUBJECT || "checkins@hope1source.me"}>`;

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

      if (fixtureDraftOnly) {
        perAccount.status = "fixture_draft_created";
        summary.draftsCreated += 1;
        summary.perAccount.push(perAccount);
        continue;
      }

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

      if (process.env.SF_STAMP_FEEDBACK_EMAIL_SENT === "true") {
        await stampFeedbackEmailSent(
          sf,
          (acct.recipients || []).map((r) => r.contactId),
          toIsoDate(now)
        );
      }

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

function applyAccountAllowlist(accountContexts, options = {}) {
  if (!Array.isArray(accountContexts)) return [];
  const idAllowlist = parseCsv(options.allowedAccountIds || process.env.HOP43_ALLOWED_ACCOUNT_IDS);
  const nameAllowlist = parseCsv(options.allowedAccountNames || process.env.HOP43_ALLOWED_ACCOUNT_NAMES)
    .map((name) => name.toLowerCase());
  const allowBroad = /^(1|true|yes)$/i.test(String(options.allowBroadRun || process.env.HOP43_ALLOW_BROAD_RUN || ""));

  if (idAllowlist.length === 0 && nameAllowlist.length === 0) {
    if (allowBroad || options.dryRun === true) return accountContexts;
    throw new Error("Set HOP43_ALLOWED_ACCOUNT_IDS or HOP43_ALLOWED_ACCOUNT_NAMES before non-dry-run execution");
  }

  return accountContexts.filter((acct) => {
    const id = String(acct.Id || acct.accountId || "");
    const name = String(acct.Name || acct.accountName || "").toLowerCase();
    return idAllowlist.includes(id) || nameAllowlist.includes(name);
  });
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
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

function resolveDraftRecipients(acct, accountId, options = {}) {
  if (options.recipients && options.recipients[accountId]) return options.recipients[accountId];
  if (process.env.GMAIL_REVIEW_RECIPIENT) {
    return process.env.GMAIL_REVIEW_RECIPIENT.split(",")
      .map((email) => email.trim())
      .filter(Boolean);
  }
  if (!/^(1|true|yes)$/i.test(String(options.allowAccountRecipients || process.env.HOP43_ALLOW_ACCOUNT_RECIPIENTS || ""))) {
    throw new Error("Set GMAIL_REVIEW_RECIPIENT before creating drafts, or explicitly set HOP43_ALLOW_ACCOUNT_RECIPIENTS=true");
  }
  return (acct.recipients || []).map((r) => r.email).filter(Boolean);
}

function buildAccountWeeklyData(acct, weekStart, weekEnd, historicalData = null, recentFeedback = []) {
  const passthrough = { ...acct };
  delete passthrough.attributes;
  const checkins = recentFeedback || acct.recentCheckins || passthrough.recentCheckins || [];
  return {
    accountId: acct.Id,
    accountName: acct.Name,
    weekStart,
    weekEnd,
    serviceProviderRecipientCount: Array.isArray(acct.recipients) ? acct.recipients.length : 0,
    historicalDataId: historicalData?.Id || acct.historicalDataId || null,
    weeklyMetrics: acct.weeklyMetrics || extractWeeklyMetrics(historicalData) || passthrough.weeklyMetrics || {},
    recentCheckins: checkins.map(sanitizeCheckinForBedrock),
  };
}

function sanitizeCheckinForBedrock(record) {
  if (!record || typeof record !== "object") return {};
  return {
    submittedOn: record.Submission_Date__c || record.submittedOn || null,
    rating: record.Rating__c || record.rating || null,
    description: record.Description__c || record.description || "",
    hopefulScore: record.How_Hopeful_Are_You__c || record.hopefulScore || null,
    moreHopeful: record.What_would_make_you_more_hopeful__c || record.moreHopeful || "",
  };
}

function extractWeeklyMetrics(historicalData) {
  if (!historicalData) return null;
  return {
    totalFeedback: historicalData.Total_Feedback__c,
    feedbackLast7Days: historicalData.Feedback_Last_7_Days__c,
    feedbackLast30Days: historicalData.Feedback_Last_30_Days__c,
    avgRatingAllTime: historicalData.Avg_Rating_All_Time__c,
    last7DaysRatingAvg: historicalData.Last_7_Days_Rating_Avg__c,
    weeklyLast7DaysChange: historicalData.Weekly_Last_7_Days_Change__c,
    weeklyLast7DaysRatingChange: historicalData.Weekly_Last_7_Days_Rating_Change__c,
    total5StarReviews: historicalData.Total_of_5_Star_Reviews__c,
    weekly5StarReviewChange: historicalData.Weekly_5_Star_Review_Change__c,
  };
}

function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

module.exports = {
  runWeeklyDrafts,
  buildAccountWeeklyData,
  buildStubEmail,
  extractWeeklyMetrics,
  sanitizeCheckinForBedrock,
  resolveDraftRecipients,
  applyAccountAllowlist,
};
