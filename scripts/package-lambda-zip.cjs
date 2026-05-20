#!/usr/bin/env node
/**
 * Build Lambda zips for AWS Lambda (upload .zip in the Lambda console).
 * Includes pipeline/ (handlers + libs) and fixtures/.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const stage = path.join(dist, "lambda-stage");
const outputs = [
  {
    zip: path.join(dist, "lambda-ingest.zip"),
    handler: "pipeline/lambda-handler.handler",
  },
  {
    zip: path.join(dist, "lambda-weekly-drafts.zip"),
    handler: "pipeline/weekly-drafts-handler.handler",
  },
];

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`[package-lambda-zip] missing ${label}: ${p}`);
    process.exit(1);
  }
}

mustExist(path.join(root, "pipeline", "lambda-handler.js"), "pipeline/lambda-handler.js");
mustExist(path.join(root, "pipeline", "weekly-drafts-handler.js"), "pipeline/weekly-drafts-handler.js");
mustExist(path.join(root, "pipeline", "lib", "run-ingest-step1.cjs"), "pipeline/lib");
mustExist(path.join(root, "pipeline", "lib", "run-weekly-drafts.cjs"), "pipeline/lib");
mustExist(path.join(root, "fixtures", "salesforce-ingest-sample.json"), "fixtures");

fs.mkdirSync(dist, { recursive: true });
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

fs.cpSync(path.join(root, "pipeline"), path.join(stage, "pipeline"), { recursive: true });
fs.cpSync(path.join(root, "fixtures"), path.join(stage, "fixtures"), { recursive: true });

const nodeModules = path.join(root, "node_modules");
if (fs.existsSync(nodeModules)) {
  fs.cpSync(nodeModules, path.join(stage, "node_modules"), { recursive: true });
}

for (const output of outputs) {
  if (fs.existsSync(output.zip)) fs.unlinkSync(output.zip);
}

function zipWithTar(outZip) {
  const r = spawnSync("tar", ["-caf", outZip, "-C", stage, "."], {
    stdio: "inherit",
    encoding: "utf8",
  });
  return r.status === 0;
}

function zipWithPowerShell(outZip) {
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

for (const output of outputs) {
  let ok = zipWithTar(output.zip);
  if (!ok && process.platform === "win32") {
    console.error("[package-lambda-zip] tar failed; trying PowerShell Compress-Archive...");
    if (fs.existsSync(output.zip)) fs.unlinkSync(output.zip);
    ok = zipWithPowerShell(output.zip);
  }

  if (!ok) {
    console.error(
      "[package-lambda-zip] could not create zip. Install a recent Windows build with tar, or use PowerShell."
    );
    fs.rmSync(stage, { recursive: true, force: true });
    process.exit(1);
  }
}

fs.rmSync(stage, { recursive: true, force: true });

for (const output of outputs) {
  const stat = fs.statSync(output.zip);
  console.log(`[package-lambda-zip] wrote ${output.zip} (${Math.round(stat.size / 1024)} KB)`);
  console.log(`[package-lambda-zip] Lambda handler: ${output.handler}`);
}
console.log("[package-lambda-zip] Runtime: Node.js 18.x or newer (e.g. 20.x or 24.x)");
