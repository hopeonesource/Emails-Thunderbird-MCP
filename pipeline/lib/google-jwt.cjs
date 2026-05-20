"use strict";

const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");

/**
 * Google service-account JWT bearer flow with domain-wide delegation.
 *
 * Required env (Lambda):
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL
 *   GOOGLE_PRIVATE_KEY (PEM, with literal \n) OR GOOGLE_PRIVATE_KEY_PATH
 *   GMAIL_SUBJECT (workspace user to impersonate, e.g. checkins@hope1source.me)
 *
 * Scope used: gmail.compose (drafts only; cannot send).
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function readPrivateKeyPem() {
  const inline = process.env.GOOGLE_PRIVATE_KEY;
  const path = process.env.GOOGLE_PRIVATE_KEY_PATH;
  if (inline) return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
  if (path) return require("fs").readFileSync(path, "utf8");
  throw new Error("Set GOOGLE_PRIVATE_KEY (PEM) or GOOGLE_PRIVATE_KEY_PATH");
}

function requestForm(url, formBody) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(formBody),
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
            json = JSON.parse(raw);
          } catch {
            /* leave json null */
          }
          resolve({ statusCode: res.statusCode, json, raw });
        });
      }
    );
    req.on("error", reject);
    req.write(formBody);
    req.end();
  });
}

/**
 * Get an access token authorized to impersonate the configured GMAIL_SUBJECT.
 * @returns {Promise<{ access_token: string, expires_in: number }>}
 */
async function getAccessToken({ scope = DEFAULT_SCOPE, subject } = {}) {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const sub = subject || process.env.GMAIL_SUBJECT;
  if (!clientEmail) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL");
  if (!sub) throw new Error("Missing GMAIL_SUBJECT (workspace user to impersonate)");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    sub,
    scope,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(readPrivateKeyPem());
  const assertion = `${signingInput}.${base64url(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  }).toString();

  const res = await requestForm(TOKEN_URL, body);
  if (res.statusCode !== 200 || !res.json?.access_token) {
    const msg = res.json?.error_description || res.json?.error || res.raw?.slice(0, 300);
    throw new Error(`Google token error HTTP ${res.statusCode}: ${msg}`);
  }
  return res.json;
}

module.exports = { getAccessToken, DEFAULT_SCOPE, TOKEN_URL };
