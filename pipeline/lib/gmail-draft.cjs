"use strict";

const https = require("https");
const { URL } = require("url");

/**
 * Gmail API draft creation (NEVER send).
 *
 * Uses the access token returned by google-jwt.cjs which is scoped to
 * `gmail.compose` and impersonates GMAIL_SUBJECT (e.g. checkins@hope1source.me).
 */

const GMAIL_API_BASE = "https://gmail.googleapis.com";

function buildMime({ from, to, subject, htmlBody, textFallback }) {
  const boundary = `----=hopeonesource_${Date.now().toString(36)}`;
  const headers = [
    `From: ${from}`,
    `To: ${Array.isArray(to) ? to.join(", ") : to}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
  ].join("\r\n");

  const text = textFallback || stripHtml(htmlBody);
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    htmlBody,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return `${headers}\r\n${parts}`;
}

function encodeHeader(s) {
  if (/^[\x20-\x7E]*$/u.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/giu, "")
    .replace(/<[^>]+>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function base64UrlEncode(str) {
  return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function postJson(url, accessToken, bodyObj) {
  const u = new URL(url);
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            /* leave json null */
          }
          resolve({ statusCode: res.statusCode, json, raw });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Create a Gmail draft for the impersonated user.
 *
 * @param {object} params
 * @param {string} params.accessToken Google access token (scope: gmail.compose)
 * @param {string} params.from typically `Hope1Source Check-ins <checkins@hope1source.me>`
 * @param {string|string[]} params.to recipient(s)
 * @param {string} params.subject email subject
 * @param {string} params.htmlBody HTML body
 * @param {string} [params.textFallback]
 * @returns {Promise<{ draftId: string, messageId: string, threadId: string }>}
 */
async function createDraft({ accessToken, from, to, subject, htmlBody, textFallback }) {
  if (!accessToken) throw new Error("createDraft: accessToken is required");
  if (!from) throw new Error("createDraft: from is required");
  if (!to || (Array.isArray(to) && to.length === 0)) throw new Error("createDraft: to is required");
  if (!subject) throw new Error("createDraft: subject is required");
  if (!htmlBody) throw new Error("createDraft: htmlBody is required");

  const mime = buildMime({ from, to, subject, htmlBody, textFallback });
  const raw = base64UrlEncode(mime);

  const url = `${GMAIL_API_BASE}/gmail/v1/users/me/drafts`;
  const res = await postJson(url, accessToken, { message: { raw } });
  if (res.statusCode !== 200 || !res.json?.id) {
    const msg = res.json?.error?.message || res.raw?.slice(0, 400);
    throw new Error(`Gmail draft create failed HTTP ${res.statusCode}: ${msg}`);
  }
  return {
    draftId: res.json.id,
    messageId: res.json.message?.id || "",
    threadId: res.json.message?.threadId || "",
  };
}

module.exports = { createDraft, buildMime, base64UrlEncode, stripHtml };
