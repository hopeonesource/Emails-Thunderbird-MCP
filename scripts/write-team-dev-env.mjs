import fs from "node:fs";

const [
  ,
  ,
  salesforceJsonPath,
  googleJsonPath,
  envOutputPath,
  sfPrivateKeyPath,
  googleServiceAccountPath,
  googlePrivateKeyPath,
] = process.argv;

if (
  !salesforceJsonPath ||
  !googleJsonPath ||
  !envOutputPath ||
  !sfPrivateKeyPath ||
  !googleServiceAccountPath ||
  !googlePrivateKeyPath
) {
  console.error(
    "Usage: node scripts/write-team-dev-env.mjs <salesforce-json> <google-json> <env-output> <sf-key-path> <google-json-output> <google-key-path>"
  );
  process.exit(1);
}

function readJson(path, label) {
  const raw = fs.readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`${label} secret must be JSON: ${error.message}`);
    process.exit(1);
  }
}

function firstPresent(object, names) {
  for (const name of names) {
    if (object[name]) return String(object[name]);
  }
  return "";
}

function quoteEnv(value) {
  return JSON.stringify(String(value));
}

const sf = readJson(salesforceJsonPath, "Salesforce JWT");
const google = readJson(googleJsonPath, "Google service account");

const sfPrivateKey = firstPresent(sf, [
  "private_key",
  "privateKey",
  "SF_PRIVATE_KEY",
  "salesforce_private_key",
]);

if (!sfPrivateKey) {
  console.error(
    "Salesforce JWT secret is missing private_key/privateKey/SF_PRIVATE_KEY."
  );
  process.exit(1);
}

fs.writeFileSync(
  sfPrivateKeyPath,
  sfPrivateKey.endsWith("\n") ? sfPrivateKey : `${sfPrivateKey}\n`
);
fs.writeFileSync(googleServiceAccountPath, `${JSON.stringify(google, null, 2)}\n`);

const googlePrivateKey = firstPresent(google, [
  "private_key",
  "privateKey",
  "GOOGLE_PRIVATE_KEY",
]);

fs.writeFileSync(
  googlePrivateKeyPath,
  googlePrivateKey && googlePrivateKey.endsWith("\n")
    ? googlePrivateKey
    : `${googlePrivateKey}\n`
);

const sfClientId = firstPresent(sf, [
  "client_id",
  "clientId",
  "SF_CLIENT_ID",
  "consumer_key",
]);
const sfUsername = firstPresent(sf, [
  "username",
  "user",
  "SF_USERNAME",
  "salesforce_username",
]);
const sfLoginUrl =
  firstPresent(sf, ["login_url", "loginUrl", "SF_LOGIN_URL"]) ||
  "https://test.salesforce.com";
const googleEmail = firstPresent(google, [
  "client_email",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "email",
]);

const lines = [
  ["SF_CLIENT_ID", sfClientId],
  ["SF_USERNAME", sfUsername],
  ["SF_LOGIN_URL", sfLoginUrl],
  ["SF_PRIVATE_KEY_PATH", sfPrivateKeyPath],
  ["GOOGLE_SERVICE_ACCOUNT_EMAIL", googleEmail],
  ["GOOGLE_APPLICATION_CREDENTIALS", googleServiceAccountPath],
  ["GOOGLE_PRIVATE_KEY_PATH", googlePrivateKeyPath],
]
  .filter(([, value]) => value)
  .map(([name, value]) => `${name}=${quoteEnv(value)}`);

fs.writeFileSync(envOutputPath, `${lines.join("\n")}\n`);
