# HopeOneSource Team Dev Access Standard

This standard applies to every Linear issue and branch in this repo. It gives teammates a repeatable local setup path while keeping secrets out of chat, GitHub, Linear, screenshots, logs, and committed files.

## Goals

- Let every approved teammate build and test MVP functionality on their own laptop.
- Keep production deploys and production-impacting writes behind explicit review.
- Make each issue state its blast radius before any live call runs.
- Avoid sharing Tim's Mac Mini credentials as the team access mechanism.

## Team Access Model

Approved teammates should use their own AWS/dev identity. Current known teammate addresses include:

- `fadames@hopewithlove.org`
- `vthornton@hopewithlove.org`
- `jrobinson@hopewithlove.org`

The shared AWS profile name for local development is:

```bash
HopeOneSource-Dev
```

For temporary compatibility with older HOP setup notes, scripts also recognize the previous profile name:

```bash
HOP42-Sandbox-Developer
```

The preferred path is AWS Identity Center/SSO or another short-lived, per-person access method. Long-lived shared AWS keys should not be copied between people or pasted into chat.

## Required AWS Permissions

Every teammate local profile should be able to verify identity:

- `sts:GetCallerIdentity`

Profiles that need live local MVP integration should also be able to read only the required dev secrets:

- `secretsmanager:GetSecretValue`

Canonical dev secret names:

- `hope1source/dev/salesforce/jwt`
- `hope1source/dev/google/service-account`

Compatibility secret names still accepted by the local scripts:

- `hope1source/hop43/salesforce-jwt`
- `hope1source/hop43/google-service-account`

Do not grant broad `secretsmanager:*`, production secret reads, write access, or deploy permissions for normal laptop development.

## Local Setup Commands

From the repo root:

```bash
npm run dev:doctor
npm run dev:secrets
npm run dev:smoke
```

This repo currently has no committed lockfile and no package dependencies, so `npm install` is usually unnecessary. If dependencies are added later, run the repo's documented install command before the dev checks.

The scripts do not print secret values. `dev:secrets` writes local-only files:

- `.env.local`
- `.secrets/salesforce-jwt-private-key.pem`
- `.secrets/google-service-account.json`
- `.secrets/google-service-account-private-key.pem`

These files are ignored by Git.

If a teammate uses a nonstandard profile name:

```bash
HOS_AWS_PROFILE=their-profile npm run dev:doctor
HOS_AWS_PROFILE=their-profile npm run dev:secrets
```

## Blast Radius Levels

Every Linear issue and PR should declare one level.

| Level | Meaning | Examples |
| --- | --- | --- |
| 0 | Local only, no external calls | Unit tests, fixtures, UI-only work |
| 1 | Read-only dev service calls | AWS identity check, read dev secrets, read sandbox data |
| 2 | Writes only test artifacts in dev/sandbox | Gmail drafts, Salesforce validation record, test logs |
| 3 | Sends test messages or changes shared dev data | Twilio sandbox send to allowlisted test recipient |
| 4 | Production-impacting | Production deploy, production data mutation, broad send |

Level 4 requires explicit approval from reviewers and must use the reviewed production path, not a local laptop or Mac Mini deploy.

## Default Runtime Modes

Implement and document the safest mode for each issue:

- `dry-run`: no external writes.
- `draft-only`: may create a draft, but does not send.
- `salesforce-validation`: may write one approved validation/test record in sandbox or an allowlisted test account.
- `live-send`: sends only to an allowlisted test recipient and requires explicit issue approval.

When a script or feature can perform a live action, it should print the intended service, account/profile, target environment, and blast radius before running.

## Production Rules

- No production deploy from a teammate laptop or the Mac Mini.
- Production deploys go through GitHub Actions, reviewed PRs, and GitHub Environment approval.
- Production local access is read-only unless a documented break-glass action is approved.
- Do not broaden IAM, Salesforce, Twilio, Gmail, or Google permissions without documenting why the issue needs it.

## Linear Issue Requirements

Each Linear issue should state:

- Git branch name.
- Required services.
- Required secret names.
- Local setup command.
- Allowed blast radius level.
- Test account/data.
- Whether Gmail drafts are allowed.
- Whether Salesforce validation writes are allowed.
- Whether Twilio/live send is allowed.
- Production approval requirement.
- Cleanup or rollback note.

Use `docs/team-dev-linear-issue-template.md` when creating or updating issues.

## Thunderbird-Specific Notes

- `npm test` runs the local `node:test` suite for the bridge and tool behavior.
- `npm run dev:smoke` runs `dev:doctor` first, then the Thunderbird local test suite.
- The Thunderbird extension and bridge are local-first. Any issue that touches real inboxes, drafts, contacts, or calendar data must declare the account, allowed action, and blast radius before testing.
- Compose and calendar actions should stay review-first unless the Linear issue explicitly approves an allowlisted live-send or live-write path.
