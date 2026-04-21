#!/usr/bin/env node
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const connPath = path.join(os.tmpdir(), "thunderbird-mcp", "connection.json");
let conn;
try {
  conn = JSON.parse(fs.readFileSync(connPath, "utf8"));
} catch {
  console.error("Missing %TEMP%\\thunderbird-mcp\\connection.json — start Thunderbird with MCP.");
  process.exit(1);
}

const bodyHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Segoe UI,Arial,sans-serif;line-height:1.6;color:#333;max-width:640px;margin:0 auto;padding:24px;">
<h1 style="color:#1a5f4a;margin-top:0;">Test run</h1>
<p>This is a <strong>test email</strong> sent through Thunderbird MCP. Dummy content below checks basic HTML formatting.</p>
<ul style="padding-left:1.25rem;">
<li>Placeholder note one</li>
<li>Placeholder note two</li>
</ul>
<p style="margin-bottom:0;color:#666;font-size:14px;">Thanks for running this <em>test email</em>.</p>
</body></html>`;

const payload = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "sendMail",
    arguments: {
      to: "veronicathornton27@gmail.com",
      from: "checkins@hope1source.me",
      subject: "test run email",
      body: bodyHtml,
      isHtml: true,
      skipReview: true,
    },
  },
});

const req = http.request(
  {
    hostname: "127.0.0.1",
    port: conn.port,
    path: "/",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${conn.token}`,
      "Content-Length": Buffer.byteLength(payload),
    },
  },
  (res) => {
    let d = "";
    res.on("data", (c) => {
      d += c;
    });
    res.on("end", () => {
      console.log("HTTP", res.statusCode);
      console.log(d);
    });
  }
);
req.on("error", (e) => console.error(e));
req.write(payload);
req.end();
