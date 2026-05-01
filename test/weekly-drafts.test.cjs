"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { runWeeklyDrafts } = require("../pipeline/lib/run-weekly-drafts.cjs");
const { handler } = require("../pipeline/weekly-drafts-handler.js");
const { isEligible, buildEligibilitySoql, fieldNames } = require("../pipeline/lib/eligibility.cjs");
const { isoWeekWindow } = require("../pipeline/lib/week-window.cjs");
const {
  parseModelOutput,
  hashSourceData,
  buildUserMessage,
  generateWeeklyEmail,
} = require("../pipeline/lib/bedrock-email.cjs");
const { buildMime, base64UrlEncode, stripHtml } = require("../pipeline/lib/gmail-draft.cjs");

const FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "weekly-eligible-accounts.json");

describe("eligibility", () => {
  const f = fieldNames();

  it("requires all four checkboxes to match", () => {
    const ok = {
      [f.sendFeedback]: true,
      [f.emailOptOut]: false,
      [f.doNotContact]: false,
      [f.aiInsights]: true,
    };
    assert.equal(isEligible(ok), true);
    assert.equal(isEligible({ ...ok, [f.sendFeedback]: false }), false);
    assert.equal(isEligible({ ...ok, [f.emailOptOut]: true }), false);
    assert.equal(isEligible({ ...ok, [f.doNotContact]: true }), false);
    assert.equal(isEligible({ ...ok, [f.aiInsights]: false }), false);
  });

  it("builds a SELECT...WHERE SOQL with all four conditions", () => {
    const soql = buildEligibilitySoql();
    assert.match(soql, /FROM Account/u);
    assert.match(soql, new RegExp(`${f.sendFeedback} = TRUE`, "u"));
    assert.match(soql, new RegExp(`${f.emailOptOut} = FALSE`, "u"));
    assert.match(soql, new RegExp(`${f.doNotContact} = FALSE`, "u"));
    assert.match(soql, new RegExp(`${f.aiInsights} = TRUE`, "u"));
  });
});

describe("week-window", () => {
  it("returns Monday..Sunday in UTC", () => {
    const w = isoWeekWindow(new Date("2026-04-30T12:00:00Z"));
    assert.equal(w.weekStart, "2026-04-27");
    assert.equal(w.weekEnd, "2026-05-03");
  });
});

