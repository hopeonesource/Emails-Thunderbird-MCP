#!/usr/bin/env node
/**
 * Build dist/lambda-weekly-drafts.zip for the Weekly Check-in Email Drafts Lambda.
 * Includes pipeline/, fixtures/, and installed npm dependencies needed by Bedrock.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const stage = path.join(dist, "weekly-drafts-stage");
const outZip = path.join(dist, "lambda-weekly-drafts.zip");

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`[package-weekly-drafts-zip] missing ${label}: ${p}`);
    process.exit(1);
  }
}

mustExist(path.join(root, "pipeline", "weekly-drafts-handler.js"), "pipeline/weekly-drafts-handler.js");
mustExist(path.join(root, "pipeline", "lib", "bedrock-email.cjs"), "pipeline/lib/bedrock-email.cjs");
mustExist(path.join(root, "fixtures", "weekly-eligible-accounts.json"), "fixtures/weekly-eligible-accounts.json");
mustExist(
  path.join(root, "node_modules", "@aws-sdk", "client-bedrock-runtime"),
  "node_modules/@aws-sdk/client-bedrock-runtime; run npm install before packaging"
);
mustExist(
  path.join(root, "node_modules", "@aws-sdk", "client-secrets-manager"),
  "node_modules/@aws-sdk/client-secrets-manager; run npm install before packaging"
);

fs.mkdirSync(dist, { recursive: true });
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

fs.cpSync(path.join(root, "pipeline"), path.join(stage, "pipeline"), { recursive: true });
fs.cpSync(path.join(root, "fixtures"), path.join(stage, "fixtures"), { recursive: true });
fs.cpSync(path.join(root, "node_modules"), path.join(stage, "node_modules"), { recursive: true });
fs.copyFileSync(path.join(root, "package.json"), path.join(stage, "package.json"));

if (fs.existsSync(outZip)) {
  fs.unlinkSync(outZip);
}

function zipWithTar() {
  const r = spawnSync("tar", ["-caf", outZip, "-C", stage, "."], {
    stdio: "inherit",
    encoding: "utf8",
  });
  return r.status === 0;
}

function zipWithPowerShell() {
  const dest = outZip.replace(/'/g, "''");
  const cmd = [
    "$ErrorActionPreference='Stop'",
    `if (Test-Path -LiteralPath '${dest}') { Remove-Item -LiteralPath '${dest}' -Force }`,
    `Compress-Archive -LiteralPath @('pipeline','fixtures','node_modules','package.json') -DestinationPath '${dest}' -Force`,
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
    cwd: stage,
    stdio: "inherit",
  });
  return r.status === 0;
}

let ok = zipWithTar();
if (!ok && process.platform === "win32") {
  console.error("[package-weekly-drafts-zip] tar failed; trying PowerShell Compress-Archive...");
  if (fs.existsSync(outZip)) fs.unlinkSync(outZip);
  ok = zipWithPowerShell();
}

fs.rmSync(stage, { recursive: true, force: true });

if (!ok) {
  console.error(
    "[package-weekly-drafts-zip] could not create zip. Install a recent Windows build with tar, or use PowerShell."
  );
  process.exit(1);
}

const stat = fs.statSync(outZip);
console.log(`[package-weekly-drafts-zip] wrote ${outZip} (${Math.round(stat.size / 1024)} KB)`);
console.log("[package-weekly-drafts-zip] Lambda handler: pipeline/weekly-drafts-handler.handler");
console.log("[package-weekly-drafts-zip] Runtime: Node.js 20.x or newer");
