# HOP-43 Safe Validation Runbook

Use this runbook to advance HOP-43 without secret leakage or changes to existing dependent resources.

Current deployment posture:

- Manual-only Lambda validation.
- No EventBridge rule, schedule, enablement, disablement, or settings changes.
- New HOP-43-namespaced AWS resources only.
- Review-first Gmail drafts routed to `checkins@hope1source.me`.
- Bethel Cafe is the only allowlisted live validation account.

## Current Safe Order

1. Local dry-run: no Bedrock, Gmail, or Salesforce calls.
2. Fixture draft-only: packaged fixture data, live Bedrock/Gmail, no Salesforce reads/writes.
3. Bethel Cafe sandbox validation: Salesforce sandbox reads and one new weekly `Historical_Data__c` writeback, reviewer-routed Gmail draft.
4. Production path only after PR review and approved production workflow.

## Required Safety Env

```bash
export GMAIL_SUBJECT="checkins@hope1source.me"
export GMAIL_FROM="Hope1Source Check-ins <checkins@hope1source.me>"
export GMAIL_REVIEW_RECIPIENT="checkins@hope1source.me"
export HOP43_ALLOWED_ACCOUNT_NAMES="Bethel Cafe"
export SF_STAMP_FEEDBACK_EMAIL_SENT=false
```

Do not set `HOP43_ALLOW_BROAD_RUN=true` or `HOP43_ALLOW_ACCOUNT_RECIPIENTS=true` for sandbox validation.

## AWS Resources

All HOP-43 AWS work is isolated to these new resources in `us-east-1`:

| Resource | Name |
| --- | --- |
| Lambda | `hope1source-hop43-weekly-drafts` |
| IAM role | `hop43-weekly-drafts-lambda-role` |
| IAM policy | `hop43-weekly-drafts-lambda-policy` |
| Log group | `/aws/lambda/hope1source-hop43-weekly-drafts` |
| Salesforce secret | `hope1source/hop43/salesforce-jwt` |
| Google secret | `hope1source/hop43/google-service-account` |

Do not modify existing IAM roles, existing IAM policies, existing Lambda functions, Salesforce fields, Salesforce flows, existing Salesforce apps, Google Workspace settings, or EventBridge.

## Lambda Environment

```bash
HOP43_SECRET_SOURCE=aws
HOP43_SF_SECRET_ID=hope1source/hop43/salesforce-jwt
HOP43_GOOGLE_SECRET_ID=hope1source/hop43/google-service-account
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=anthropic.claude-sonnet-4-5-20250929-v1:0
GMAIL_SUBJECT=checkins@hope1source.me
GMAIL_FROM="Hope1Source Check-ins <checkins@hope1source.me>"
GMAIL_REVIEW_RECIPIENT=checkins@hope1source.me
HOP43_ALLOWED_ACCOUNT_NAMES="Bethel Cafe"
SF_STAMP_FEEDBACK_EMAIL_SENT=false
```

Leave these unset:

```bash
HOP43_ALLOW_BROAD_RUN
HOP43_ALLOW_ACCOUNT_RECIPIENTS
```

## Teammate Secret Setup

For this Mac Mini, local development credentials can live in macOS Keychain, not chat, Linear, or tracked files:

```bash
./scripts/store-weekly-drafts-keychain-secrets.zsh
source ./scripts/load-weekly-drafts-keychain-env.zsh
npm run weekly-drafts:doctor:keychain
```

Shared approved credentials can also live in AWS Secrets Manager:

- `hope1source/hop43/salesforce-jwt`
- `hope1source/hop43/google-service-account`

Each teammate should use approved short-lived AWS access, then retrieve secrets from:

```text
AWS Console > Secrets Manager > Region us-east-1
https://us-east-1.console.aws.amazon.com/secretsmanager/listsecrets?region=us-east-1
```

Recommended local bootstrap stores the approved values in macOS Keychain without printing them:

```bash
aws sso login --profile HOP42-Sandbox-Developer
npm run hop43:env:pull:keychain -- --profile HOP42-Sandbox-Developer
source ./scripts/load-weekly-drafts-keychain-env.zsh
npm run weekly-drafts:doctor:keychain
```

Fallback for a local ignored env file:

```bash
npm run weekly-drafts:sync-env -- --profile HOP42-Sandbox-Developer
```

The sync command writes `.env.local` with file mode `0600` and prints no secret values. Prefer Keychain when possible.

## AWS Deploy Commands

After approved AWS CLI access exists, push local Keychain secrets to the two HOP-43 secrets:

```bash
npm run hop43:secrets:push:keychain -- --profile HOP42-Sandbox-Developer --dryRun true
npm run hop43:secrets:push:keychain -- --profile HOP42-Sandbox-Developer
```

