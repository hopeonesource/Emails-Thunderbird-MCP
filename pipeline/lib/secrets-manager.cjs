"use strict";

const DEFAULT_SECRET_ENV_VARS = ["GOOGLE_SECRET_ID", "SF_SECRET_ID", "WEEKLY_DRAFTS_SECRET_IDS"];
const DEFAULT_ALLOWED_KEYS = [
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "SF_CLIENT_ID",
  "SF_CONSUMER_KEY",
  "SF_USERNAME",
  "SF_PRIVATE_KEY",
  "SF_LOGIN_URL",
];

function parseSecretIds(env = process.env, envVars = DEFAULT_SECRET_ENV_VARS) {
  const ids = [];
  for (const envVar of envVars) {
    const raw = env[envVar];
    if (!raw) continue;
    ids.push(...String(raw).split(",").map((s) => s.trim()).filter(Boolean));
  }
  return Array.from(new Set(ids));
}

function loadSecretsClient() {
  try {
    return require("@aws-sdk/client-secrets-manager");
  } catch {
    throw new Error(
      "Missing dependency '@aws-sdk/client-secrets-manager'. Run npm install before deploying Secrets Manager support."
    );
  }
}

function parseSecretPayload(secretId, response) {
  let raw = response.SecretString;
  if (!raw && response.SecretBinary) {
    raw =
      typeof response.SecretBinary === "string"
        ? Buffer.from(response.SecretBinary, "base64").toString("utf8")
        : Buffer.from(response.SecretBinary).toString("utf8");
  }
  if (!raw) throw new Error(`Secret ${secretId} did not contain SecretString or SecretBinary`);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Secret ${secretId} must be a JSON object: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Secret ${secretId} must be a JSON object`);
  }
  return parsed;
}

async function loadConfiguredSecrets(options = {}) {
  const env = options.env || process.env;
  const secretIds = options.secretIds || parseSecretIds(env);
  if (secretIds.length === 0) return { loadedSecretIds: [], loadedKeys: [] };

  const allowedKeys = new Set(options.allowedKeys || DEFAULT_ALLOWED_KEYS);
  const overwrite = options.overwrite === true;
  const client = options.client || (() => {
    const { SecretsManagerClient } = loadSecretsClient();
    return new SecretsManagerClient({ region: env.AWS_REGION || env.BEDROCK_REGION || "us-east-1" });
  })();
  const GetSecretValueCommandCtor = options.getSecretValueCommandCtor || (() => {
    const { GetSecretValueCommand } = loadSecretsClient();
    return GetSecretValueCommand;
  })();

  const loadedKeys = [];
  for (const secretId of secretIds) {
    const response = await client.send(new GetSecretValueCommandCtor({ SecretId: secretId }));
    const payload = parseSecretPayload(secretId, response);
    for (const [key, value] of Object.entries(payload)) {
      if (!allowedKeys.has(key)) continue;
      if (!overwrite && env[key]) continue;
      env[key] = String(value);
      loadedKeys.push(key);
    }
  }

  return {
    loadedSecretIds: secretIds,
    loadedKeys: Array.from(new Set(loadedKeys)),
  };
}

module.exports = {
  DEFAULT_ALLOWED_KEYS,
  DEFAULT_SECRET_ENV_VARS,
  loadConfiguredSecrets,
  parseSecretIds,
  parseSecretPayload,
};
