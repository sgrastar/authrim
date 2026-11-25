/**
 * Structured log events. The type is the allow-list of design section 11: nothing that came from a
 * request (challenge, attestation, assertion, nonce, JWK, key id) can be a field, only enumerated
 * codes, numbers and the 12-hex pseudonym of the key id.
 */

export interface ProviderLogEvent {
  requestId: string;
  endpoint: 'challenge' | 'register' | 'wallet-attestation' | 'key-attestation' | 'healthz';
  /** The HTTP status that was answered. */
  status: number;
  /** An enumerated code, for example `ok`, `invalid_attestation`, `counter_replayed`. */
  outcome: string;
  /** The internal refusal reason, for example `rp_id_mismatch` (an enumerated verifier code). */
  reason?: string;
  keyIdHash?: string;
  counter?: number;
  environment?: string;
  validationCategory?: number;
  bundleVersion?: string;
  latencyMs: number;
}

export interface ProviderLogger {
  log(event: ProviderLogEvent): void;
}

export const silentLogger: ProviderLogger = { log: () => undefined };
