#!/usr/bin/env node

/**

 * Step 1 — Trigger & data ingestion (Salesforce + communication memory).

 * - Loads optional .env from repo root or pipeline/.env (CLI only; Lambda uses function env)

 * - Reads prior communication memory (summary.json, send-metadata.json) within a sliding window

 * - Retrieves Salesforce rows via JWT bearer + SOQL, or uses --dry-run fixtures

 *

 * On Salesforce failure: logs error and exits with code 1 (no downstream steps).

 */

"use strict";



const fs = require("fs");

const path = require("path");

const { runIngestStep1 } = require("./lib/run-ingest-step1.cjs");



function loadEnvFiles() {

  const candidates = [

    path.join(__dirname, "..", ".env"),

    path.join(__dirname, ".env"),

  ];

  for (const file of candidates) {

    try {

      const text = fs.readFileSync(file, "utf8");

      for (const line of text.split("\n")) {

        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith("#")) continue;

        const eq = trimmed.indexOf("=");

        if (eq <= 0) continue;

        const key = trimmed.slice(0, eq).trim();

        let val = trimmed.slice(eq + 1).trim();

        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {

          val = val.slice(1, -1);

        }

        if (process.env[key] === undefined) process.env[key] = val;

      }

    } catch (e) {

      if (e && e.code !== "ENOENT") throw e;

    }

  }

}



function parseArgs(argv) {

  const out = {

    dryRun: false,

    outPath: "",

    memoryDir: process.env.EMAIL_MEMORY_DIR || process.env.EMAIL_HISTORY_DIR || "email-history",

    memoryDays: Number(process.env.EMAIL_MEMORY_WINDOW_DAYS || 45),

    fixtureSf: path.join(__dirname, "..", "fixtures", "salesforce-ingest-sample.json"),

  };

  for (let i = 2; i < argv.length; i++) {

    const a = argv[i];

    if (a === "--dry-run") out.dryRun = true;

    else if (a === "--out" && argv[i + 1]) {

      out.outPath = argv[++i];

    } else if (a === "--memory-dir" && argv[i + 1]) {

      out.memoryDir = argv[++i];

    } else if (a === "--memory-days" && argv[i + 1]) {

      out.memoryDays = Number(argv[++i]);

    } else if (a === "--fixture-sf" && argv[i + 1]) {

      out.fixtureSf = argv[++i];

    }

  }

  return out;

}



async function main() {

  loadEnvFiles();

  const args = parseArgs(process.argv);



  let jsonText;

  try {

    ({ jsonText } = await runIngestStep1({

      dryRun: args.dryRun,

      memoryDir: args.memoryDir,

      memoryDays: args.memoryDays,

      fixtureSf: args.fixtureSf,

    }));

  } catch (e) {

    console.error("[ingest-step1] failed:", e.message || e);

    process.exit(1);

  }



  if (args.outPath) {

    fs.writeFileSync(path.resolve(args.outPath), jsonText, "utf8");

    console.log(`[ingest-step1] wrote ${path.resolve(args.outPath)}`);

  } else {

    process.stdout.write(jsonText);

  }

}



main().catch((e) => {

  console.error("[ingest-step1] fatal:", e);

  process.exit(1);

});

