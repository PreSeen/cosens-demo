// The safety scrub for any text that may reach the browser or the logs: service errors are shown as the service sent
// them, minus secrets, private names, model ids and internal hosts.

const terms = new Set();

/**
 * Words the deployment knows are private: the step 3 model id (and its name after the provider prefix) and the
 * service hosts, plus the DEMO_PRIVATE_NAMES setting (comma-separated). readConfig registers them, so every later scrub hides them.
 * @param {Array<string|null|undefined>} words
 */
export function addScrubTerms(words) {
  for (const word of words) {
    const value = String(word ?? '').trim();
    if (value.length >= 3) terms.add(value);
  }
}

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes URLs, bearer tokens, JWTs, refresh tokens, registered private names and model ids and internal hosts. */
export function scrubMessage(text) {
  let out = String(text ?? '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\bBearer\s+[^\s"',]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, '[token]')
    .replace(/\b(?:mcp_rt|sk|rt)_[\w-]{8,}/g, '[token]');
  // Longest first, so a model id inside a longer one leaves nothing behind.
  for (const term of [...terms].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escapeRe(term), 'gi'), '[private]');
  return out
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[host]')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:svc|cluster\.local|internal|local|lan)(?::\d+)?\b/gi, '[host]')
    .replace(/\b(?:localhost|[a-z][\w-]*)(?::\d{2,5})\b/gi, '[host]')
    .slice(0, 500);
}
