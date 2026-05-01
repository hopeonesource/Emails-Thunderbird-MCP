"use strict";

/**
 * Compute the ISO week window (Monday..Sunday) that contains the given date.
 * Returns { weekStart: 'YYYY-MM-DD', weekEnd: 'YYYY-MM-DD' } in UTC.
 */
function isoWeekWindow(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayOfWeek = d.getUTCDay();
  const offsetToMonday = (dayOfWeek + 6) % 7;
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - offsetToMonday);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { weekStart: toIsoDate(start), weekEnd: toIsoDate(end) };
}

function toIsoDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

module.exports = { isoWeekWindow, toIsoDate };
