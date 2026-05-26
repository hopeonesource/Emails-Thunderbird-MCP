# Hope1Source - Emails Thunderbird MCP & Weekly Check-in Drafts

[![Tools](https://img.shields.io/badge/35_Tools-email%2C_compose%2C_filters%2C_calendar%2C_contacts-blue.svg)](#thunderbird-mcp---what-you-can-do)
[![Localhost Only](https://img.shields.io/badge/Privacy-localhost_only-green.svg)](#thunderbird-mcp-security)
[![Thunderbird](https://img.shields.io/badge/Thunderbird-102%2B-0a84ff.svg)](https://www.thunderbird.net/)
[![License: MIT](https://img.shields.io/badge/License-MIT-grey.svg)](LICENSE)

This repository contains two related capabilities:

1. **Thunderbird MCP** -- a local extension + bridge that exposes 35 tools so any MCP-compatible AI assistant can read, compose, and organize Thunderbird mail.
2. **Weekly Check-in Email Drafts (V1)** -- an AWS Lambda pipeline that pulls eligible Service Provider Contacts from Salesforce via JWT/SOQL, groups them to one draft per Account, generates a polished mobile-friendly HTML email per Account using AWS Bedrock (Claude Sonnet 4.5), saves it as a Gmail draft from `checkins@hope1source.me`, updates the same latest `Historical_Data__c` record, attaches the email as Markdown, and stamps each recipient Contact's `Last_Feedback_Email_Sent__c` when the draft is created.

Jump to:

- [Weekly Check-in Email Drafts (V1)](#weekly-check-in-email-drafts-v1)
- [Thunderbird MCP](#thunderbird-mcp)

---

## Weekly Check-in Email Drafts (V1)

Tracked in Linear under [Weekly Check-in Email Drafts (V1)](https://linear.app/h1scheck-ins/project/weekly-check-in-email-drafts-v1-a17d99f5fb6b) (epic `HOP-43`).

### Architecture

```
+----------------+    +---------------------------+    +-----------------+    +----------------+
|  EventBridge   | -> |  Lambda: weekly-drafts-   | -> |  AWS Bedrock    |    | Gmail API      |
|  weekly cron   |    |  handler.handler          |    |  Claude Sonnet  |    | drafts.create  |
+----------------+    |                           |    |  4.5            |    | (gmail.compose)|
                      |  1. Salesforce JWT/SOQL   |    +-----------------+    +----------------+
                      |  2. Contact eligibility    |          ^                       ^
                      |  3. Per-account loop      |----------+                       |
                      |  4. Bedrock generate      |                                  |
                      |  5. Gmail draft           |----------------------------------+
                      |  6. Historical_Data__c    |          +-------------------------+
                      |     + Markdown attached   | -------> | Salesforce REST         |
                      +---------------------------+          | (Account, Files)        |
                                                             +-------------------------+
```

**Source of truth: Salesforce.** No DynamoDB in V1. No emails are auto-sent: a human reviews and sends each draft manually from Gmail.

### Account isolation invariants

Account isolation is the single most important property of this pipeline. Every step is keyed strictly by Salesforce `Account.Id`:

- The Bedrock prompt receives data for **one** account at a time and is told never to reference any other account.
- The Gmail draft is created with that account's data only and addressed to the eligible Service Provider Contact(s) on that Account.
- The latest `Historical_Data__c` record for that Account is updated in place and receives the Markdown attachment.
- A failure on one account never blocks any other account in the same weekly run.

### Eligibility filter

Eligibility starts from **Contact**. Eligible Service Provider Contacts are grouped to **one Gmail draft per Account**. If an Account has multiple eligible Service Provider Contacts, the draft is addressed to all of them.

| Object  | Field / rule                         | Required value       | Override env var                    |
|---------|--------------------------------------|----------------------|-------------------------------------|
| Contact | `RecordType.DeveloperName`           | `Service_Provider`   | `SF_SERVICE_PROVIDER_RECORD_TYPE`   |
| Account | `AI_Insights_Enabled__c`             | `TRUE`               | `SF_FIELD_ACCOUNT_AI_INSIGHTS`      |
| Contact | `Send_Feedback_Emails__c`            | `TRUE`               | `SF_FIELD_SEND_FEEDBACK`            |
| Contact | `npsp__Do_Not_Contact__c`            | `FALSE`              | `SF_FIELD_CONTACT_DO_NOT_CONTACT`   |
| Contact | standard `Email`                     | not null             | `SF_FIELD_CONTACT_EMAIL`            |

Reference SOQL:

```sql
SELECT Id, FirstName, LastName, Email,
       AccountId, Account.Name, Account.AI_Insights_Enabled__c,
       Send_Feedback_Emails__c, npsp__Do_Not_Contact__c,
       RecordType.DeveloperName, Last_Feedback_Email_Sent__c
FROM Contact
WHERE RecordType.DeveloperName = 'Service_Provider'
  AND Account.AI_Insights_Enabled__c = TRUE
  AND Send_Feedback_Emails__c = TRUE
  AND npsp__Do_Not_Contact__c = FALSE
  AND Email != NULL
```

### `Historical_Data__c` record

Per Account, the Lambda reads the **latest existing** `Historical_Data__c` record and uses it as the source for rollup metrics:

- `Date_of_Generation__c`, `Account__c`
- `Total_Feedback__c`, `Feedback_Last_7_Days__c`, `Feedback_Last_30_Days__c`
- `Avg_Rating_All_Time__c`, `Last_7_Days_Rating_Avg__c`
- `Weekly_Last_7_Days_Change__c`, `Weekly_Last_7_Days_Rating_Change__c`
- `Total_of_5_Star_Reviews__c`, `Weekly_5_Star_Review_Change__c`

After the Gmail draft is created, the same `Historical_Data__c` record is updated in place with:

| Field (default)            | Type   | Description                                                |
|----------------------------|--------|------------------------------------------------------------|
| `Week_Start__c`            | Date   | Optional ISO Monday of the week, only if configured        |
| `Week_End__c`              | Date   | Optional ISO Sunday of the week, only if configured        |
| `Gmail_Draft_Id__c`        | Text   | Gmail draft id (for the human reviewer)                    |
| `Gmail_Thread_Id__c`       | Text   | Gmail thread id                                            |
| `Bedrock_Model__c`         | Text   | Model id (e.g. `anthropic.claude-sonnet-4-5`)              |
| `Source_Data_Hash__c`      | Text   | SHA-256 of the input metrics for idempotency / audit       |
| `Status__c`                | Text   | `draft_created`, `sent`, `failed`, `skipped`               |

The full email body is attached to the same `Historical_Data__c` row as a Salesforce **File (ContentVersion)** named `weekly-checkin-email-<weekStart>.md`. Override field API names via `SF_HD_*` envs.

**Idempotency:** before creating a draft, the Lambda queries for an existing `Historical_Data__c` with `(Account__c = X, Date_of_Generation__c = LAST_N_DAYS:7, Status__c IN ('draft_created','sent'))`. If found, it skips that account. Tune the window with `SF_HD_IDEMPOTENCY_WINDOW_DAYS`.

### Recent client feedback source

Individual quotes and sample ratings come from `Service_Provider_Feedback__c`, scoped by Account and client-submitted records:

```sql
SELECT Id, Account__c, Contact__c, Submission_Date__c,
       Rating__c, Description__c,
       How_Hopeful_Are_You__c, What_would_make_you_more_hopeful__c
FROM Service_Provider_Feedback__c
WHERE Account__c = '<AccountId>'
  AND Contact__r.RecordType.DeveloperName = 'Client'
  AND Submission_Date__c = LAST_N_DAYS:7
ORDER BY Submission_Date__c DESC
LIMIT 25
```

After draft creation, each eligible recipient Contact is stamped with `Last_Feedback_Email_Sent__c = TODAY`.

### File layout (V1)

```
pipeline/
  weekly-drafts-handler.js                # Lambda entry point
  lib/
    salesforce-jwt.cjs                    # existing JWT auth (unchanged)
    sf-rest.cjs                           # SOQL + sObject create + File upload
    eligibility.cjs                       # Contact eligibility filter / one draft per Account grouping
    bedrock-email.cjs                     # Bedrock Sonnet 4.5 HTML email generator
    google-jwt.cjs                        # Google service-account JWT (DWD)
    gmail-draft.cjs                       # Gmail draft (drafts.create only - never send)
    historical-data.cjs                   # Historical_Data__c writeback + Markdown file
    week-window.cjs                       # ISO week window helper
    run-weekly-drafts.cjs                 # Orchestrator
fixtures/
  weekly-eligible-accounts.json           # Dry-run sample
test/
  weekly-drafts.test.cjs                  # Unit tests (mocked Bedrock/Gmail/Salesforce)
```

### Setup

#### 1. Salesforce (already in place)

The existing JWT/SOQL Connected App is reused. Confirm the integration user has:

- Read on `Contact`, `Account`, `Historical_Data__c`, and `Service_Provider_Feedback__c`
- Update on `Historical_Data__c` and `Contact.Last_Feedback_Email_Sent__c`
- Create on `ContentVersion` / Salesforce Files
- Profile/permission set granted on the Connected App

If your eligibility, feedback, or `Historical_Data__c` field API names differ from the defaults, set the `SF_FIELD_*`, `SF_FEEDBACK_*`, and `SF_HD_*` env vars (see `.env.example`).

#### 2. Google Workspace for Nonprofits

Create a Google Cloud project under the Workspace org and:

1. **Enable** the Gmail API.
2. Create a **service account**. Generate a JSON key.
3. In Workspace Admin (`admin.google.com`) **Security > Access and data control > API controls > Domain-wide delegation**, add the service account's client ID with the single scope:
   - `https://www.googleapis.com/auth/gmail.compose`
4. Make sure `checkins@hope1source.me` is a real, monitored Workspace mailbox in `hope1source.me`.
5. Set in Lambda env:
   - `GOOGLE_SECRET_ID=hope1source/google-service-account` for Secrets Manager loading
   - `GMAIL_SUBJECT=checkins@hope1source.me`
   - `GMAIL_FROM=Hope1Source Check-ins <checkins@hope1source.me>`
   - `GMAIL_REVIEW_RECIPIENT=Tim@hopewithlove.org,fadames@hopewithlove.org,vthornton@hopewithlove.org` for fixture smoke tests

> **Why `gmail.compose` only?** This scope can read and write the user's drafts but **cannot send mail**. This is the smallest scope that lets the Lambda create drafts safely. A human still has to click Send in Gmail.

#### 3. AWS Bedrock

1. In the AWS console, **request access** to `anthropic.claude-sonnet-4-5` in the region you plan to use (e.g. `us-east-1`).
2. Set `BEDROCK_MODEL_ID` if you want to override the default. Set `AWS_REGION` (already set in Lambda automatically).

#### 4. AWS Lambda (V1)

- Runtime: `nodejs20.x`
- Handler: `pipeline/weekly-drafts-handler.handler`
- Memory: 512 MB (Bedrock invocation is light; bump to 1024 MB if you add attachments)
- Timeout: 5 minutes
- Trigger: EventBridge Scheduler, weekly (e.g. `cron(0 13 ? * MON *)` UTC = 09:00 ET Mondays)

**IAM role (least privilege):**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["bedrock:InvokeModel"],
      "Resource": "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5" },
    { "Effect": "Allow", "Action": ["secretsmanager:GetSecretValue"],
      "Resource": [
        "arn:aws:secretsmanager:us-east-1:<acct>:secret:hope1source/salesforce-*",
        "arn:aws:secretsmanager:us-east-1:<acct>:secret:hope1source/google-*"
      ] },
    { "Effect": "Allow", "Action": ["logs:CreateLogStream","logs:PutLogEvents"],
      "Resource": "arn:aws:logs:us-east-1:<acct>:log-group:/aws/lambda/hope1source-weekly-drafts:*" }
  ]
}
```

#### 5. Secrets

| Secret                       | Storage                                  |
|------------------------------|------------------------------------------|
| Salesforce Connected App key | AWS Secrets Manager `hope1source/salesforce-jwt` |
| Google service account key   | AWS Secrets Manager `hope1source/google-service-account` |
| Bedrock                      | IAM role only -- no static keys          |

Loader convention: set `GOOGLE_SECRET_ID`, `SF_SECRET_ID`, or comma-separated `WEEKLY_DRAFTS_SECRET_IDS` on the Lambda. At startup, the handler reads those AWS Secrets Manager JSON secrets and exposes only approved keys through `process.env`. Keep non-secret config such as `GMAIL_SUBJECT`, `GMAIL_FROM`, `BEDROCK_REGION`, and `BEDROCK_MODEL_ID` as Lambda environment variables.

Example Google secret JSON:

```json
{
  "GOOGLE_SERVICE_ACCOUNT_EMAIL": "weekly-drafts@project.iam.gserviceaccount.com",
  "GOOGLE_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"
}
```

### Local development & dry-run

```bash
npm install
npm run test:weekly-drafts          # all unit tests, no network
npm run weekly-drafts:dry           # full dry run with the bundled fixture
npm run package:weekly-drafts       # build Lambda zip for Bedrock + Gmail smoke testing
```

Dry-run does not call Bedrock, Gmail, or Salesforce. It produces a deterministic stub HTML/Markdown body from the fixture so you can iterate on the orchestrator and downstream wiring without credentials.

While Salesforce sandbox is not ready, use fixture draft mode to call live Bedrock and create real Gmail drafts without Salesforce reads or writes. See [docs/weekly-drafts-live-readiness.md](docs/weekly-drafts-live-readiness.md).

### Operations

- **Logs:** CloudWatch log group `/aws/lambda/hope1source-weekly-drafts`. Per-account log line on success/skip/failure.
- **Failure isolation:** one account's failure increments `summary.failed` but never blocks the others. The handler returns `ok: false` if any account failed so you can alarm on it.
- **Alarms:** create a CloudWatch metric filter on `"failed":` > 0 in the handler return JSON, or on `Errors > 0` for the function.
- **Idempotency:** safe to re-run within the same week. Existing draft_created/sent rows are skipped.
- **Manual invoke:** send `{ "dryRun": true }` to test against the bundled fixture, or `{ "fixtureDraftOnly": true, "reviewRecipient": "Tim@hopewithlove.org,fadames@hopewithlove.org,vthornton@hopewithlove.org" }` to create real Gmail drafts from fixture data without touching Salesforce.

### Security best practices (V1)

- **Least-privilege IAM** as above; scope Bedrock to the specific model ARN.
- **Drafts only.** Gmail scope is `gmail.compose`, not `gmail.send`.
- **No PII in logs.** Log only `accountId`, status, model id, draft id, and hashes -- never email body or check-in payloads.
- **Account isolation.** Bedrock prompt receives data for one account at a time; tests assert no cross-account bleed.
- **Idempotency by `Historical_Data__c` status + `Source_Data_Hash__c`.** If the same week's input hasn't changed, you can detect re-runs.
- **Secrets in Secrets Manager.** `.env` only ever holds dev values; real values never enter the repo.
- **Network egress.** Lambda only needs outbound HTTPS to Salesforce, Google, and Bedrock VPC endpoint (or public Bedrock endpoint).

### Troubleshooting

| Symptom                                                | Likely cause                                                                              |
|--------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `Salesforce token error HTTP 400`                      | JWT iss/sub/aud mismatch, or the Connected App is not pre-authorized for the integration user |
| `Salesforce SOQL failed HTTP 401`                      | Access token expired or instance URL mismatched                                           |
| `Salesforce SOQL failed ... INVALID_FIELD`             | Field API names in your org differ from defaults -- set `SF_FIELD_*` envs                 |
| `Google token error ... unauthorized_client`           | Service account is missing domain-wide delegation for the `gmail.compose` scope           |
| `Gmail draft create failed HTTP 403`                   | Subject mailbox is not in the Workspace, or DWD is missing                                |
| `Bedrock InvokeModel ... AccessDenied`                 | Model access not approved in this region, or IAM role missing `bedrock:InvokeModel`       |
| Re-run produces no drafts                              | Idempotency: existing `Historical_Data__c` row for the week. Update or delete and retry.  |

### Future (V2)

- Reply ingestion + DynamoDB Q&A scoped strictly by Salesforce `Account.Id` (mapped via the replying Contact).
- Track replies/threads on `Historical_Data__c` and surface them in Salesforce.

---

## Thunderbird MCP

[![Tools](https://img.shields.io/badge/35_Tools-email%2C_compose%2C_filters%2C_calendar%2C_contacts-blue.svg)](#thunderbird-mcp---what-you-can-do)

Give your AI assistant full access to Thunderbird -- search mail, compose messages, manage filters, and organize your inbox. All through the [Model Context Protocol](https://modelcontextprotocol.io/).

<p align="center">
  <img src="docs/demo.gif" alt="Thunderbird MCP Demo" width="600">
</p>

> Inspired by [bb1/thunderbird-mcp](https://github.com/bb1/thunderbird-mcp). Rewritten from scratch with a bundled HTTP server, proper MIME decoding, and UTF-8 handling throughout.

### Thunderbird MCP - Why?

Thunderbird has no official API for AI tools. Your AI assistant can't read your email, can't help you draft replies, can't organize your inbox. This extension fixes that -- it exposes 35 tools over MCP so any compatible AI (Claude, GPT, local models) can work with your mail the way you'd expect.

Compose tools open a review window before sending by default. Set `skipReview` to send directly when you've already approved the content upstream. **Nothing gets sent without your approval.**

---

## How it works

```
                    stdio              HTTP (localhost:8765-8774)
  MCP Client  <----------->  Bridge  <--------------------->  Thunderbird
  (Claude, etc.)           mcp-bridge.cjs                    Extension + HTTP Server
```

The Thunderbird extension embeds a local HTTP server with session-scoped auth tokens. The Node.js bridge translates between MCP's stdio protocol and HTTP, discovering the port and token automatically via a connection file. The bridge handles MCP lifecycle methods (initialize, ping) locally, so clients can connect even before Thunderbird is fully loaded.

---

## Thunderbird MCP - What you can do

### Mail

| Tool | Description |
|------|-------------|
| `listAccounts` | List all email accounts and their identities |
| `listFolders` | Browse folder tree with message counts -- filter by account or subtree |
| `searchMessages` | Search by subject, sender, recipient, body preview, date range, or tags. Set `searchBody: true` for full-text body search via Thunderbird's Gloda index. Supports `includeSubfolders`, `countOnly`, and offset-based pagination. Results include `threadId` and `preview` snippet. |
| `getMessage` | Read full email content -- `bodyFormat`: `markdown` (default), `text`, or `html`. Set `rawSource: true` for the complete RFC 2822 source (all headers + MIME parts). Optional attachment saving. Includes inline CID images. |
| `getRecentMessages` | Get recent messages with date, unread, and tag filtering. Supports pagination. Results include `threadId` and `preview`. |
| `displayMessage` | Open a message in Thunderbird's GUI -- `3pane` (default), `tab`, or `window` mode |
| `updateMessage` | Mark read/unread, flag/unflag, add/remove tags, move between folders, or trash -- supports bulk via `messageIds` |
| `deleteMessages` | Delete messages -- drafts are safely moved to Trash |
| `createFolder` | Create new subfolders to organize your mail |
| `renameFolder` | Rename an existing mail folder |
| `deleteFolder` | Delete a folder (moves to Trash, or permanently deletes if already in Trash) |
| `moveFolder` | Move a folder to a new parent within the same account |
| `emptyTrash` | Permanently delete all messages in Trash (including subfolders) |
| `emptyJunk` | Permanently delete all messages in Junk/Spam (including subfolders) |

### Compose

| Tool | Description |
|------|-------------|
| `sendMail` | Compose a new email -- opens a review window, or set `skipReview` to send directly |
| `replyToMessage` | Reply with quoted original and proper threading -- supports `skipReview` |
| `forwardMessage` | Forward with all original attachments preserved -- supports `skipReview` |

All compose tools open a window for you to review and edit before sending by default. Set `skipReview: true` to send directly when you've already approved the content. Attachments can be file paths or inline base64 objects.

Compose tools validate the `from` identity strictly -- if the specified sender doesn't match any configured Thunderbird identity, the tool returns an error instead of silently substituting another account.

### Filters

| Tool | Description |
|------|-------------|
| `listFilters` | List all filter rules with human-readable conditions and actions |
| `createFilter` | Create filters with structured conditions (from, subject, date...) and actions (move, tag, flag...) |
| `updateFilter` | Modify a filter's name, enabled state, conditions, or actions |
| `deleteFilter` | Remove a filter by index |
| `reorderFilters` | Change filter execution priority |
| `applyFilters` | Run filters on a folder on demand -- let your AI organize your inbox |

Full control over Thunderbird's message filters. Changes persist immediately. Your AI can create sorting rules, adjust priorities, and run them on existing mail.

### Contacts

| Tool | Description |
|------|-------------|
| `searchContacts` | Search contacts across all address books by email or name. Supports `maxResults`. |
| `createContact` | Create a new contact in any writable address book |
| `updateContact` | Update an existing contact's email, name, or display name |
| `deleteContact` | Delete a contact by UID |

### Calendar

| Tool | Description |
|------|-------------|
| `listCalendars` | List all calendars with read-only, event, and task support flags |
| `createEvent` | Create a calendar event -- opens a review dialog, or set `skipReview` to add directly |
| `listEvents` | Query events by date range with recurring event expansion |
| `updateEvent` | Modify an event's title, dates, location, or description |
| `deleteEvent` | Delete a calendar event by ID |
| `createTask` | Open a pre-filled task dialog for review |
| `listTasks` | List tasks/to-dos from calendars -- filter by completion status, due date, or calendar |

### Access Control

| Tool | Description |
|------|-------------|
| `getAccountAccess` | View which accounts the MCP server can access |

Account and tool access are configured via the extension settings page (Tools > Add-ons > Thunderbird MCP > Options). Access control is not MCP-exposed -- only the user can change it.

---

## Setup

### 1. Install the extension

```bash
git clone https://github.com/TKasperczyk/thunderbird-mcp.git
```

Install `dist/thunderbird-mcp.xpi` in Thunderbird (Tools > Add-ons > Install from File), then restart. A pre-built XPI is included in the repo -- no build step needed.

### 2. Configure your MCP client

Add to your MCP client config (e.g. `~/.claude.json` for Claude Code):

```json
{
  "mcpServers": {
    "thunderbird-mail": {
      "command": "node",
      "args": ["/absolute/path/to/thunderbird-mcp/mcp-bridge.cjs"]
    }
  }
}
```

That's it. Your AI can now access Thunderbird.

---

## Thunderbird MCP security

- **Auth tokens**: The HTTP server requires a session-scoped bearer token. Generated on startup, written to `<TmpD>/thunderbird-mcp/connection.json` with 0600 permissions. The bridge reads this automatically.
- **Dynamic port**: Tries ports 8765-8774, records the actual port in the connection file. No hardcoded port dependency.
- **Account access control**: Restrict which email accounts are visible to MCP clients via the settings page. Changes take effect immediately.
- **Tool access control**: Disable specific tools via the settings page. Disabled tools are hidden from `tools/list` and blocked at dispatch.
- **Localhost only**: No remote access. The bridge fails closed -- refuses to forward requests without a valid token.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Extension not loading | Check Tools > Add-ons and Themes. Errors: Tools > Developer Tools > Error Console |
| Connection refused | Make sure Thunderbird is running and the extension is enabled |
| Missing recent emails | IMAP folders can be stale. Click the folder in Thunderbird to sync, or right-click > Properties > Repair Folder |
| Tool not found after update | Reconnect MCP (`/mcp` in Claude Code) to pick up new tools |
| `searchBody` returns no results | IMAP accounts need offline sync enabled for Gloda to index message bodies |
| `rawSource` fails on IMAP | Requires local/offline message copy. Enable offline sync or click the message first to cache it. |

---

## Development

```bash
# Build the extension
./scripts/build.sh

# Test via the bridge (handles auth automatically)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp-bridge.cjs

# Test the HTTP API directly (requires auth token from connection file)
TOKEN=$(cat /tmp/thunderbird-mcp/connection.json | jq -r .token)
PORT=$(cat /tmp/thunderbird-mcp/connection.json | jq -r .port)
curl -X POST http://127.0.0.1:$PORT \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

After changing extension code: remove from Thunderbird, restart, reinstall the XPI, restart again. Thunderbird caches aggressively.

**AWS Lambda (ingest zip):** run `npm run package:lambda` to create `dist/lambda-ingest.zip`, then follow [docs/lambda-zip-deploy.md](docs/lambda-zip-deploy.md) to upload it in the Lambda console.

---

## Project structure

```
thunderbird-mcp/
├── mcp-bridge.cjs              # stdio <-> HTTP bridge (auth, port discovery)
├── extension/
│   ├── manifest.json
│   ├── background.js           # Extension entry point
│   ├── httpd.sys.mjs           # Embedded HTTP server (Mozilla)
│   ├── options.html            # Settings page UI
│   ├── options.js              # Settings page logic
│   ├── icons/                  # Extension icons
│   └── mcp_server/
│       ├── api.js              # All 35 MCP tools + auth + access control
│       └── schema.json
├── test/                       # Test suite (node:test, zero dependencies)
└── scripts/
    ├── build.sh
    └── install.sh
```

## Known issues

- IMAP folder databases can be stale until you click on them in Thunderbird
- HTML-only emails are converted to plain text (original formatting is lost)
- Recurring calendar event CRUD operates on the series, not individual occurrences
- IMAP folder operations (rename, delete, move) are async -- verify with `listFolders` after
- Combining tags with move/trash on IMAP may not preserve tags on the moved copy -- use separate calls
- Pre-existing Thunderbird filters with cross-account move/copy targets are not restricted by account access control
- `searchBody` on IMAP without offline sync only searches headers (Gloda limitation)
- `rawSource` requires offline message copy for IMAP -- online-only messages will error

---

## License

MIT. The bundled `httpd.sys.mjs` is from Mozilla and licensed under MPL-2.0.
