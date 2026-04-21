#!/usr/bin/env node
/**
 * Build dist/lambda-ingest.zip for AWS Lambda (upload .zip in the Lambda console).
 * Includes pipeline/ (handler + libs) and fixtures/ (Salesforce sample + email-history samples).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const stage = path.join(dist, "lambda-stage");
const outZip = path.join(dist, "lambda-ingest.zip");

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`[package-lambda-zip] missing ${label}: ${p}`);
    process.exit(1);
  }
}

mustExist(path.join(root, "pipeline", "lambda-handler.js"), "pipeline/lambda-handler.js");
mustExist(path.join(root, "pipeline", "lib", "run-ingest-step1.cjs"), "pipeline/lib");
mustExist(path.join(root, "fixtures", "salesforce-ingest-sample.json"), "fixtures");

fs.mkdirSync(dist, { recursive: true });
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

fs.cpSync(path.join(root, "pipeline"), path.join(stage, "pipeline"), { recursive: true });
fs.cpSync(path.join(root, "fixtures"), path.join(stage, "fixtures"), { recursive: true });

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
    `Compress-Archive -LiteralPath @('pipeline','fixtures') -DestinationPath '${dest}' -Force`,
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
    cwd: stage,
    stdio: "inherit",
  });
  return r.status === 0;
}

let ok = zipWithTar();
if (!ok && process.platform === "win32") {
  console.error("[package-lambda-zip] tar failed; trying PowerShell Compress-Archive...");
  if (fs.existsSync(outZip)) fs.unlinkSync(outZip);
  ok = zipWithPowerShell();
}

fs.rmSync(stage, { recursive: true, force: true });

if (!ok) {
  console.error(
    "[package-lambda-zip] could not create zip. Install a recent Windows build with tar, or use PowerShell."
  );
  process.exit(1);
}

const stat = fs.statSync(outZip);
console.log(`[package-lambda-zip] wrote ${outZip} (${Math.round(stat.size / 1024)} KB)`);
console.log("[package-lambda-zip] Lambda handler: pipeline/lambda-handler.handler");
console.log("[package-lambda-zip] Runtime: Node.js 18.x or newer (e.g. 20.x or 24.x)");
