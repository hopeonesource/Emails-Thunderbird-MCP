#!/usr/bin/env node
/**
 * Shared ingest step 1 logic (CLI and AWS Lambda).
 * Does not read .env files — callers set process.env or pass paths via options.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { loadCommunicationMemory } = require("./load-memory.cjs");
const { getJwtAccessToken, querySoql } = require("./salesforce-jwt.cjs");

const DEFAULT_SOQL =
  "SELECT Id, Email, FirstName, LastName, Phone FROM Contact WHERE Email != null LIMIT 100";

/**
 * @param {object} options
 * @param {boolean} options.dryRun
 * @param {string} options.memoryDir
 * @param {number} options.memoryDays
 * @param {string} options.fixtureSf absolute or cwd-relative path to Salesforce JSON fixture (dry-run only)
 * @returns {Promise<{ payload: object, jsonText: string }>}
 */
async function runIngestStep1(options) {
  const { dryRun, memoryDir, memoryDays, fixtureSf } = options;

  const ingestedAt = new Date().toISOString();
  const memory = await loadCommunicationMemory(memoryDir, memoryDays);

  let salesforce;
  if (dryRun) {
    const raw = fs.readFileSync(path.resolve(fixtureSf), "utf8");
    salesforce = JSON.parse(raw);
    salesforce.dryRun = true;
  } else {
    const { access_token, instance_url } = await getJwtAccessToken();
    const soql = process.env.SF_SOQL || DEFAULT_SOQL;
    const queryResult = await querySoql(instance_url, access_token, soql);
    salesforce = {
      dryRun: false,
      soql,
      totalSize: queryResult.totalSize,
      done: queryResult.done,
      records: queryResult.records || [],
    };
  }

  const payload = {
    step: 1,
    name: "ingest_salesforce_and_memory",
    ingestedAt,
    salesforce,
    memory: {
      windowDays: memoryDays,
      memoryDir: path.resolve(memoryDir),
      recentSummaries: memory.summaries,
      priorSendMetadata: memory.priorSendMetadata,
      skippedFilesOutOfWindow: memory.skippedOutOfWindow,
    },
  };

  const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
  return { payload, jsonText };
}

module.exports = { runIngestStep1, DEFAULT_SOQL };
