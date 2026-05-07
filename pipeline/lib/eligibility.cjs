"use strict";

const { querySoql } = require("./sf-rest.cjs");

/**
 * Eligibility filter for the weekly Bedrock email draft pipeline.
 *
 * Eligibility starts from Contact, then groups back to one draft per Account:
 *   - Contact.RecordType.DeveloperName = "Service_Provider"
 *   - Contact.Send_Feedback_Emails__c = TRUE
 *   - Contact.npsp__Do_Not_Contact__c = FALSE
 *   - Contact.Email != NULL
 *   - Contact.Account.AI_Insights_Enabled__c = TRUE
 *
 * The Salesforce API names are configurable via env so they can be aligned with the
 * actual org schema without code changes.
 */

const FIELD_DEFAULTS = {
  accountAiInsights: "AI_Insights_Enabled__c",
  sendFeedback: "Send_Feedback_Emails__c",
  contactDoNotContact: "npsp__Do_Not_Contact__c",
  contactEmail: "Email",
  contactRecordTypeDeveloperName: "RecordType.DeveloperName",
  serviceProviderRecordType: "Service_Provider",
  lastFeedbackEmailSent: "Last_Feedback_Email_Sent__c",
};

function fieldNames() {
  return {
    accountAiInsights: process.env.SF_FIELD_ACCOUNT_AI_INSIGHTS || FIELD_DEFAULTS.accountAiInsights,
    sendFeedback: process.env.SF_FIELD_SEND_FEEDBACK || FIELD_DEFAULTS.sendFeedback,
    contactDoNotContact: process.env.SF_FIELD_CONTACT_DO_NOT_CONTACT || FIELD_DEFAULTS.contactDoNotContact,
    contactEmail: process.env.SF_FIELD_CONTACT_EMAIL || FIELD_DEFAULTS.contactEmail,
    contactRecordTypeDeveloperName:
      process.env.SF_FIELD_CONTACT_RECORD_TYPE || FIELD_DEFAULTS.contactRecordTypeDeveloperName,
    serviceProviderRecordType: process.env.SF_SERVICE_PROVIDER_RECORD_TYPE || FIELD_DEFAULTS.serviceProviderRecordType,
    lastFeedbackEmailSent: process.env.SF_FIELD_LAST_FEEDBACK_EMAIL_SENT || FIELD_DEFAULTS.lastFeedbackEmailSent,
  };
}

function buildEligibilitySoql(extraSelect = []) {
  const f = fieldNames();
  const selectFields = [
    "Id",
    "FirstName",
    "LastName",
    f.contactEmail,
    "AccountId",
    "Account.Name",
    `Account.${f.accountAiInsights}`,
    f.lastFeedbackEmailSent,
    f.contactRecordTypeDeveloperName,
    f.sendFeedback,
    f.contactDoNotContact,
    ...extraSelect,
  ];
  return [
    `SELECT ${selectFields.join(", ")}`,
    "FROM Contact",
    `WHERE ${f.contactRecordTypeDeveloperName} = '${f.serviceProviderRecordType}'`,
    `AND Account.${f.accountAiInsights} = TRUE`,
    `AND ${f.sendFeedback} = TRUE`,
    `AND ${f.contactDoNotContact} = FALSE`,
    `AND ${f.contactEmail} != NULL`,
  ].join(" ");
}

function isEligible(contactRecord) {
  const f = fieldNames();
  return (
    contactRecord[f.sendFeedback] === true &&
    contactRecord[f.contactDoNotContact] === false &&
    Boolean(contactRecord[f.contactEmail]) &&
    contactRecord.RecordType?.DeveloperName === f.serviceProviderRecordType &&
    contactRecord.Account?.[f.accountAiInsights] === true
  );
}

/**
 * Fetch eligible Service Provider Contacts, then group to one draft per Account.
 *
 * @param {object} sf  { instanceUrl, accessToken }
 * @param {string[]} extraSelect Additional Contact fields to include in SELECT
 */
async function fetchEligibleAccounts(sf, extraSelect = []) {
  const soql = buildEligibilitySoql(extraSelect);
  const result = await querySoql(sf.instanceUrl, sf.accessToken, soql);
  return groupEligibleContactsByAccount((result.records || []).filter(isEligible));
}

function groupEligibleContactsByAccount(contactRecords) {
  const byAccount = new Map();
  const f = fieldNames();

  for (const contact of contactRecords) {
    if (!contact.AccountId) continue;

    if (!byAccount.has(contact.AccountId)) {
      byAccount.set(contact.AccountId, {
        Id: contact.AccountId,
        Name: contact.Account?.Name || "",
        accountId: contact.AccountId,
        accountName: contact.Account?.Name || "",
        recipients: [],
      });
    }

    byAccount.get(contact.AccountId).recipients.push({
      contactId: contact.Id,
      firstName: contact.FirstName || "",
      lastName: contact.LastName || "",
      email: contact[f.contactEmail],
      lastFeedbackEmailSent: contact[f.lastFeedbackEmailSent] || null,
    });
  }

  return Array.from(byAccount.values());
}

module.exports = {
  FIELD_DEFAULTS,
  fieldNames,
  buildEligibilitySoql,
  isEligible,
  fetchEligibleAccounts,
  groupEligibleContactsByAccount,
};
