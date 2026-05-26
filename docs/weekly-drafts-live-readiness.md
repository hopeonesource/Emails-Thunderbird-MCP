# Weekly Drafts Live-Readiness

This checklist covers the HOP-43 sandbox path while Salesforce is not ready yet:
use fixture account data, invoke live Bedrock, and create real Gmail drafts in
`checkins@hope1source.me`. No Salesforce reads or writes run in this mode.

## Build the Lambda zip

From the repository root:

```bash
npm install
npm run package:weekly-drafts
```

This creates `dist/lambda-weekly-drafts.zip` with `pipeline/`, `fixtures/`, and
installed Node dependencies.

## Lambda configuration

- Region: `us-east-1`
- Runtime: Node.js 20.x or newer
- Handler: `pipeline/weekly-drafts-handler.handler`
- Memory: 512 MB
- Timeout: 5 minutes

Required environment for the fixture-to-draft smoke test:

```text
AWS_REGION=us-east-1
BEDROCK_REGION=us-east-1
BEDROCK_MODEL_ID=anthropic.claude-sonnet-4-5
GMAIL_SUBJECT=checkins@hope1source.me
GMAIL_FROM=Hope1Source Check-ins <checkins@hope1source.me>
GMAIL_REVIEW_RECIPIENT=Tim@hopewithlove.org,fadames@hopewithlove.org,vthornton@hopewithlove.org
GOOGLE_SECRET_ID=hope1source/google-service-account
WEEKLY_DRAFTS_FIXTURE_PATH=/var/task/fixtures/weekly-eligible-accounts.json
WEEKLY_DRAFTS_FIXTURE_DRAFT_ONLY=true
```

The Lambda role needs `bedrock:InvokeModel` for the configured model and normal
CloudWatch Logs permissions. It also needs `secretsmanager:GetSecretValue` for
the configured Google secret. Bedrock uses IAM only; there is no Bedrock secret.

## Secrets Manager

Use AWS Secrets Manager for private keys. Do not store private keys directly in
Lambda environment variables.

Create `hope1source/google-service-account` as a JSON secret:

```json
{
  "GOOGLE_SERVICE_ACCOUNT_EMAIL": "weekly-drafts@project.iam.gserviceaccount.com",
  "GOOGLE_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"
}
```

When Salesforce sandbox is ready, create `hope1source/salesforce-jwt` as a JSON
secret with `SF_CLIENT_ID`, `SF_USERNAME`, `SF_PRIVATE_KEY`, and
`SF_LOGIN_URL=https://test.salesforce.com`, then set `SF_SECRET_ID` on the
Lambda.

## Google setup

The Google service account must have domain-wide delegation for this exact scope:

```text
https://www.googleapis.com/auth/gmail.compose
```

`gmail.compose` can create and edit drafts, but it cannot send mail.

## Test event

Use this event to create real Gmail drafts from the packaged fixture without
touching Salesforce:

```json
{
  "fixtureDraftOnly": true,
  "fixturePath": "/var/task/fixtures/weekly-eligible-accounts.json",
  "reviewRecipient": "Tim@hopewithlove.org,fadames@hopewithlove.org,vthornton@hopewithlove.org"
}
```

Expected result:

- `ok` is `true`.
- `fixtureDraftOnly` is `true`.
- `draftsCreated` matches the fixture account count.
- Each `perAccount` item has `status: "draft_created_fixture"`.
- Gmail contains drafts in `checkins@hope1source.me`.
- Salesforce is not queried, updated, or stamped.

## What remains for Salesforce

When Salesforce sandbox is ready, turn off `WEEKLY_DRAFTS_FIXTURE_DRAFT_ONLY`,
set `SF_LOGIN_URL=https://test.salesforce.com`, configure the Salesforce JWT
environment values, and invoke the same handler against sandbox data. That later
path should verify eligible Contact queries, `Historical_Data__c` writeback,
Markdown attachment upload, and `Last_Feedback_Email_Sent__c` stamping.
