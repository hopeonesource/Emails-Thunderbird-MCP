"use strict";

const DEFAULT_SECRET_IDS = [
  "hope1source/hop43/salesforce-jwt",
  "hope1source/hop43/google-service-account",
];

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function secretIdsFromEnv(env = process.env) {
  const explicit = parseCsv(env.HOP43_SECRET_IDS);
  if (explicit.length > 0) return explicit;

  return [
    env.HOP43_SF_SECRET_ID || DEFAULT_SECRET_IDS[0],
    env.HOP43_GOOGLE_SECRET_ID || DEFAULT_SECRET_IDS[1],
  ];
}

function loadSecretsManagerClient() {
  let mod;
  try {
    mod = require("@aws-sdk/client-secrets-manager");
  } catch (e) {
    throw new Error(
      "Missing dependency '@aws-sdk/client-secrets-manager'. Install dependencies before running with HOP43_SECRET_SOURCE=aws."
    );
  }
  return mod;
}

async function readSecretJson({ client, GetSecretValueCommandCtor, secretId }) {
  const resp = await client.send(new GetSecretValueCommandCtor({ SecretId: secretId }));
  if (!resp.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString JSON payload`);
  }

  let parsed;
  try {
    parsed = JSON.parse(resp.SecretString);
  } catch (e) {
    throw new Error(`Secret ${secretId} must be a JSON object: ${e.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Secret ${secretId} must be a JSON object`);
  }
  return parsed;
}

async function loadAwsSecretsIntoEnv(options = {}) {
  const env = options.env || process.env;
  const source = String(options.source || env.HOP43_SECRET_SOURCE || "").toLowerCase();
  if (source !== "aws") {
    return { loaded: false, reason: "HOP43_SECRET_SOURCE is not aws", secretIds: [] };
  }

  const secretIds = options.secretIds || secretIdsFromEnv(env);
  const region = options.region || env.AWS_REGION || env.BEDROCK_REGION || "us-east-1";
  const client =
    options.client ||
    (() => {
      const { SecretsManagerClient } = loadSecretsManagerClient();
      return new SecretsManagerClient({ region });
    })();
  const GetSecretValueCommandCtor =
    options.GetSecretValueCommandCtor ||
    (() => {
      const { GetSecretValueCommand } = loadSecretsManagerClient();
      return GetSecretValueCommand;
    })();

  const keys = [];
  for (const secretId of secretIds) {
    const secret = await readSecretJson({ client, GetSecretValueCommandCtor, secretId });
    for (const [key, value] of Object.entries(secret)) {
      if (value === undefined || value === null) continue;
      env[key] = String(value);
      keys.push(key);
    }
  }

  return { loaded: true, region, secretIds, keys };
}

module.exports = {
  DEFAULT_SECRET_IDS,
  secretIdsFromEnv,
  loadAwsSecretsIntoEnv,
};
