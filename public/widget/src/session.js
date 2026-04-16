const SESSION_KEY = 'witzo_chat_session_token';
const COUNT_KEY   = 'witzo_chat_count';
const DATE_KEY    = 'witzo_chat_date';

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/** Initialize or restore session from sessionStorage */
export function initSession() {
  const storedDate = sessionStorage.getItem(DATE_KEY);
  const date = storedDate ? new Date(storedDate) : new Date();
  if (!storedDate) sessionStorage.setItem(DATE_KEY, date.toISOString());

  const storedCount = sessionStorage.getItem(COUNT_KEY);
  const count = storedCount ? Number(storedCount) : 0;
  if (!storedCount) sessionStorage.setItem(COUNT_KEY, '0');

  let sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = generateUUID();
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }

  return { date, count, sessionId };
}

export function updateSessionId(id) {
  sessionStorage.setItem(SESSION_KEY, id);
}

export function incrementChatCount(current) {
  const next = current + 1;
  sessionStorage.setItem(COUNT_KEY, `${next}`);
  return next;
}

/* --- Rating state --- */
const ratingShownKey     = (id) => `witzo_chat_rating_shown_${id}`;
const ratingSubmittedKey = (id) => `witzo_chat_rating_submitted_${id}`;

export const getRatingShown     = (id) => sessionStorage.getItem(ratingShownKey(id)) === '1';
export const getRatingSubmitted = (id) => sessionStorage.getItem(ratingSubmittedKey(id)) === '1';
export const setRatingShown     = (id, v) => sessionStorage.setItem(ratingShownKey(id), v ? '1' : '0');
export const setRatingSubmitted = (id, v) => sessionStorage.setItem(ratingSubmittedKey(id), v ? '1' : '0');

/* --- Lead form completion state --- */
const leadFormCompletedKey = (widgetKey, sessionId) => `witzo_chat_lead_form_completed_${widgetKey || 'default'}_${sessionId}`;

export const getLeadFormCompleted = (widgetKey, sessionId) =>
  sessionStorage.getItem(leadFormCompletedKey(widgetKey, sessionId)) === '1';

export const setLeadFormCompleted = (widgetKey, sessionId, v) =>
  sessionStorage.setItem(leadFormCompletedKey(widgetKey, sessionId), v ? '1' : '0');

/* --- Language preference --- */
export const getLanguageKey = (widgetKey) => `witzo_chat_language_${widgetKey || 'default'}`;

export function normalizeLanguage(value, supported) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  return supported.some(l => l.code === code) ? code : null;
}

/* --- Daily message limit (resets after 24 hours, survives page reloads) --- */
export const DAILY_MSG_LIMIT = 20;
const dailyCountKey = (wk) => `witzo_daily_count_${wk || 'default'}`;
const dailyStartKey = (wk) => `witzo_daily_start_${wk || 'default'}`;

export function getDailyCount(widgetKey) {
  const start = localStorage.getItem(dailyStartKey(widgetKey));
  if (!start) return 0;
  if (Date.now() - new Date(start).getTime() > 24 * 60 * 60 * 1000) {
    localStorage.removeItem(dailyStartKey(widgetKey));
    localStorage.removeItem(dailyCountKey(widgetKey));
    return 0;
  }
  return parseInt(localStorage.getItem(dailyCountKey(widgetKey)) || '0', 10);
}

export function incrementDailyCount(widgetKey) {
  if (!localStorage.getItem(dailyStartKey(widgetKey))) {
    localStorage.setItem(dailyStartKey(widgetKey), new Date().toISOString());
  }
  const next = getDailyCount(widgetKey) + 1;
  localStorage.setItem(dailyCountKey(widgetKey), `${next}`);
  return next;
}

export function isDailyLimitReached(widgetKey) {
  return getDailyCount(widgetKey) >= DAILY_MSG_LIMIT;
}
