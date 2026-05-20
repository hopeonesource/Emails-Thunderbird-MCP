#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const args = parseArgs(process.argv.slice(2));
const profile =
  args.profile === "ambient" ? "" : (args.profile || process.env.AWS_PROFILE || "HOP42-Sandbox-Developer");
const region = args.region || process.env.AWS_REGION || "us-east-1";
const dryRun = flag(args, "dryRun");
const functionName = args.functionName || "hope1source-hop43-weekly-drafts";
const roleName = args.roleName || "hop43-weekly-drafts-lambda-role";
const policyName = args.policyName || "hop43-weekly-drafts-lambda-policy";
const zipPath = path.resolve(args.zip || "dist/lambda-weekly-drafts.zip");
const sfSecretId = args.salesforceSecret || "hope1source/hop43/salesforce-jwt";
const googleSecretId = args.googleSecret || "hope1source/hop43/google-service-account";

if (!fs.existsSync(zipPath)) {
  throw new Error(`Missing Lambda zip: ${zipPath}. Run npm run package:lambda first.`);
}

const identity = getAwsIdentity();
const account = identity.Account;
console.log(`AWS identity ok: account=${maskAccount(account)}, arn=${identity.Arn}`);
if (/^arn:aws:iam::\d+:root$/u.test(identity.Arn) && !flag(args, "allowRoot")) {
  throw new Error("Refusing to deploy as root. Rerun with an approved non-root profile, or pass --allowRoot true after explicit approval.");
}

const roleArn = ensureRole(account);
const policyArn = ensurePolicy(account);
attachPolicy(policyArn);
ensureLogGroup();
ensureLambda(roleArn);

console.log(`${dryRun ? "Dry-run complete for" : "Deployed"} ${functionName} in ${region}.`);
console.log("No EventBridge commands were run.");

function ensureRole() {
  const existing = tryAwsJson(["iam", "get-role", "--role-name", roleName]);
  if (existing?.Role?.Arn) {
    console.log(`Role exists: ${roleName}`);
    return existing.Role.Arn;
  }

  const trust = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  };
  if (dryRun) {
    console.log(`Would create role ${roleName}`);
    return `arn:aws:iam::${account}:role/${roleName}`;
  }
  const trustFile = writeTempJson("hop43-trust", trust);
  const created = awsJson([
    "iam",
    "create-role",
    "--role-name",
    roleName,
    "--assume-role-policy-document",
    `file://${trustFile}`,
  ]);
  console.log(`Created role ${roleName}`);
  sleep(10_000);
  return created.Role.Arn;
}

function ensurePolicy(account) {
  const policyArn = `arn:aws:iam::${account}:policy/${policyName}`;
  const doc = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["bedrock:InvokeModel"],
        Resource: [`arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`],
      },
      {
        Effect: "Allow",
        Action: ["secretsmanager:GetSecretValue"],
        Resource: [
          secretArn(account, sfSecretId),
          secretArn(account, googleSecretId),
        ],
      },
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: [`arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${functionName}:*`],
      },
    ],
  };

  const existing = tryAwsJson(["iam", "get-policy", "--policy-arn", policyArn]);
  if (dryRun) {
    console.log(`${existing ? "Would update" : "Would create"} policy ${policyName}`);
    return policyArn;
  }

  const policyFile = writeTempJson("hop43-policy", doc);
  if (existing) {
    awsJson([
      "iam",
      "create-policy-version",
      "--policy-arn",
      policyArn,
      "--policy-document",
      `file://${policyFile}`,
      "--set-as-default",
    ]);
    pruneOldPolicyVersions(policyArn);
    console.log(`Updated HOP-43 policy ${policyName}`);
  } else {
    awsJson(["iam", "create-policy", "--policy-name", policyName, "--policy-document", `file://${policyFile}`]);
    console.log(`Created policy ${policyName}`);
  }
  return policyArn;
}

function attachPolicy(policyArn) {
  if (dryRun) {
    console.log(`Would attach ${policyName} to ${roleName}`);
    return;
  }
  awsJson(["iam", "attach-role-policy", "--role-name", roleName, "--policy-arn", policyArn]);
  console.log(`Attached ${policyName} to ${roleName}`);
  sleep(5_000);
}

function ensureLogGroup() {
  const name = `/aws/lambda/${functionName}`;
  const exists = tryAwsJson(["logs", "describe-log-groups", "--log-group-name-prefix", name])?.logGroups?.some(
    (g) => g.logGroupName === name
  );
  if (dryRun) {
    console.log(`${exists ? "Would keep" : "Would create"} log group ${name}`);
    return;
  }
  if (!exists) {
    awsJson(["logs", "create-log-group", "--log-group-name", name]);
    console.log(`Created log group ${name}`);
  } else {
    console.log(`Log group exists: ${name}`);
  }
}

