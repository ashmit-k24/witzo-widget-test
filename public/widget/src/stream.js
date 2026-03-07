/**
 * Reads a Server-Sent Events stream from a fetch Response.
 * Calls onToken(renderedText) with paced updates for smoother typing.
 * Returns { assembled, donePayload, hadError }.
 */
export async function consumeStream(response, onToken) {
  const TYPING_TICK_MS = 20;
  const BASE_CHARS_PER_TICK = 6;
  const getCharsPerTick = (pendingLen) => {
    if (pendingLen > 240) return 16;
    if (pendingLen > 120) return 12;
    if (pendingLen > 60) return 9;
    return BASE_CHARS_PER_TICK;
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';
  let assembled = '';
  let donePayload = null;
  let hadError    = false;
  let rendered    = '';
  let pending     = '';
  let isPumping   = false;

  const pump = async () => {
    if (isPumping) return;
    isPumping = true;
    while (pending.length > 0) {
      const charsPerTick = getCharsPerTick(pending.length);
      rendered += pending.slice(0, charsPerTick);
      pending = pending.slice(charsPerTick);
      onToken(rendered);
      await sleep(TYPING_TICK_MS);
    }
    isPumping = false;
  };

  const handleEvent = (payload) => {
    if (!payload?.type) return;
    if (payload.type === 'token' && typeof payload.token === 'string') {
      assembled += payload.token;
      pending += payload.token;
      void pump();
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

  while (isPumping || pending.length > 0) {
    if (!isPumping && pending.length > 0) {
      await pump();
      continue;
    }
    await sleep(TYPING_TICK_MS);
  }

  if (rendered !== assembled) {
    onToken(assembled);
  }

  return { assembled, donePayload, hadError };
}
