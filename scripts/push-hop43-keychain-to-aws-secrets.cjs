#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");

const args = parseArgs(process.argv.slice(2));
const profile = args.profile || process.env.AWS_PROFILE || "HOP42-Sandbox-Developer";
const region = args.region || process.env.AWS_REGION || "us-east-1";
const dryRun = flag(args, "dryRun");
const sfSecretId = args.salesforceSecret || "hope1source/hop43/salesforce-jwt";
const googleSecretId = args.googleSecret || "hope1source/hop43/google-service-account";

const sf = {
  SF_CLIENT_ID: keychainGet("dev/hop43/salesforce/client-id"),
  SF_USERNAME: keychainGet("dev/hop43/salesforce/username"),
  SF_LOGIN_URL: keychainGet("dev/hop43/salesforce/login-url"),
  SF_PRIVATE_KEY: keychainGet("dev/hop43/salesforce/private-key"),
};
const google = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: keychainGet("dev/hop43/google/service-account"),
  GOOGLE_PRIVATE_KEY: keychainGet("dev/hop43/google/private-key"),
};

const identity = getAwsIdentity();
console.log(`AWS identity ok: account=${maskAccount(identity.Account)}, arn=${identity.Arn}`);
if (/^arn:aws:iam::\d+:root$/u.test(identity.Arn) && !flag(args, "allowRoot")) {
  throw new Error("Refusing to write secrets as root. Rerun with an approved non-root profile, or pass --allowRoot true after explicit approval.");
}

upsertSecret(sfSecretId, sf);
upsertSecret(googleSecretId, google);
console.log(`Prepared ${dryRun ? "dry-run for" : "stored"} 2 HOP-43 AWS Secrets Manager secret(s) in ${region}.`);
console.log("No secret values were printed.");

function upsertSecret(secretId, secretValue) {
  const exists = awsStatus(["secretsmanager", "describe-secret", "--secret-id", secretId]) === 0;
  if (dryRun) {
    console.log(`${exists ? "Would update" : "Would create"} ${secretId}`);
    return;
  }
  if (exists) {
    awsJson(["secretsmanager", "put-secret-value", "--secret-id", secretId, "--secret-string", JSON.stringify(secretValue)]);
    console.log(`Updated ${secretId}`);
  } else {
    awsJson(["secretsmanager", "create-secret", "--name", secretId, "--secret-string", JSON.stringify(secretValue)]);
    console.log(`Created ${secretId}`);
  }
}

function keychainGet(service) {
  return execFileSync("security", ["find-generic-password", "-a", process.env.KEYCHAIN_ACCOUNT || process.env.USER, "-s", service, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function awsJson(extraArgs) {
  const raw = execFileSync("aws", [...extraArgs, "--profile", profile, "--region", region, "--output", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw);
}

function getAwsIdentity() {
  try {
    return awsJson(["sts", "get-caller-identity"]);
  } catch (e) {
    console.error(`AWS profile ${profile} is not usable in ${region}.`);
    console.error("Run aws sso login with an approved short-lived profile, then retry.");
    console.error("No AWS secrets were created or updated.");
    process.exit(1);
  }
}

function awsStatus(extraArgs) {
  try {
    execFileSync("aws", [...extraArgs, "--profile", profile, "--region", region, "--output", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (e) {
    return e.status || 1;
  }
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
