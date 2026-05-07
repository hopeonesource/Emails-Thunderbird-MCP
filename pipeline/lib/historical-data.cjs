"use strict";

const { querySoql, createSObject, updateSObject, uploadFileToRecord } = require("./sf-rest.cjs");

/**
 * Salesforce Historical_Data__c read + writeback.
 *
 * Fields (override field API names with env if needed):
 *   Account__c                 (Master-Detail or Lookup to Account)
 *   Gmail_Draft_Id__c          Text
 *   Gmail_Thread_Id__c         Text
 *   Bedrock_Model__c           Text
 *   Source_Data_Hash__c        Text
 *   Status__c                  Picklist (draft_created, sent, failed, skipped)
 *
 * The latest Historical_Data__c is also the source for weekly rollup metrics
 * and is updated in-place after the Gmail draft is created.
 */

const FIELD_DEFAULTS = {
  object: "Historical_Data__c",
  account: "Account__c",
  dateOfGeneration: "Date_of_Generation__c",
  weekStart: "",
  weekEnd: "",
  draftId: "Gmail_Draft_Id__c",
  threadId: "Gmail_Thread_Id__c",
  model: "Bedrock_Model__c",
  hash: "Source_Data_Hash__c",
  status: "Status__c",
  feedbackObject: "Service_Provider_Feedback__c",
  feedbackAccount: "Account__c",
  feedbackContact: "Contact__c",
  feedbackSubmissionDate: "Submission_Date__c",
  feedbackRating: "Rating__c",
  feedbackDescription: "Description__c",
  feedbackHopeful: "How_Hopeful_Are_You__c",
  feedbackMoreHopeful: "What_would_make_you_more_hopeful__c",
  contactLastFeedbackEmailSent: "Last_Feedback_Email_Sent__c",
};

