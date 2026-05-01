"use strict";

const { querySoql } = require("./sf-rest.cjs");

/**
 * Eligibility filter for the weekly Bedrock email draft pipeline.
 *
 * Account record must have ALL of:
 *   - Send_Feedback_Emails__c = TRUE
 *   - Email__c                = FALSE   (treated as "email opt-out", per requirement)
 *   - Do_Not_Contact__c       = FALSE
 *   - AI_Insights_Enabled__c  = TRUE
 *
 * The Salesforce API names are configurable via env so they can be aligned with the
 * actual org schema without code changes.
 */

const FIELD_DEFAULTS = {
  sendFeedback: "Send_Feedback_Emails__c",
  emailOptOut: "Email__c",
  doNotContact: "Do_Not_Contact__c",
  aiInsights: "AI_Insights_Enabled__c",
};

function fieldNames() {
  return {
    sendFeedback: process.env.SF_FIELD_SEND_FEEDBACK || FIELD_DEFAULTS.sendFeedback,
    emailOptOut: process.env.SF_FIELD_EMAIL_OPT_OUT || FIELD_DEFAULTS.emailOptOut,
    doNotContact: process.env.SF_FIELD_DO_NOT_CONTACT || FIELD_DEFAULTS.doNotContact,
    aiInsights: process.env.SF_FIELD_AI_INSIGHTS || FIELD_DEFAULTS.aiInsights,
  };
}

function buildEligibilitySoql(extraSelect = []) {
  const f = fieldNames();
  const selectFields = [
    "Id",
    "Name",
    f.sendFeedback,
    f.emailOptOut,
    f.doNotContact,
    f.aiInsights,
    ...extraSelect,
  ];
  return [
    `SELECT ${selectFields.join(", ")}`,
    "FROM Account",
    `WHERE ${f.sendFeedback} = TRUE`,
    `AND ${f.emailOptOut} = FALSE`,
    `AND ${f.doNotContact} = FALSE`,
    `AND ${f.aiInsights} = TRUE`,
  ].join(" ");
}

function isEligible(accountRecord) {
  const f = fieldNames();
  return (
    accountRecord[f.sendFeedback] === true &&
    accountRecord[f.emailOptOut] === false &&
    accountRecord[f.doNotContact] === false &&
    accountRecord[f.aiInsights] === true
  );
}

/**
 * Fetch eligible Accounts from Salesforce.
 *
 * @param {object} sf  { instanceUrl, accessToken }
 * @param {string[]} extraSelect Additional Account fields to include in SELECT
 */
async function fetchEligibleAccounts(sf, extraSelect = []) {
  const soql = buildEligibilitySoql(extraSelect);
  const result = await querySoql(sf.instanceUrl, sf.accessToken, soql);
  return (result.records || []).filter(isEligible);
}

module.exports = {
  FIELD_DEFAULTS,
  fieldNames,
  buildEligibilitySoql,
  isEligible,
  fetchEligibleAccounts,
};
