#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

/**
 * Recursively collect summary.json and send-metadata.json under rootDir,
 * keeping entries whose sentAt / generatedAt (or file mtime) falls inside the window.
 *
 * @param {string} rootDir Absolute or cwd-relative directory (e.g. ./email-history)
 * @param {number} windowDays e.g. 45
 * @returns {Promise<{ summaries: object[], priorSendMetadata: object[], skippedOutOfWindow: number }>}
 */
async function loadCommunicationMemory(rootDir, windowDays) {
  const rootResolved = path.resolve(rootDir);
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const summaries = [];
  const priorSendMetadata = [];
  let skippedOutOfWindow = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e && e.code === "ENOENT") return;
      throw e;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      const lower = ent.name.toLowerCase();
      if (lower === "summary.json" || lower.endsWith(".summary.json")) {
        const one = await readIfInWindow(full, rootResolved, cutoff, "summary");
        if (one.inWindow && one.data !== null) summaries.push(one.data);
        else if (one.expired) skippedOutOfWindow += 1;
      } else if (lower === "send-metadata.json" || lower.endsWith(".metadata.json")) {
        const one = await readIfInWindow(full, rootResolved, cutoff, "metadata");
        if (one.inWindow && one.data !== null) priorSendMetadata.push(one.data);
        else if (one.expired) skippedOutOfWindow += 1;
      }
    }
  }

  await walk(rootResolved);

  summaries.sort((a, b) => (b.sortKey || 0) - (a.sortKey || 0));
  priorSendMetadata.sort((a, b) => (b.sortKey || 0) - (a.sortKey || 0));

  return { summaries, priorSendMetadata, skippedOutOfWindow };
}

async function readIfInWindow(filePath, rootResolved, cutoffMs, kind) {
  const stat = await fs.stat(filePath);
  let json;
  try {
    json = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return { inWindow: false, expired: false, data: null };
  }
  const sentAt = json.sentAt || json.generatedAt || json.createdAt;
  const parsed = sentAt ? Date.parse(sentAt) : NaN;
  const t = Number.isFinite(parsed) ? parsed : stat.mtimeMs;
  if (t < cutoffMs) {
    return { inWindow: false, expired: true, data: null };
  }
  const sortKey = t;
  const rel = path.relative(rootResolved, filePath);
  const envelope =
    kind === "summary"
      ? {
          path: rel,
          sortKey,
          summary: json,
        }
      : {
          path: rel,
          sortKey,
          metadata: json,
        };
  return { inWindow: true, expired: false, data: envelope };
}

module.exports = { loadCommunicationMemory };
