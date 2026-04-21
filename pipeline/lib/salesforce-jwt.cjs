#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");

function base64url(input) {
  return Buffer.isBuffer(input)
    ? input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "")
    : base64url(Buffer.from(input, "utf8"));
}

function readPrivateKeyPem() {
  const path = process.env.SF_PRIVATE_KEY_PATH;
  const inline = process.env.SF_PRIVATE_KEY;
  if (path) {
    const fs = require("fs");
    return fs.readFileSync(path, "utf8");
  }
  if (inline) {
    return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
  }
  throw new Error("Set SF_PRIVATE_KEY (PEM) or SF_PRIVATE_KEY_PATH for Salesforce JWT auth");
}

/**
 * Build JWT and exchange for access_token (Salesforce OAuth 2.0 JWT bearer flow).
 * @returns {Promise<{ access_token: string, instance_url: string }>}
 */
async function getJwtAccessToken() {
  const clientId = process.env.SF_CLIENT_ID || process.env.SF_CONSUMER_KEY;
  const username = process.env.SF_USERNAME;
  const loginUrl = (process.env.SF_LOGIN_URL || "https://login.salesforce.com").replace(/\/+$/u, "");
  if (!clientId) throw new Error("Missing SF_CLIENT_ID (Connected App consumer key)");
  if (!username) throw new Error("Missing SF_USERNAME (integration user)");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256" };
  const payload = {
    iss: clientId,
    sub: username,
    aud: loginUrl,
    exp: now + 180,
  };
  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign(readPrivateKeyPem());
  const assertion = `${signingInput}.${base64url(signature)}`;

  const tokenUrl = `${loginUrl}/services/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  }).toString();

  const u = new URL(tokenUrl);
  const res = await requestJson(
    {
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    body
  );

  if (res.statusCode !== 200 || !res.json) {
    const msg = res.json && (res.json.error_description || res.json.error);
    throw new Error(`Salesforce token error HTTP ${res.statusCode}: ${msg || res.raw?.slice(0, 400)}`);
  }
  if (!res.json.access_token || !res.json.instance_url) {
    throw new Error("Salesforce token response missing access_token or instance_url");
  }
  return {
    access_token: res.json.access_token,
    instance_url: res.json.instance_url,
  };
}

function requestJson(options, postBody) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
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
    });
    req.on("error", reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

/**
 * Run a SOQL query (first page only).
 * @param {string} instanceUrl
 * @param {string} accessToken
 * @param {string} soql
 */
async function querySoql(instanceUrl, accessToken, soql) {
  const base = instanceUrl.replace(/\/+$/u, "");
  const q = `${base}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
  const u = new URL(q);
  const res = await requestJson({
    hostname: u.hostname,
    port: 443,
    path: `${u.pathname}${u.search}`,
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.statusCode !== 200 || !res.json) {
    const msg = res.json && (res.json[0] && res.json[0].message) || res.json?.message;
    throw new Error(`Salesforce query failed HTTP ${res.statusCode}: ${msg || res.raw?.slice(0, 500)}`);
  }
  return res.json;
}

module.exports = { getJwtAccessToken, querySoql };
