# HOP-43 GitHub DevOps Handoff

Use this as the PR body or Linear handoff for HOP-43. Do not include secret values.

## Scope Completed

- Manual-only HOP-43 weekly draft Lambda wiring.
- AWS Secrets Manager loader for Lambda init.
- Teammate bootstrap from AWS Secrets Manager to macOS Keychain.
- Runbook updates for validation, rollback, and no-EventBridge guardrails.

## Files Touched

- `pipeline/weekly-drafts-handler.js`
- `pipeline/lib/aws-secrets-env.cjs`
- `scripts/pull-hop43-secrets-to-keychain.cjs`
- `scripts/push-hop43-keychain-to-aws-secrets.cjs`
- `scripts/deploy-hop43-lambda-aws.cjs`
- `scripts/check-weekly-drafts-readiness.cjs`
- `scripts/sync-weekly-drafts-env.cjs`
- `.env.example`
- `README.md`
- `docs/HOP-43-safe-validation-runbook.md`

## Validation Log

Record exact command output status here before opening the PR:

```bash
npm run weekly-drafts:doctor:keychain
npm run test:weekly-drafts
npm run weekly-drafts:dry
npm run package:lambda
```

AWS manual validation:

```bash
aws lambda invoke \
  --region us-east-1 \
  --function-name hope1source-hop43-weekly-drafts \
  --payload '{"dryRun":true}' \
  /tmp/hop43-dry-run.json
```

## AWS Inventory

- Account: `783364685273`
- Region: `us-east-1`
- Lambda: `hope1source-hop43-weekly-drafts`
- IAM role: `hop43-weekly-drafts-lambda-role`
- IAM policy: `hop43-weekly-drafts-lambda-policy`
- Log group: `/aws/lambda/hope1source-hop43-weekly-drafts`
- Secrets:
  - `hope1source/hop43/salesforce-jwt`
  - `hope1source/hop43/google-service-account`

## Salesforce Inventory

- External Client App: `HOP43 Weekly Drafts Integration`
- API name: `HOP43_Weekly_Drafts_Integration`
- Integration user: `apionly@hopewithlove.org`
- Validation account allowlist: `Bethel Cafe`

## Guardrail Checklist

- [ ] No secrets committed.
- [ ] No EventBridge changes.
- [ ] No existing IAM policy edits.
- [ ] No existing Salesforce field or flow changes.
- [ ] Bethel Cafe allowlist only.
- [ ] Review recipient is `checkins@hope1source.me`.
- [ ] `HOP43_ALLOW_BROAD_RUN` is unset.
- [ ] `HOP43_ALLOW_ACCOUNT_RECIPIENTS` is unset.
- [ ] `SF_STAMP_FEEDBACK_EMAIL_SENT=false`.

## Runtime Cost Notes

- AWS Secrets Manager: two secrets, billed monthly plus API calls.
- Bedrock: manual validation invokes only; cost depends on prompt and completion tokens.
- Gmail: draft creation only; no email sending.
- Salesforce: API calls and one approved HOP-43 validation artifact only.

## Rollback

- Stop manual invokes. No EventBridge exists to disable.
- Set Lambda reserved concurrency to `0` to prevent execution while preserving logs.
- Delete only HOP-43-created AWS resources if cleanup is approved.
- Delete only incorrect HOP-43-created Salesforce validation artifacts or Gmail drafts.
