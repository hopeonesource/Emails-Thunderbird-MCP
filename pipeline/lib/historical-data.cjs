"use strict";

const { querySoql, createSObject, uploadFileToRecord } = require("./sf-rest.cjs");

/**
 * Salesforce Historical_Data__c writeback.
 *
 * Fields (override field API names with env if needed):
 *   Account__c                 (Master-Detail or Lookup to Account)
 *   Week_Start__c              Date
 *   Week_End__c                Date
 *   Gmail_Draft_Id__c          Text
 *   Gmail_Thread_Id__c         Text
 *   Bedrock_Model__c           Text
 *   Source_Data_Hash__c        Text
 *   Status__c                  Picklist (draft_created, sent, failed, skipped)
 */

const FIELD_DEFAULTS = {
  object: "Historical_Data__c",
  account: "Account__c",
  weekStart: "Week_Start__c",
  weekEnd: "Week_End__c",
  draftId: "Gmail_Draft_Id__c",
  threadId: "Gmail_Thread_Id__c",
  model: "Bedrock_Model__c",
  hash: "Source_Data_Hash__c",
  status: "Status__c",
};

function fieldNames() {
  return {
    object: process.env.SF_HD_OBJECT || FIELD_DEFAULTS.object,
    account: process.env.SF_HD_ACCOUNT || FIELD_DEFAULTS.account,
    weekStart: process.env.SF_HD_WEEK_START || FIELD_DEFAULTS.weekStart,
    weekEnd: process.env.SF_HD_WEEK_END || FIELD_DEFAULTS.weekEnd,
    draftId: process.env.SF_HD_DRAFT_ID || FIELD_DEFAULTS.draftId,
    threadId: process.env.SF_HD_THREAD_ID || FIELD_DEFAULTS.threadId,
    model: process.env.SF_HD_MODEL || FIELD_DEFAULTS.model,
    hash: process.env.SF_HD_HASH || FIELD_DEFAULTS.hash,
    status: process.env.SF_HD_STATUS || FIELD_DEFAULTS.status,
  };
}

function escapeSoqlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Returns true if a Historical_Data__c already exists for (accountId, weekStart)
 * with a non-failed status. Used for idempotency in the orchestrator.
 */
async function existsForWeek({ instanceUrl, accessToken }, accountId, weekStartIso) {
  const f = fieldNames();
  const soql =
    `SELECT Id, ${f.status} FROM ${f.object} ` +
    `WHERE ${f.account} = '${escapeSoqlString(accountId)}' ` +
    `AND ${f.weekStart} = ${weekStartIso} ` +
    `AND ${f.status} IN ('draft_created', 'sent') LIMIT 1`;
  const result = await querySoql(instanceUrl, accessToken, soql);
  return Array.isArray(result.records) && result.records.length > 0;
}

/**
 * Create a Historical_Data__c record + attach Markdown rendering as a Salesforce File.
 * @returns {Promise<{ recordId: string, contentVersionId: string, contentDocumentId: string }>}
 */
async function recordWeeklyHistory(
  { instanceUrl, accessToken },
  {
    accountId,
    weekStartIso,
    weekEndIso,
    draftId,
    threadId,
    bedrockModelId,
    sourceDataHash,
    markdownBody,
    status = "draft_created",
  }
) {
  if (!accountId) throw new Error("recordWeeklyHistory: accountId required");
  const f = fieldNames();
  const body = {
    [f.account]: accountId,
    [f.weekStart]: weekStartIso,
    [f.weekEnd]: weekEndIso,
    [f.draftId]: draftId,
    [f.threadId]: threadId,
    [f.model]: bedrockModelId,
    [f.hash]: sourceDataHash,
    [f.status]: status,
  };

  const created = await createSObject(instanceUrl, accessToken, f.object, body);

  let fileInfo = null;
  if (markdownBody) {
    const filename = `weekly-checkin-email-${weekStartIso}.md`;
    fileInfo = await uploadFileToRecord(
      instanceUrl,
      accessToken,
      created.id,
      filename,
      "text/markdown",
      Buffer.from(markdownBody, "utf8")
    );
  }

  return {
    recordId: created.id,
    contentVersionId: fileInfo?.contentVersionId || null,
    contentDocumentId: fileInfo?.contentDocumentId || null,
  };
}

module.exports = {
  FIELD_DEFAULTS,
  fieldNames,
  existsForWeek,
  recordWeeklyHistory,
};