function fieldNames() {
  return {
    object: process.env.SF_HD_OBJECT || FIELD_DEFAULTS.object,
    account: process.env.SF_HD_ACCOUNT || FIELD_DEFAULTS.account,
    dateOfGeneration: process.env.SF_HD_DATE_OF_GENERATION || FIELD_DEFAULTS.dateOfGeneration,
    weekStart: process.env.SF_HD_WEEK_START || FIELD_DEFAULTS.weekStart,
    weekEnd: process.env.SF_HD_WEEK_END || FIELD_DEFAULTS.weekEnd,
    draftId: process.env.SF_HD_DRAFT_ID || FIELD_DEFAULTS.draftId,
    threadId: process.env.SF_HD_THREAD_ID || FIELD_DEFAULTS.threadId,
    model: process.env.SF_HD_MODEL || FIELD_DEFAULTS.model,
    hash: process.env.SF_HD_HASH || FIELD_DEFAULTS.hash,
    status: process.env.SF_HD_STATUS || FIELD_DEFAULTS.status,
    feedbackObject: process.env.SF_FEEDBACK_OBJECT || FIELD_DEFAULTS.feedbackObject,
    feedbackAccount: process.env.SF_FEEDBACK_ACCOUNT || FIELD_DEFAULTS.feedbackAccount,
    feedbackContact: process.env.SF_FEEDBACK_CONTACT || FIELD_DEFAULTS.feedbackContact,
    feedbackSubmissionDate: process.env.SF_FEEDBACK_SUBMISSION_DATE || FIELD_DEFAULTS.feedbackSubmissionDate,
    feedbackRating: process.env.SF_FEEDBACK_RATING || FIELD_DEFAULTS.feedbackRating,
    feedbackDescription: process.env.SF_FEEDBACK_DESCRIPTION || FIELD_DEFAULTS.feedbackDescription,
    feedbackHopeful: process.env.SF_FEEDBACK_HOPEFUL || FIELD_DEFAULTS.feedbackHopeful,
    feedbackMoreHopeful: process.env.SF_FEEDBACK_MORE_HOPEFUL || FIELD_DEFAULTS.feedbackMoreHopeful,
    contactLastFeedbackEmailSent:
      process.env.SF_FIELD_LAST_FEEDBACK_EMAIL_SENT || FIELD_DEFAULTS.contactLastFeedbackEmailSent,
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
  const days = Number(process.env.SF_HD_IDEMPOTENCY_WINDOW_DAYS || 7);
  const soql =
    `SELECT Id, ${f.status} FROM ${f.object} ` +
    `WHERE ${f.account} = '${escapeSoqlString(accountId)}' ` +
    `AND ${f.dateOfGeneration} = LAST_N_DAYS:${days} ` +
    `AND ${f.status} IN ('draft_created', 'sent') LIMIT 1`;
  const result = await querySoql(instanceUrl, accessToken, soql);
  return Array.isArray(result.records) && result.records.length > 0;
}

async function fetchLatestHistoricalData({ instanceUrl, accessToken }, accountId) {
  const f = fieldNames();
  const metricFields = [
    "Id",
    f.account,
    f.dateOfGeneration,
    "Total_Feedback__c",
    "Feedback_Last_7_Days__c",
    "Feedback_Last_30_Days__c",
    "Avg_Rating_All_Time__c",
    "Last_7_Days_Rating_Avg__c",
    "Weekly_Last_7_Days_Change__c",
    "Weekly_Last_7_Days_Rating_Change__c",
    "Total_of_5_Star_Reviews__c",
    "Weekly_5_Star_Review_Change__c",
    f.draftId,
    f.threadId,
    f.model,
    f.hash,
    f.status,
  ];
  const soql =
    `SELECT ${metricFields.join(", ")} FROM ${f.object} ` +
    `WHERE ${f.account} = '${escapeSoqlString(accountId)}' ` +
    `ORDER BY ${f.dateOfGeneration} DESC NULLS LAST LIMIT 1`;
  const result = await querySoql(instanceUrl, accessToken, soql);
  return result.records?.[0] || null;
}

async function fetchRecentClientFeedback({ instanceUrl, accessToken }, accountId) {
  const f = fieldNames();
  const days = Number(process.env.SF_FEEDBACK_WINDOW_DAYS || 7);
  const soql =
    `SELECT Id, ${f.feedbackAccount}, ${f.feedbackContact}, ${f.feedbackSubmissionDate}, ` +
    `${f.feedbackRating}, ${f.feedbackDescription}, ${f.feedbackHopeful}, ${f.feedbackMoreHopeful} ` +
    `FROM ${f.feedbackObject} ` +
    `WHERE ${f.feedbackAccount} = '${escapeSoqlString(accountId)}' ` +
    `AND Contact__r.RecordType.DeveloperName = 'Client' ` +
    `AND ${f.feedbackSubmissionDate} = LAST_N_DAYS:${days} ` +
    `ORDER BY ${f.feedbackSubmissionDate} DESC LIMIT 25`;
  const result = await querySoql(instanceUrl, accessToken, soql);
  return result.records || [];
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
    historicalDataId,
    status = "draft_created",
  }
) {
  if (!accountId) throw new Error("recordWeeklyHistory: accountId required");
  const f = fieldNames();
  const body = {
    [f.account]: accountId,
    [f.draftId]: draftId,
    [f.threadId]: threadId,
    [f.model]: bedrockModelId,
    [f.hash]: sourceDataHash,
    [f.status]: status,
  };
  if (f.weekStart) body[f.weekStart] = weekStartIso;
  if (f.weekEnd) body[f.weekEnd] = weekEndIso;

  const created = historicalDataId
    ? await updateExistingHistoricalData(instanceUrl, accessToken, f.object, historicalDataId, body)
    : await createSObject(instanceUrl, accessToken, f.object, body);

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

async function updateExistingHistoricalData(instanceUrl, accessToken, objectName, id, body) {
  await updateSObject(instanceUrl, accessToken, objectName, id, body);
  return { id, success: true };
}

async function stampFeedbackEmailSent({ instanceUrl, accessToken }, contactIds, sentDateIso) {
  const uniqueIds = Array.from(new Set(contactIds.filter(Boolean)));
  const updates = [];
  const f = fieldNames();

  for (const contactId of uniqueIds) {
    updates.push(
      updateSObject(instanceUrl, accessToken, "Contact", contactId, {
        [f.contactLastFeedbackEmailSent]: sentDateIso,
      })
    );
  }

  return Promise.all(updates);
}

module.exports = {
  FIELD_DEFAULTS,
  fieldNames,
  existsForWeek,
  fetchLatestHistoricalData,
  fetchRecentClientFeedback,
  recordWeeklyHistory,
  stampFeedbackEmailSent,
};