Deploy or update only the HOP-43 Lambda, IAM role/policy, and log group:

```bash
npm run hop43:aws:deploy -- --profile HOP42-Sandbox-Developer --dryRun true
npm run hop43:aws:deploy -- --profile HOP42-Sandbox-Developer
```

These scripts do not call EventBridge APIs. They also refuse to write with a root AWS identity unless rerun with `--allowRoot true` after explicit approval.

## Readiness Check

```bash
npm run weekly-drafts:doctor -- --profile HOP42-Sandbox-Developer
```

This command checks AWS identity, sandbox secret access, and required safe env flags without printing secret values.

## Local Verification

```bash
npm run test:weekly-drafts
npm run weekly-drafts:dry
npm run package:lambda
```

Expected package artifact for HOP-43:

```text
dist/lambda-weekly-drafts.zip
handler: pipeline/weekly-drafts-handler.handler
```

## First Live-Lite Validation

After AWS/Gmail credentials are configured, invoke Lambda with fixture-draft-only mode:

```json
{
  "fixtureDraftOnly": true,
  "fixturePath": "/var/task/fixtures/weekly-eligible-accounts.json"
}
```

This path calls Bedrock and creates Gmail drafts to `GMAIL_REVIEW_RECIPIENT`, but skips Salesforce reads and writes.

## Manual Lambda Invocation

No EventBridge trigger is used in this phase. Invoke manually only:

```bash
aws lambda invoke \
  --region us-east-1 \
  --function-name hope1source-hop43-weekly-drafts \
  --payload '{"dryRun":true}' \
  /tmp/hop43-dry-run.json
```

If dry-run passes, run fixture draft-only before Salesforce live validation:

```bash
aws lambda invoke \
  --region us-east-1 \
  --function-name hope1source-hop43-weekly-drafts \
  --payload '{"fixtureDraftOnly":true,"fixturePath":"/var/task/fixtures/weekly-eligible-accounts.json"}' \
  /tmp/hop43-fixture-draft.json
```

## Bethel Cafe Sandbox Validation

Only after fixture draft-only succeeds, invoke against Salesforce sandbox with:

```bash
export HOP43_ALLOWED_ACCOUNT_NAMES="Bethel Cafe"
export GMAIL_REVIEW_RECIPIENT="<approved reviewer email>"
export SF_STAMP_FEEDBACK_EMAIL_SENT=false
```

Expected behavior:

- Pulls only allowlisted Bethel Cafe account data from Salesforce.
- Sends only sanitized per-account facts to Bedrock.
- Creates a Gmail draft from `checkins@hope1source.me` to `checkins@hope1source.me` for review.
- Creates one new weekly `Historical_Data__c` record.
- Attaches the Markdown rendering as a Salesforce File.
- Does not update Contact fields.

## Rollback

Immediate stop: do not invoke `hope1source-hop43-weekly-drafts` again. There is no EventBridge schedule to disable.

Disable execution while preserving evidence:

```bash
aws lambda put-function-concurrency \
  --region us-east-1 \
  --function-name hope1source-hop43-weekly-drafts \
  --reserved-concurrent-executions 0
```

Full HOP-43 AWS cleanup, if approved:

```bash
aws lambda delete-function --region us-east-1 --function-name hope1source-hop43-weekly-drafts
aws iam detach-role-policy --role-name hop43-weekly-drafts-lambda-role --policy-arn arn:aws:iam::<account-id>:policy/hop43-weekly-drafts-lambda-policy
aws iam delete-policy --policy-arn arn:aws:iam::<account-id>:policy/hop43-weekly-drafts-lambda-policy
aws iam delete-role --role-name hop43-weekly-drafts-lambda-role
aws secretsmanager delete-secret --region us-east-1 --secret-id hope1source/hop43/salesforce-jwt --recovery-window-in-days 7
aws secretsmanager delete-secret --region us-east-1 --secret-id hope1source/hop43/google-service-account --recovery-window-in-days 7
```

Only delete HOP-43-created Salesforce validation artifacts or Gmail drafts if they are incorrect. Do not touch existing fields, flows, apps, or unrelated records.

## Remaining External Gates

- AWS profile `HOP42-Sandbox-Developer` or another approved short-lived profile must exist locally.
- HOP-43 secrets must exist and be accessible in AWS Secrets Manager.
- Gmail service account/domain-wide delegation must be configured for `gmail.compose`.
- Bedrock model access must be enabled in the selected AWS region.
- Bethel Cafe sandbox Account id/name and field API names must match the configured Salesforce schema.
