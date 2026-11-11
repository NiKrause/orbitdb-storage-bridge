/**
 * Aleph's decision about a message, said so that one log line is enough:
 * the status, the error code, whether the wait ran out, and Aleph's details.
 * Shared by the live Aleph suites, so a failure reads the same everywhere.
 *
 * @param {string} what - e.g. "STORE <item hash> (cid <cid>) via /api/v0/ipfs/add_file"
 * @param {{ status: string, errorCode?: number, timedOut?: boolean, details?: unknown }} final
 * @param {string} [hint] - what the error code means here
 */
export const describeStatus = (what, final, hint) =>
  `${what}: ${final.status}` +
  (final.errorCode != null ? `, error_code ${final.errorCode}` : "") +
  (hint ? ` — ${hint}` : "") +
  (final.timedOut ? " (still pending when the wait ran out)" : "") +
  (final.details ? ` — ${JSON.stringify(final.details).slice(0, 300)}` : "");
