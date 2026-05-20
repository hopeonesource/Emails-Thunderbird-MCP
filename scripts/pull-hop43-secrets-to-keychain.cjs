#!/usr/bin/env node
"use strict";

const { execFileSync, spawnSync } = require("child_process");

const args = parseArgs(process.argv.slice(2));
const profile = args.profile || process.env.AWS_PROFILE || "HOP42-Sandbox-Developer";
const region = args.region || process.env.AWS_REGION || "us-east-1";
const secretIds = [
  args.salesforceSecret || "hope1source/hop43/salesforce-jwt",
  args.googleSecret || "hope1source/hop43/google-service-account",
];
const account = process.env.KEYCHAIN_ACCOUNT || process.env.USER || "hop43";

const keychainMap = {
  SF_CLIENT_ID: "dev/hop43/salesforce/client-id",
  SF_USERNAME: "dev/hop43/salesforce/username",
  SF_LOGIN_URL: "dev/hop43/salesforce/login-url",
  SF_PRIVATE_KEY: "dev/hop43/salesforce/private-key",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: "dev/hop43/google/service-account",
  GOOGLE_PRIVATE_KEY: "dev/hop43/google/private-key",
};

const required = Object.keys(keychainMap);
const combined = {};

for (const secretId of secretIds) {
  Object.assign(combined, readSecretJson(secretId));
}

const missing = required.filter((key) => !combined[key]);
if (missing.length > 0) {
  throw new Error(`AWS secrets are missing required keys: ${missing.join(", ")}`);
}

for (const key of required) {
  storeKeychainSecret(keychainMap[key], String(combined[key]));
}

console.log(`Stored ${required.length} HOP-43 secret(s) in macOS Keychain from AWS Secrets Manager.`);
console.log(`AWS profile=${profile}, region=${region}. No secret values were printed.`);
console.log("Next: source ./scripts/load-weekly-drafts-keychain-env.zsh && npm run weekly-drafts:doctor:keychain");

function readSecretJson(secretId) {
  const raw = execFileSync(
    "aws",
    [
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      secretId,
      "--profile",
      profile,
      "--region",
      region,
      "--query",
      "SecretString",
      "--output",
      "text",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed;
  } catch (e) {
    throw new Error(`Secret ${secretId} must contain a JSON object: ${e.message}`);
  }
}

function storeKeychainSecret(service, value) {
  const r = spawnSync(
    "security",
    ["add-generic-password", "-a", account, "-s", service, "-w", value, "-U"],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" }
  );
  if (r.status !== 0) {
    throw new Error(`Could not store ${service} in macOS Keychain: ${r.stderr.trim()}`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    parsed[key] = argv[i + 1];
    i += 1;
  }
  return parsed;
}
