#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");

const args = parseArgs(process.argv.slice(2));
const source = args.source || process.env.HOP43_SECRET_SOURCE || "aws";
const profile = args.profile || process.env.AWS_PROFILE || "HOP42-Sandbox-Developer";
const region = args.region || process.env.AWS_REGION || "us-east-1";
const secretIds = [
  args.salesforceSecret || "hope1source/hop43/salesforce-jwt",
  args.googleSecret || "hope1source/hop43/google-service-account",
];

const checks = [];
if (source === "keychain" || source === "env") {
  checkEnvSecrets();
} else {
  checkAwsIdentity();
  for (const secretId of secretIds) checkSecret(secretId);
}
checkLocalEnv();

const failed = checks.filter((c) => c.status === "FAIL");
for (const c of checks) {
  console.log(`${c.status.padEnd(4)} ${c.name}${c.detail ? ` - ${c.detail}` : ""}`);
}

if (failed.length > 0) {
  console.log("");
  console.log("Readiness blocked. Fix FAIL items, then rerun this command.");
  process.exitCode = 1;
}

function checkAwsIdentity() {
  try {
    const raw = execFileSync(
      "aws",
      ["sts", "get-caller-identity", "--profile", profile, "--region", region, "--output", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const identity = JSON.parse(raw);
    checks.push({
      status: "PASS",
      name: "AWS sandbox identity",
      detail: `profile=${profile}, account=${maskAccount(identity.Account)}`,
    });
  } catch (e) {
    checks.push({
      status: "FAIL",
      name: "AWS sandbox identity",
      detail: `profile=${profile} is not usable; run aws sso login or configure the profile`,
    });
  }
}

function checkSecret(secretId) {
  try {
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
    const parsed = JSON.parse(raw);
    checks.push({
      status: "PASS",
      name: `Secret ${secretId}`,
      detail: `JSON keys present: ${Object.keys(parsed).sort().join(", ") || "(none)"}`,
    });
  } catch (e) {
    checks.push({
      status: "FAIL",
      name: `Secret ${secretId}`,
      detail: "missing, inaccessible, or not a JSON object",
    });
  }
}

function checkLocalEnv() {
  const requiredForSafeLive = {
    GMAIL_SUBJECT: "checkins@hope1source.me",
    GMAIL_FROM: "Hope1Source Check-ins <checkins@hope1source.me>",
    GMAIL_REVIEW_RECIPIENT: null,
    HOP43_ALLOWED_ACCOUNT_NAMES: "Bethel Cafe",
  };

  for (const [key, expected] of Object.entries(requiredForSafeLive)) {
    const value = process.env[key];
    if (!value) {
      checks.push({ status: "FAIL", name: `Env ${key}`, detail: "missing in current shell" });
    } else if (expected && value !== expected) {
      checks.push({ status: "WARN", name: `Env ${key}`, detail: `present but expected ${expected}` });
    } else {
      checks.push({ status: "PASS", name: `Env ${key}`, detail: "present" });
    }
  }

  if (/^(1|true|yes)$/i.test(String(process.env.SF_STAMP_FEEDBACK_EMAIL_SENT || ""))) {
    checks.push({ status: "WARN", name: "Contact stamping", detail: "enabled; keep off unless approved" });
  } else {
    checks.push({ status: "PASS", name: "Contact stamping", detail: "disabled" });
  }
}

function checkEnvSecrets() {
  const envSecrets = [
    "SF_CLIENT_ID",
    "SF_USERNAME",
    "SF_LOGIN_URL",
    ["SF_PRIVATE_KEY", "SF_PRIVATE_KEY_PATH"],
    "GOOGLE_SERVICE_ACCOUNT_EMAIL",
    ["GOOGLE_PRIVATE_KEY", "GOOGLE_PRIVATE_KEY_PATH"],
  ];

  for (const item of envSecrets) {
    if (Array.isArray(item)) {
      const present = item.some((key) => Boolean(process.env[key]));
      checks.push({
        status: present ? "PASS" : "FAIL",
        name: `Env ${item.join(" or ")}`,
        detail: present ? "present" : "missing in current shell",
      });
    } else {
      checks.push({
        status: process.env[item] ? "PASS" : "FAIL",
        name: `Env ${item}`,
        detail: process.env[item] ? "present" : "missing in current shell",
      });
    }
  }
}

function maskAccount(account) {
  const s = String(account || "");
  if (s.length < 4) return "<account-id>";
  return `<account-id ending ${s.slice(-4)}>`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    parsed[arg.slice(2)] = argv[i + 1];
    i += 1;
  }
  return parsed;
}