function ensureLambda(roleArn) {
  const envFile = writeTempJson("hop43-env", {
    Variables: {
      HOP43_SECRET_SOURCE: "aws",
      HOP43_SF_SECRET_ID: sfSecretId,
      HOP43_GOOGLE_SECRET_ID: googleSecretId,
      BEDROCK_MODEL_ID: "anthropic.claude-sonnet-4-5-20250929-v1:0",
      GMAIL_SUBJECT: "checkins@hope1source.me",
      GMAIL_FROM: "Hope1Source Check-ins <checkins@hope1source.me>",
      GMAIL_REVIEW_RECIPIENT: "checkins@hope1source.me",
      HOP43_ALLOWED_ACCOUNT_NAMES: "Bethel Cafe",
      SF_STAMP_FEEDBACK_EMAIL_SENT: "false",
    },
  });
  const exists = Boolean(tryAwsJson(["lambda", "get-function", "--function-name", functionName]));

  if (dryRun) {
    console.log(`${exists ? "Would update" : "Would create"} Lambda ${functionName}`);
    return;
  }

  if (exists) {
    awsJson(["lambda", "update-function-code", "--function-name", functionName, "--zip-file", `fileb://${zipPath}`]);
    waitForLambdaUpdated(functionName);
    awsJson([
      "lambda",
      "update-function-configuration",
      "--function-name",
      functionName,
      "--runtime",
      "nodejs20.x",
      "--handler",
      "pipeline/weekly-drafts-handler.handler",
      "--role",
      roleArn,
      "--timeout",
      "300",
      "--memory-size",
      "512",
      "--environment",
      `file://${envFile}`,
    ]);
    waitForLambdaUpdated(functionName);
    console.log(`Updated Lambda ${functionName}`);
  } else {
    awsJson([
      "lambda",
      "create-function",
      "--function-name",
      functionName,
      "--runtime",
      "nodejs20.x",
      "--handler",
      "pipeline/weekly-drafts-handler.handler",
      "--role",
      roleArn,
      "--timeout",
      "300",
      "--memory-size",
      "512",
      "--zip-file",
      `fileb://${zipPath}`,
      "--environment",
      `file://${envFile}`,
    ]);
    waitForLambdaUpdated(functionName);
    console.log(`Created Lambda ${functionName}`);
  }
}

function pruneOldPolicyVersions(policyArn) {
  const versions = awsJson(["iam", "list-policy-versions", "--policy-arn", policyArn]).Versions || [];
  const old = versions
    .filter((v) => !v.IsDefaultVersion)
    .sort((a, b) => String(a.CreateDate).localeCompare(String(b.CreateDate)));
  while (old.length > 4) {
    const v = old.shift();
    awsJson(["iam", "delete-policy-version", "--policy-arn", policyArn, "--version-id", v.VersionId]);
  }
}

function secretArn(account, secretId) {
  return `arn:aws:secretsmanager:${region}:${account}:secret:${secretId}-*`;
}

function writeTempJson(prefix, obj) {
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  return file;
}

function tryAwsJson(extraArgs) {
  try {
    return awsJson(extraArgs);
  } catch {
    return null;
  }
}

function awsJson(extraArgs) {
  const raw = execFileSync("aws", [...extraArgs, ...profileArgs(), "--region", region, "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return raw.trim() ? JSON.parse(raw) : {};
}

function waitForLambdaUpdated(name) {
  const r = spawnSync(
    "aws",
    ["lambda", "wait", "function-updated", "--function-name", name, ...profileArgs(), "--region", region],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" }
  );
  if (r.status !== 0) {
    throw new Error(`Timed out waiting for Lambda ${name} to finish updating: ${r.stderr.trim()}`);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getAwsIdentity() {
  try {
    return awsJson(["sts", "get-caller-identity"]);
  } catch (e) {
    const label = profile ? `profile ${profile}` : "ambient credentials";
    console.error(`AWS ${label} is not usable in ${region}.`);
    console.error("Run aws sso login with an approved short-lived profile, or use --profile ambient inside AWS CloudShell.");
    console.error("No AWS resources were created or updated.");
    process.exit(1);
  }
}

function profileArgs() {
  return profile ? ["--profile", profile] : [];
}

function maskAccount(account) {
  const s = String(account || "");
  return s.length > 4 ? `<account-id ending ${s.slice(-4)}>` : "<account-id>";
}

function flag(parsed, key) {
  return /^(1|true|yes)$/iu.test(String(parsed[key] || ""));
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    parsed[arg.slice(2)] = argv[i + 1] || "true";
    i += 1;
  }
  return parsed;
}
