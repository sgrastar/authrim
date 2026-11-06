/**
 * The lite Login UI's server-side transaction (LiteTxnStore): what a lite page's sign-in, sign-up,
 * re-authentication or account action carries between its native form posts.
 *
 * A transaction belongs to one browser (the hash of the random binding in the `__Host-authrim_lite`
 * cookie) and one tenant, and is addressed by its ID (a hidden form field, so each tab has its own).
 * Its `bound` part is fixed when it is created; its `state` moves only along LITE_TXN_TRANSITIONS
 * and only from the version the caller read; it ends LITE_TXN_TTL_MS after it was created, whatever
 * happens to it; a finished one (`completed`, `abandoned`) never moves again.
 */

export const LITE_TXN_PURPOSES = ['login', 'signup', 'reauth', 'account'] as const;
export type LiteTxnPurpose = (typeof LITE_TXN_PURPOSES)[number];

export const LITE_TXN_STATES = ['open', 'pending', 'verified', 'completed', 'abandoned'] as const;
export type LiteTxnState = (typeof LITE_TXN_STATES)[number];

/**
 * The moves a transaction may make. `pending`: waiting on the user (a code sent, a passkey or a
 * proof asked for); `verified`: a step of the flow is done (another may follow, hence back to
 * `pending`); `completed`: the flow finished; `abandoned`: given up (a restart, a policy change).
 */
export const LITE_TXN_TRANSITIONS: Readonly<Record<LiteTxnState, readonly LiteTxnState[]>> = {
  open: ['pending', 'verified', 'abandoned'],
  pending: ['pending', 'verified', 'abandoned'],
  verified: ['pending', 'verified', 'completed', 'abandoned'],
  completed: [],
  abandoned: [],
};

export function isLiteTxnTransitionAllowed(from: LiteTxnState, to: LiteTxnState): boolean {
  return LITE_TXN_TRANSITIONS[from].includes(to);
}

/** The absolute lifetime of a transaction: never extended. */
export const LITE_TXN_TTL_MS = 15 * 60_000;
/** The largest `data` a transaction may hold (UTF-8 bytes of its JSON). */
export const LITE_TXN_MAX_DATA_BYTES = 8 * 1024;
/**
 * The largest stored transaction record (its data, bound values, operations and their results,
 * grants): what every write is checked against.
 */
export const LITE_TXN_MAX_RECORD_BYTES = 16 * 1024;
/** The longest operation ID, reuse key and grant provider. */
export const LITE_TXN_MAX_KEY_LENGTH = 128;
/**
 * The largest result an operation records (UTF-8 bytes of its JSON). Its room in the record is
 * reserved when the operation starts, so recording a result is never refused for size; a larger
 * result is recorded as `{ "error": "result_too_large" }` (still final: the operation is not run
 * again).
 */
export const LITE_TXN_MAX_RESULT_BYTES = 1024;
/** The longest string of a transaction's bound values (an origin, a return target, an ID). */
export const LITE_TXN_MAX_BOUND_LENGTH = 2048;
/** How many times one transaction may be read and changed in its lifetime. */
export const LITE_TXN_MAX_READS = 256;
export const LITE_TXN_MAX_UPDATES = 64;
/**
 * How many transactions one browser's store instance may hold at all, finished ones included
 * (they are kept until they expire, so a page can tell how it ended): creating and abandoning
 * transactions in a loop cannot grow it further.
 */
export const LITE_TXN_MAX_RECORDS = 64;
/** How many idempotent operations and start grants one transaction may record. */
export const LITE_TXN_MAX_OPERATIONS = 32;
export const LITE_TXN_MAX_START_GRANTS = 4;
/**
 * How long a started operation is treated as still running. After that a retry may start it
 * again; the side effect it guards carries the operation's idempotency key downstream.
 */
export const LITE_TXN_OPERATION_LEASE_MS = 60_000;

/** What a transaction is fixed to when it is created. */
export interface LiteTxnBound {
  tenantId: string;
  /** The origin the browser used (the Router's edge context), the issuer's for a lite tenant. */
  publicOrigin: string;
  purpose: LiteTxnPurpose;
  clientId: string | null;
  /** The authorization or Flow challenge the transaction continues, when there is one. */
  challengeId: string | null;
  /** The verified return target, when there is one. */
  returnTo: string | null;
  /** The tenant's lite policy revision when the transaction began. */
  policyRevision: string;
  /** For account and re-authentication transactions: the signed-in session it acts for. */
  sessionId: string | null;
  userId: string | null;
}

export interface LiteTxnSnapshot {
  id: string;
  bound: LiteTxnBound;
  state: LiteTxnState;
  version: number;
  /** The form token of the transaction's pages (random, made by the store). */
  csrfToken: string;
  data: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

/** A one-time permission for ar-bridge or ar-saml to start an external sign-in for a transaction. */
export interface LiteStartGrantSpec {
  provider: string;
  action: LiteTxnPurpose;
  policyRevision: string;
}

export type LiteTxnRefusal =
  | 'not_found'
  | 'expired'
  | 'finished'
  | 'version_mismatch'
  | 'invalid_transition'
  | 'binding_mismatch'
  | 'too_large'
  | 'budget_exceeded'
  | 'grant_invalid'
  | 'policy_changed';
