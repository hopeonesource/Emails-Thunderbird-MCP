"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  runWeeklyDrafts,
  buildAccountWeeklyData,
  resolveDraftRecipients,
  applyAccountAllowlist,
} = require("../pipeline/lib/run-weekly-drafts.cjs");
const { handler } = require("../pipeline/weekly-drafts-handler.js");
const {
  isEligible,
  buildEligibilitySoql,
  fieldNames,
  groupEligibleContactsByAccount,
} = require("../pipeline/lib/eligibility.cjs");
const { isoWeekWindow } = require("../pipeline/lib/week-window.cjs");
const {
  parseModelOutput,
  hashSourceData,
  buildUserMessage,
  generateWeeklyEmail,
} = require("../pipeline/lib/bedrock-email.cjs");
const {
  secretIdsFromEnv,
  loadAwsSecretsIntoEnv,
} = require("../pipeline/lib/aws-secrets-env.cjs");
const { buildMime, base64UrlEncode, stripHtml } = require("../pipeline/lib/gmail-draft.cjs");
const { fieldNames: historicalFieldNames } = require("../pipeline/lib/historical-data.cjs");

const FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "weekly-eligible-accounts.json");

describe("eligibility", () => {
  const f = fieldNames();

  it("requires Service Provider Contact gates plus Account AI insights", () => {
    const ok = {
      [f.sendFeedback]: true,
      [f.contactDoNotContact]: false,
      [f.contactEmail]: "provider@example.org",
      RecordType: { DeveloperName: "Service_Provider" },
      Account: { [f.accountAiInsights]: true },
    };
    assert.equal(isEligible(ok), true);
    assert.equal(isEligible({ ...ok, [f.sendFeedback]: false }), false);
    assert.equal(isEligible({ ...ok, [f.contactDoNotContact]: true }), false);
    assert.equal(isEligible({ ...ok, [f.contactEmail]: null }), false);
    assert.equal(isEligible({ ...ok, RecordType: { DeveloperName: "Client" } }), false);
    assert.equal(isEligible({ ...ok, Account: { [f.accountAiInsights]: false } }), false);
  });

  it("builds a Contact eligibility SOQL with all gates", () => {
    const soql = buildEligibilitySoql();
    assert.match(soql, /FROM Contact/u);
    assert.match(soql, /RecordType\.DeveloperName = 'Service_Provider'/u);
    assert.match(soql, new RegExp(`Account.${f.accountAiInsights} = TRUE`, "u"));
    assert.match(soql, new RegExp(`${f.sendFeedback} = TRUE`, "u"));
    assert.match(soql, new RegExp(`${f.contactDoNotContact} = FALSE`, "u"));
    assert.match(soql, new RegExp(`${f.contactEmail} != NULL`, "u"));
  });

  it("groups multiple eligible contacts into one account draft context", () => {
    const grouped = groupEligibleContactsByAccount([
      {
        Id: "003A",
        FirstName: "A",
        LastName: "One",
        Email: "a@example.org",
        AccountId: "001X",
        Account: { Name: "Org X" },
      },
      {
        Id: "003B",
        FirstName: "B",
        LastName: "Two",
        Email: "b@example.org",
        AccountId: "001X",
        Account: { Name: "Org X" },
      },
    ]);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].Id, "001X");
    assert.equal(grouped[0].recipients.length, 2);
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

  it("does not pass recipient emails or raw Salesforce records to Bedrock", () => {
    const data = buildAccountWeeklyData(
      {
        Id: "001X",
        Name: "Bethel Cafe",
        recipients: [{ contactId: "003X", email: "provider@example.org" }],
      },
      "2026-05-18",
      "2026-05-24",
      {
        Id: "a10X",
        Account__c: "001X",
        Gmail_Draft_Id__c: "draft-old",
        Total_Feedback__c: 7,
      },
      [
        {
          Id: "a20X",
          Contact__c: "003CLIENT",
          Submission_Date__c: "2026-05-19",
          Rating__c: 5,
          Description__c: "Helpful follow-up",
        },
      ]
    );
    const serialized = JSON.stringify(data);
    assert.equal(data.accountId, "001X");
    assert.equal(data.serviceProviderRecipientCount, 1);
    assert.doesNotMatch(serialized, /provider@example\.org/u);
    assert.doesNotMatch(serialized, /003CLIENT/u);
    assert.doesNotMatch(serialized, /draft-old/u);
    assert.match(serialized, /Helpful follow-up/u);
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
      from: "checkins@hope1source.me",
      to: "reviewer@example.org",
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
  it("requires an account allowlist before non-dry-run execution", async () => {
    const previous = process.env.HOP43_ALLOW_BROAD_RUN;
    delete process.env.HOP43_ALLOW_BROAD_RUN;
    try {
      await assert.rejects(
        runWeeklyDrafts({
          dryRun: false,
          fixturePath: FIXTURE_PATH,
          sf: { instanceUrl: "https://example.my.salesforce.com", accessToken: "fake" },
        }),
        /HOP43_ALLOWED_ACCOUNT/u
      );
    } finally {
      if (previous === undefined) delete process.env.HOP43_ALLOW_BROAD_RUN;
      else process.env.HOP43_ALLOW_BROAD_RUN = previous;
    }
  });

  it("filters to Bethel Cafe by allowlisted account name", () => {
    const filtered = applyAccountAllowlist(
      [
        { Id: "001A", Name: "Bethel Cafe" },
        { Id: "001B", Name: "Other Org" },
      ],
      { allowedAccountNames: "Bethel Cafe" }
    );
    assert.deepEqual(filtered.map((a) => a.Id), ["001A"]);
  });

  it("routes drafts to GMAIL_REVIEW_RECIPIENT when configured", () => {
    const previous = process.env.GMAIL_REVIEW_RECIPIENT;
    process.env.GMAIL_REVIEW_RECIPIENT = "reviewer@example.org, reviewer2@example.org";
    try {
      assert.deepEqual(
        resolveDraftRecipients(
          { recipients: [{ email: "real.provider@example.org" }] },
          "001X",
          {}
        ),
        ["reviewer@example.org", "reviewer2@example.org"]
      );
    } finally {
      if (previous === undefined) delete process.env.GMAIL_REVIEW_RECIPIENT;
      else process.env.GMAIL_REVIEW_RECIPIENT = previous;
    }
  });

  it("requires reviewer routing before account-recipient drafting", () => {
    const previous = process.env.GMAIL_REVIEW_RECIPIENT;
    delete process.env.GMAIL_REVIEW_RECIPIENT;
    try {
      assert.throws(
        () => resolveDraftRecipients({ recipients: [{ email: "real.provider@example.org" }] }, "001X", {}),
        /GMAIL_REVIEW_RECIPIENT/u
      );
    } finally {
      if (previous === undefined) delete process.env.GMAIL_REVIEW_RECIPIENT;
      else process.env.GMAIL_REVIEW_RECIPIENT = previous;
    }
  });

  it("fixtureDraftOnly creates drafts without Salesforce writeback", async () => {
    const previousReviewRecipient = process.env.GMAIL_REVIEW_RECIPIENT;
    process.env.GMAIL_REVIEW_RECIPIENT = "reviewer@example.org";
    try {
      const summary = await runWeeklyDrafts({
        fixtureDraftOnly: true,
        fixturePath: FIXTURE_PATH,
        allowedAccountIds: "001FIXTUREACCT01",
        nowIso: "2026-04-30T12:00:00Z",
        recordWeeklyHistory: async () => {
          throw new Error("Salesforce writeback should be skipped in fixtureDraftOnly");
        },
        bedrockGenerate: async (acct) => ({
          subject: `Weekly: ${acct.accountName}`,
          htmlBody: `<p>${acct.accountName}</p>`,
          markdownBody: `# ${acct.accountName}`,
          modelId: "anthropic.claude-sonnet-4-5",
          sourceDataHash: `hash-${acct.accountId}`,
        }),
        gmailCreateDraft: async ({ accountId, to }) => {
          assert.equal(accountId, "001FIXTUREACCT01");
          assert.deepEqual(to, ["reviewer@example.org"]);
          return { draftId: `draft-${accountId}`, threadId: `thread-${accountId}` };
        },
      });
      assert.equal(summary.totalEligible, 1);
      assert.equal(summary.draftsCreated, 1);
      assert.equal(summary.perAccount[0].status, "fixture_draft_created");
      assert.equal(summary.perAccount[0].historicalDataId, undefined);
    } finally {
      if (previousReviewRecipient === undefined) delete process.env.GMAIL_REVIEW_RECIPIENT;
      else process.env.GMAIL_REVIEW_RECIPIENT = previousReviewRecipient;
    }
  });

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
      allowedAccountIds: "001FIXTUREACCT01,001FIXTUREACCT02",
      allowAccountRecipients: true,
      nowIso: "2026-04-30T12:00:00Z",
      sf: fakeSf,
      existsForWeek: async () => false,
      recordWeeklyHistory: async (_sf, args) => {
        seenAccountsForHistory.push({ accountId: args.accountId, historicalDataId: args.historicalDataId });
        return { recordId: `hd-${args.accountId}`, contentVersionId: null, contentDocumentId: null };
      },
      stampFeedbackEmailSent: async () => {
        throw new Error("Contact stamping should be opt-in only");
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
    assert.deepEqual(seenAccountsForHistory.map((h) => h.accountId).sort(), fixtureIds.slice().sort());
    assert.deepEqual(seenAccountsForHistory.map((h) => h.historicalDataId), [undefined, undefined]);
  });

  it("isolates failures (one account error does not block others)", async () => {
    const summary = await runWeeklyDrafts({
      dryRun: false,
      fixturePath: FIXTURE_PATH,
      allowedAccountIds: "001FIXTUREACCT01,001FIXTUREACCT02",
      allowAccountRecipients: true,
      nowIso: "2026-04-30T12:00:00Z",
      sf: { instanceUrl: "https://example.my.salesforce.com", accessToken: "fake" },
      existsForWeek: async () => false,
      stampFeedbackEmailSent: async () => {},
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
      allowedAccountIds: "001FIXTUREACCT01,001FIXTUREACCT02",
      allowAccountRecipients: true,
      nowIso: "2026-04-30T12:00:00Z",
      sf: { instanceUrl: "https://example.my.salesforce.com", accessToken: "fake" },
      existsForWeek: async (_sf, accountId) => accountId === "001FIXTUREACCT01",
      stampFeedbackEmailSent: async () => {},
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

describe("Historical_Data__c writeback", () => {
  it("does not require optional draft metadata fields by default", () => {
    const f = historicalFieldNames();
    assert.equal(f.draftId, "");
    assert.equal(f.threadId, "");
    assert.equal(f.model, "");
    assert.equal(f.hash, "");
    assert.equal(f.status, "");
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

describe("AWS Secrets Manager env loader", () => {
  it("uses HOP-43 secret names by default", () => {
    assert.deepEqual(secretIdsFromEnv({}), [
      "hope1source/hop43/salesforce-jwt",
      "hope1source/hop43/google-service-account",
    ]);
  });

  it("loads JSON secret values into the provided env without printing them", async () => {
    class FakeCommand {
      constructor(input) {
        this.input = input;
      }
    }
    const calls = [];
    const client = {
      async send(cmd) {
        calls.push(cmd.input.SecretId);
        return {
          SecretString: JSON.stringify(
            cmd.input.SecretId.includes("salesforce")
              ? { SF_CLIENT_ID: "client", SF_PRIVATE_KEY: "sf-key" }
              : { GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.org", GOOGLE_PRIVATE_KEY: "google-key" }
          ),
        };
      },
    };
    const env = { HOP43_SECRET_SOURCE: "aws", AWS_REGION: "us-east-1" };

    const result = await loadAwsSecretsIntoEnv({
      env,
      client,
      GetSecretValueCommandCtor: FakeCommand,
    });

    assert.equal(result.loaded, true);
    assert.deepEqual(calls, [
      "hope1source/hop43/salesforce-jwt",
      "hope1source/hop43/google-service-account",
    ]);
    assert.equal(env.SF_CLIENT_ID, "client");
    assert.equal(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, "svc@example.org");
  });
});
