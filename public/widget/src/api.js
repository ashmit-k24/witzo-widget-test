/** Send a chat message to the webhook endpoint */
export async function sendMessage({ apiUrl, widgetKey, sessionId, message, language }) {
  const url = apiUrl.includes('?') ? `${apiUrl}&stream=1` : `${apiUrl}?stream=1`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream, application/json',
    },
    body: JSON.stringify({ widgetKey, message, sessionId, language }),
  });
}

/** Submit a thumbs-up / thumbs-down rating */
export async function submitRating({ apiBaseUrl, widgetKey, sessionId, rating }) {
  return fetch(`${apiBaseUrl}/api/v1/widget/rating`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widgetKey, sessionId, rating }),
  });
}

/** Submit the contact form (basic plan fallback) */
export async function submitContact({ apiBaseUrl, widgetKey, sessionId, name, email, phone, country, message }) {
  return fetch(`${apiBaseUrl}/api/v1/widget/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widgetKey, sessionId, name, email, phone, country, message }),
  });
}

/** Check whether the configured lead form fields are already captured for the session */
export async function getLeadStatus({ apiBaseUrl, widgetKey, sessionId }) {
  return fetch(`${apiBaseUrl}/api/v1/widget/lead-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widgetKey, sessionId }),
  });
}

/** Finalize a pending lead draft for the current session */
export async function finalizeLead({ apiBaseUrl, widgetKey, sessionId }) {
  return fetch(`${apiBaseUrl}/api/v1/widget/lead-finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widgetKey, sessionId }),
    keepalive: true,
  });
}

/** Track the current page as viewed by this session (fire-and-forget) */
export function trackPageView({ apiBaseUrl, widgetKey, sessionId }) {
  if (!apiBaseUrl || !widgetKey || !sessionId) return;
  const url = window.location.href;
  fetch(`${apiBaseUrl}/api/v1/widget/page-view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widgetKey, sessionId, url }),
  }).catch(() => {}); // non-critical, swallow errors
}
