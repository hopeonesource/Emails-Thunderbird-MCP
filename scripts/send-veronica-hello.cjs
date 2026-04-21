#!/usr/bin/env node
"use strict";
/**
 * One-off friendly test message — plain body (wrapped as simple HTML by Thunderbird MCP).
 * Requires Thunderbird + MCP running; connection.json under os.tmpdir()/thunderbird-mcp/.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const connPath = path.join(os.tmpdir(), "thunderbird-mcp", "connection.json");
let conn;
try {
  conn = JSON.parse(fs.readFileSync(connPath, "utf8"));
} catch {
  console.error("Missing connection.json — start Thunderbird with Thunderbird MCP.");
  process.exit(1);
}

const body =
  "Hi Veronica,\n\n" +
  "Just sending a quick note from our new email account. Please reply \"received\" if this reached your inbox normally.\n\n" +
  "Thank you,\n" +
  "Tim";

const payload = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "sendMail",
    arguments: {
      to: "veronicathornton27@gmail.com",
      from: "checkins@hope1source.me",
      subject: "Quick hello from H1S Checkins",
      body,
      isHtml: false,
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
