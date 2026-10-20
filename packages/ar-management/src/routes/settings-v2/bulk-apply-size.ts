/**
 * How big a bulk apply answer can get. The answer of a request is kept by the idempotency
 * middleware for a replay, which keeps at most 1 MiB of UTF-8; an answer over it is neither kept
 * nor replayable and leaves the key reserved. So a value is never repeated whole in an answer (a
 * long one is summarised), a request whose answer could pass the limit is refused before anything
 * is done, and every size here is a count of bytes of the JSON text, not of characters (a
 * character is up to four bytes, and a quote, a backslash or a control character is two to six).
 */

const encoder = new TextEncoder();

/** The bytes of a value as it appears in a JSON answer. */
export function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : encoder.encode(json).length;
}

/** A value of more than this many bytes (as JSON) is summarised in an answer. */
export const RESULT_VALUE_CAP = 256;
/** A message of an answer is cut to this many bytes (as a JSON string). */
export const MESSAGE_CAP = 300;
/** The most one value of a request may be (bytes as JSON), and all its values together. */
export const MAX_REQUEST_VALUE_BYTES = 2048;
export const MAX_REQUEST_VALUES_BYTES = 32768;
/** What an answer may be estimated at: under the 1 MiB (1,048,576 bytes) the middleware keeps. */
export const MAX_ESTIMATED_RESPONSE_BYTES = 1_000_000;

/** The value itself when it is short, else its type and length in bytes (enough to know which it was). */
export function summarizeValue(value: unknown): unknown {
  const bytes = jsonBytes(value);
  if (bytes <= RESULT_VALUE_CAP) return value;
  return {
    value_too_large: true,
    type: Array.isArray(value) ? 'array' : typeof value,
    length: bytes,
  };
}

/** A message cut so that, as a JSON string, it takes at most `MESSAGE_CAP` bytes. */
export function capMessage(message: string): string {
  let cut = message.slice(0, MESSAGE_CAP);
  while (cut.length > 0 && jsonBytes(cut) > MESSAGE_CAP) {
    // Escapes and wide characters make the text longer than it reads: shorten by what is over.
    const over = jsonBytes(cut) - MESSAGE_CAP;
    cut = cut.slice(0, Math.max(0, cut.length - Math.max(1, Math.ceil(over / 6))));
  }
  return cut;
}

/** A string of `bytes` bytes as JSON (quotes included): the worst case of a value or a message. */
function filler(bytes: number): string {
  return 'x'.repeat(Math.max(0, bytes - 2));
}

const WORST_VALUE = filler(RESULT_VALUE_CAP);
const WORST_MESSAGE = filler(MESSAGE_CAP);
const WORST_CODE = 'x'.repeat(48);
const VERSION = 'sha256:0000000000000000';
/** The top of an answer: ID, mode, limits and the counts by status. */
const FRAME_BYTES = 1500;
/** What a category adds to a tenant in a preview, beyond its name: an impact object. */
const IMPACT_BYTES = 160;

/**
 * An upper bound of the answer, from what the answer is made of. For each tenant: its entry (the
 * real ID) and, for each key, an entry of the shape the mode gives it with the parts that depend
 * on the tenant's data (its own and effective values, a previous value, a message, a code) at their
 * largest, and the proposed value as it will be shown (the real one, summarised). It never comes
 * to less than the answer.
 */
export function estimateResponseBytes(
  mode: 'preview' | 'apply',
  tenantIds: readonly string[],
  changes: ReadonlyArray<{ category: string; set: Record<string, unknown>; clear: string[] }>
): number {
  let perTenantEntries = 0;
  let perTenantImpact = 0;
  for (const change of changes) {
    perTenantImpact += mode === 'preview' ? change.category.length + IMPACT_BYTES : 0;
    const operations: Array<[string, unknown]> = [
      ...Object.entries(change.set),
      ...change.clear.map((key): [string, unknown] => [key, 'clear']),
    ];
    for (const [key, proposed] of operations) {
      const shown = summarizeValue(proposed);
      const entry =
        mode === 'preview'
          ? {
              category: change.category,
              key,
              current: {
                overridden: true,
                own: WORST_VALUE,
                effective: WORST_VALUE,
                source: 'platform',
              },
              proposed: shown,
              action: 'would_reject',
              reason: WORST_CODE,
              validation: { ok: false, errors: [{ code: WORST_CODE, message: WORST_MESSAGE }] },
              version: VERSION,
            }
          : {
              category: change.category,
              key,
              status: 'conflict',
              reason: WORST_CODE,
              message: WORST_MESSAGE,
              previous: WORST_VALUE,
              new: shown,
              version_before: VERSION,
              version_after: VERSION,
              warnings: ['external_plugin_gate_pending'],
            };
      perTenantEntries += jsonBytes(entry) + 1;
    }
  }
  let total = FRAME_BYTES;
  for (const tenantId of tenantIds) {
    total +=
      jsonBytes({
        tenant_id: tenantId,
        status: 'nothing_to_do',
        reason: WORST_CODE,
        error: { code: WORST_CODE },
        changes: [],
        impact: {},
      }) +
      1 +
      perTenantEntries +
      perTenantImpact;
  }
  return total;
}
