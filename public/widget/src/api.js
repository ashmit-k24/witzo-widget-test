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
export async function submitContact({ apiBaseUrl, widgetKey, sessionId, name, email, message }) {
  return fetch(`${apiBaseUrl}/api/v1/widget/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ widgetKey, sessionId, name, email, message }),
  });
}