describe("bedrock-email helpers", () => {
  it("hashes source data deterministically", () => {
    const a = { accountId: "1", x: 1 };
    const b = { accountId: "1", x: 1 };
    assert.equal(hashSourceData(a), hashSourceData(b));
  });

  it("includes the account JSON in the user message", () => {
    const msg = buildUserMessage({ accountId: "X" });
    assert.match(msg, /accountId/u);
  });

  it("parses fenced JSON output", () => {
    const out = parseModelOutput("```json\n{\"subject\":\"s\",\"html\":\"<p>h</p>\",\"markdown\":\"# m\"}\n```");
    assert.equal(out.subject, "s");
    assert.match(out.html, /<p>/u);
    assert.match(out.markdown, /^# m/u);
  });

  it("rejects missing fields", () => {
    assert.throws(() => parseModelOutput("{}"));
    assert.throws(() => parseModelOutput("not json"));
  });

  it("requires accountId in the input (account isolation)", async () => {
    await assert.rejects(generateWeeklyEmail({}, {}), /accountId/u);
  });
});

describe("gmail-draft helpers", () => {
  it("builds multipart MIME with subject and bodies", () => {
    const mime = buildMime({
      from: "checkins@hopewithlove.org",
      to: "v@hopewithlove.org",
      subject: "Test",
      htmlBody: "<p>Hi</p>",
    });
    assert.match(mime, /Content-Type: multipart\/alternative/u);
    assert.match(mime, /Subject: Test/u);
    assert.match(mime, /<p>Hi<\/p>/u);
  });

  it("base64url encoding has no =, +, or /", () => {
    const enc = base64UrlEncode("hello world?>");
    assert.doesNotMatch(enc, /[=+/]/u);
  });

  it("stripHtml removes tags", () => {
    assert.equal(stripHtml("<p>Hi <b>there</b></p>"), "Hi there");
  });
});

describe("orchestrator (dry run)", () => {
  it("returns plan for fixture accounts without external calls", async () => {
    const summary = await runWeeklyDrafts({
      dryRun: true,
      fixturePath: FIXTURE_PATH,
      nowIso: "2026-04-30T12:00:00Z",
      bedrockGenerate: async (acct) => ({
        subject: `Weekly check-in: ${acct.accountName}`,
        htmlBody: `<p>Hello ${acct.accountName}</p>`,
        markdownBody: `# ${acct.accountName}`,
        modelId: "anthropic.claude-sonnet-4-5",
        sourceDataHash: "deadbeef",
      }),
    });
    assert.equal(summary.dryRun, true);
    assert.equal(summary.totalEligible, 2);
    assert.equal(summary.weekStart, "2026-04-27");
    assert.equal(summary.weekEnd, "2026-05-03");
    assert.equal(summary.perAccount.length, 2);
    for (const a of summary.perAccount) assert.equal(a.status, "dry_run");
  });
});

describe("orchestrator (mocked live path)", () => {
  it("creates draft + history per account, isolating by accountId", async () => {
    const seenAccountsForBedrock = [];
    const seenAccountsForGmail = [];
    const seenAccountsForHistory = [];

    const fakeSf = {
      instanceUrl: "https://example.my.salesforce.com",
      accessToken: "fake",
    };

    const summary = await runWeeklyDrafts({
      dryRun: false,
      fixturePath: FIXTURE_PATH,
      nowIso: "2026-04-30T12:00:00Z",
      sf: fakeSf,
      existsForWeek: async () => false,
      recordWeeklyHistory: async (_sf, args) => {
        seenAccountsForHistory.push(args.accountId);
        return { recordId: `hd-${args.accountId}`, contentVersionId: null, contentDocumentId: null };
      },
      bedrockGenerate: async (acct) => {
        seenAccountsForBedrock.push(acct.accountId);
        if (!acct.accountId) throw new Error("missing accountId in bedrock input");
        return {
          subject: `Weekly: ${acct.accountName}`,
          htmlBody: `<p>${acct.accountName}</p>`,
          markdownBody: `# ${acct.accountName}`,
          modelId: "anthropic.claude-sonnet-4-5",
          sourceDataHash: `hash-${acct.accountId}`,
        };
      },
      gmailCreateDraft: async ({ accountId }) => {
        seenAccountsForGmail.push(accountId);
        return {
          draftId: `draft-${accountId}`,
          threadId: `thread-${accountId}`,
          messageId: `msg-${accountId}`,
        };
      },
    });

    const fs = require("fs");
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
    const fixtureIds = fixture.map((a) => a.Id);

    assert.equal(summary.draftsCreated, fixtureIds.length);
    assert.equal(summary.failed, 0);
    assert.deepEqual(seenAccountsForBedrock.slice().sort(), fixtureIds.slice().sort());
    assert.deepEqual(seenAccountsForGmail.slice().sort(), fixtureIds.slice().sort());
    assert.deepEqual(seenAccountsForHistory.slice().sort(), fixtureIds.slice().sort());
  });

  it("isolates failures (one account error does not block others)", async () => {
    const summary = await runWeeklyDrafts({
      dryRun: false,
      fixturePath: FIXTURE_PATH,
      nowIso: "2026-04-30T12:00:00Z",
      sf: { instanceUrl: "https://example.my.salesforce.com", accessToken: "fake" },
      existsForWeek: async () => false,
      recordWeeklyHistory: async (_sf, args) => ({
        recordId: `hd-${args.accountId}`,
        contentVersionId: null,
        contentDocumentId: null,
      }),
      bedrockGenerate: async (acct) => {
        if (acct.accountId === "001FIXTUREACCT01") throw new Error("boom");
        return {
          subject: "ok",
          htmlBody: "<p>ok</p>",
          markdownBody: "# ok",
          modelId: "anthropic.claude-sonnet-4-5",
          sourceDataHash: "h",
        };
      },
      gmailCreateDraft: async ({ accountId }) => ({
        draftId: `d-${accountId}`,
        threadId: `t-${accountId}`,
        messageId: `m-${accountId}`,
      }),
    });
    assert.equal(summary.failed, 1);
    assert.equal(summary.draftsCreated, 1);
  });

  it("skips accounts already drafted for the week", async () => {
    const summary = await runWeeklyDrafts({
      dryRun: false,
      fixturePath: FIXTURE_PATH,
      nowIso: "2026-04-30T12:00:00Z",
      sf: { instanceUrl: "https://example.my.salesforce.com", accessToken: "fake" },
      existsForWeek: async (_sf, accountId) => accountId === "001FIXTUREACCT01",
      recordWeeklyHistory: async (_sf, args) => ({
        recordId: `hd-${args.accountId}`,
        contentVersionId: null,
        contentDocumentId: null,
      }),
      bedrockGenerate: async () => ({
        subject: "s",
        htmlBody: "<p>h</p>",
        markdownBody: "# m",
        modelId: "anthropic.claude-sonnet-4-5",
        sourceDataHash: "h",
      }),
      gmailCreateDraft: async ({ accountId }) => ({
        draftId: `d-${accountId}`,
        threadId: `t-${accountId}`,
        messageId: `m-${accountId}`,
      }),
    });
    assert.equal(summary.skipped, 1);
    assert.equal(summary.draftsCreated, 1);
  });
});

describe("lambda handler (dry run)", () => {
  it("returns ok=true with per-account dry_run results", async () => {
    process.env.WEEKLY_DRAFTS_FIXTURE_PATH = FIXTURE_PATH;
    const out = await handler({
      dryRun: true,
      nowIso: "2026-04-30T12:00:00Z",
    });
    assert.equal(out.ok, true);
    assert.equal(out.dryRun, true);
    assert.equal(out.totalEligible, 2);
    assert.equal(out.weekStart, "2026-04-27");
  });
});
