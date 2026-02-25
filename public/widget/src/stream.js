/**
 * Reads a Server-Sent Events stream from a fetch Response.
 * Calls onToken(assembledText) on every token received.
 * Returns { assembled, donePayload, hadError }.
 */
export async function consumeStream(response, onToken) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';
  let assembled = '';
  let donePayload = null;
  let hadError    = false;

  const handleEvent = (payload) => {
    if (!payload?.type) return;
    if (payload.type === 'token' && typeof payload.token === 'string') {
      assembled += payload.token;
      onToken(assembled);
    } else if (payload.type === 'done') {
      donePayload = payload;
    } else if (payload.type === 'error') {
      hadError = true;
    }
  };

  const parseChunk = (raw) => {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const json = line.slice(6).trim();
      if (!json) continue;
      try { handleEvent(JSON.parse(json)); } catch (_) {}
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    events.forEach(parseChunk);
  }

  // Flush any remaining data
  if (buffer.trim().startsWith('data:')) {
    parseChunk(buffer);
  }

  return { assembled, donePayload, hadError };
}
