"use strict";

const https = require("https");
const { URL } = require("url");

/**
 * Minimal Salesforce REST client built on top of the JWT access token + instance URL
 * that pipeline/lib/salesforce-jwt.cjs already produces. Keeps the repo dep-free.
 *
 * All write paths (POST/PATCH) target the standard /services/data/v59.0 REST API.
 */

function joinUrl(base, pathPart) {
  return `${base.replace(/\/+$/u, "")}${pathPart.startsWith("/") ? "" : "/"}${pathPart}`;
}

function request(options, postBody) {
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
          json = raw ? JSON.parse(raw) : null;
        } catch {
          /* leave json null */
        }
        resolve({ statusCode: res.statusCode, json, raw, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (postBody !== undefined && postBody !== null) req.write(postBody);
    req.end();
  });
}

function authHeader(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function querySoql(instanceUrl, accessToken, soql) {
  const u = new URL(joinUrl(instanceUrl, `/services/data/v59.0/query?q=${encodeURIComponent(soql)}`));
  const res = await request({
    hostname: u.hostname,
    port: 443,
    path: `${u.pathname}${u.search}`,
    method: "GET",
    headers: { ...authHeader(accessToken) },
  });
  if (res.statusCode !== 200 || !res.json) {
    const msg = (res.json && (res.json[0]?.message || res.json.message)) || res.raw?.slice(0, 400);
    throw new Error(`Salesforce SOQL failed HTTP ${res.statusCode}: ${msg}`);
  }
  return res.json;
}

async function createSObject(instanceUrl, accessToken, sobjectName, body) {
  const u = new URL(joinUrl(instanceUrl, `/services/data/v59.0/sobjects/${encodeURIComponent(sobjectName)}`));
  const json = JSON.stringify(body);
  const res = await request(
    {
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: "POST",
      headers: {
        ...authHeader(accessToken),
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(json),
      },
    },
    json
  );
  if (res.statusCode !== 201 || !res.json || !res.json.id) {
    const msg = (res.json && (res.json[0]?.message || res.json.message)) || res.raw?.slice(0, 400);
    throw new Error(`Salesforce create ${sobjectName} failed HTTP ${res.statusCode}: ${msg}`);
  }
  return res.json;
}

async function updateSObject(instanceUrl, accessToken, sobjectName, id, body) {
  const u = new URL(joinUrl(instanceUrl, `/services/data/v59.0/sobjects/${encodeURIComponent(sobjectName)}/${encodeURIComponent(id)}`));
  const json = JSON.stringify(body);
  const res = await request(
    {
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: "PATCH",
      headers: {
        ...authHeader(accessToken),
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(json),
      },
    },
    json
  );
  if (res.statusCode !== 204) {
    const msg = (res.json && (res.json[0]?.message || res.json.message)) || res.raw?.slice(0, 400);
    throw new Error(`Salesforce update ${sobjectName}/${id} failed HTTP ${res.statusCode}: ${msg}`);
  }
  return { id, success: true };
}

/**
 * Create a Salesforce File (ContentVersion) and link it to a parent record.
 * Returns { contentVersionId, contentDocumentId, contentDocumentLinkId }.
 */
async function uploadFileToRecord(instanceUrl, accessToken, parentId, filename, mimeType, contentBuffer) {
  const cv = await createSObject(instanceUrl, accessToken, "ContentVersion", {
    Title: filename,
    PathOnClient: filename,
    VersionData: contentBuffer.toString("base64"),
    FirstPublishLocationId: parentId,
  });

  const cvDetails = await request(
    {
      hostname: new URL(instanceUrl).hostname,
      port: 443,
      path: `/services/data/v59.0/sobjects/ContentVersion/${cv.id}?fields=ContentDocumentId`,
      method: "GET",
      headers: { ...authHeader(accessToken) },
    },
  );
  if (cvDetails.statusCode !== 200 || !cvDetails.json?.ContentDocumentId) {
    throw new Error(`Failed to read ContentVersion ${cv.id}`);
  }
  return {
    contentVersionId: cv.id,
    contentDocumentId: cvDetails.json.ContentDocumentId,
    mimeType,
  };
}

module.exports = { querySoql, createSObject, updateSObject, uploadFileToRecord };
