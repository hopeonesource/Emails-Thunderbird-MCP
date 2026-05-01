"use strict";

const crypto = require("crypto");

/**
 * Bedrock-powered weekly email generator.
 *
 * Default model: anthropic.claude-sonnet-4-5 (override with BEDROCK_MODEL_ID).
 * The Bedrock client is loaded lazily so this module is fully unit-testable
 * without the AWS SDK installed (tests can inject a fake client).
 *
 * Output:
 *   { subject, htmlBody, markdownBody, modelId, sourceDataHash }
 */

const DEFAULT_MODEL_ID = "anthropic.claude-sonnet-4-5";
const SYSTEM_PROMPT = `You are an empathetic, concise weekly check-in email writer for a non-profit
called Hope1Source. You ONLY use the structured weekly data provided for the SPECIFIC account
in the user message. Never invent metrics, names, or events. Never reference data from any
other account. Output strictly valid JSON with keys "subject", "html", and "markdown".

Email constraints:
- Mobile-friendly HTML, max-width 600px, table-based layout, system fonts
- Friendly, plain language; no jargon
- Highlight 1-3 wins, 1-2 watch-outs, and a single clear next step
- Subject is short (<= 70 chars), specific, and personal to the account name
- Do not include unsubscribe links or sender boilerplate (the human reviewer adds those in Gmail)
- HTML must be self-contained (inline CSS only, no <script>, no remote images)
`;

function hashSourceData(data) {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

function buildUserMessage(accountWeeklyData) {
  return [
    "Generate a weekly check-in email for ONE Salesforce Account.",
    "Use ONLY this JSON. Do not reference any other account or data.",
    "",
    "```json",
    JSON.stringify(accountWeeklyData, null, 2),
    "```",
    "",
    'Respond with ONLY a JSON object: {"subject": "...", "html": "...", "markdown": "..."}.',
  ].join("\n");
}

function parseModelOutput(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new Error("Bedrock returned no text output");
  }
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const candidate = fenced ? fenced[1] : trimmed;
  let obj;
  try {
    obj = JSON.parse(candidate);
  } catch (e) {
    throw new Error(`Bedrock output was not valid JSON: ${e.message}`);
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("Bedrock output JSON was not an object");
  }
  const subject = String(obj.subject || "").trim();
  const html = String(obj.html || "").trim();
  const markdown = String(obj.markdown || "").trim();
  if (!subject || !html || !markdown) {
    throw new Error("Bedrock output missing subject/html/markdown");
  }
  return { subject, html, markdown };
}

function loadBedrockClient() {
  let mod;
  try {
    mod = require("@aws-sdk/client-bedrock-runtime");
  } catch (e) {
    throw new Error(
      "Missing dependency '@aws-sdk/client-bedrock-runtime'. Install it (added to package.json) before running outside dry-run."
    );
  }
  return mod;
}

/**
 * @param {object} accountWeeklyData per-account weekly data, scoped to a single accountId
 * @param {object} options
 * @param {string} [options.modelId]
 * @param {object} [options.client] inject a Bedrock client for tests
 * @param {string} [options.region]
 */
async function generateWeeklyEmail(accountWeeklyData, options = {}) {
  if (!accountWeeklyData || !accountWeeklyData.accountId) {
    throw new Error("accountWeeklyData.accountId is required (account isolation)");
  }
  const modelId = options.modelId || process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;
  const region = options.region || process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";
  const sourceDataHash = hashSourceData(accountWeeklyData);

  const bedrockClient = options.client || (() => {
    const { BedrockRuntimeClient } = loadBedrockClient();
    return new BedrockRuntimeClient({ region });
  })();

  const InvokeModelCommandCtor = options.invokeCommandCtor || (() => {
    const { InvokeModelCommand } = loadBedrockClient();
    return InvokeModelCommand;
  })();

  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1500,
    temperature: 0.4,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: buildUserMessage(accountWeeklyData) }],
      },
    ],
  };

  const cmd = new InvokeModelCommandCtor({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  });

  const resp = await bedrockClient.send(cmd);
  const respText =
    typeof resp.body === "string"
      ? resp.body
      : Buffer.isBuffer(resp.body)
        ? resp.body.toString("utf8")
        : new TextDecoder("utf-8").decode(resp.body);
  const parsedResp = JSON.parse(respText);
  const text =
    parsedResp?.content?.[0]?.text ||
    parsedResp?.output?.message?.content?.[0]?.text ||
    parsedResp?.completion ||
    "";
  const { subject, html, markdown } = parseModelOutput(text);

  return {
    subject,
    htmlBody: html,
    markdownBody: markdown,
    modelId,
    sourceDataHash,
  };
}

module.exports = {
  DEFAULT_MODEL_ID,
  SYSTEM_PROMPT,
  hashSourceData,
  buildUserMessage,
  parseModelOutput,
  generateWeeklyEmail,
};
