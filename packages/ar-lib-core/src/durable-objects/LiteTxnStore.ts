/**
 * LiteTxnStore Durable Object (one instance per tenant and browser binding)
 *
 * The lite Login UI's server-side transactions (types/login-ui-lite-txn.ts). The Login UI never
 * reaches it directly: ar-auth's LiteTxnEntrypoint calls it (and checks the tenant, the policy
 * revision and the budgets first); ar-bridge and ar-saml consume start grants from it.
 *
 * Why an instance per browser binding: one browser's transactions are counted and changed in one
 * place (its limit of live transactions, the versions of each), and no instance holds more than a
 * few. The instance remembers which tenant and binding it is for and refuses any other.
 *
 * The API is a set of state transitions, not get/put:
 * - `createTxnRpc` makes a transaction, fixed to its `bound` values, with an absolute expiry.
 *   With a `reuseKey`, a live transaction made for the same key and the same `bound` is answered
 *   instead (a reload), without extending it.
 * - `transitionRpc` moves it from the version the caller read, along LITE_TXN_TRANSITIONS, with
 *   an optional change of `data`.
 * - `beginOperationRpc` / `completeOperationRpc` make a side effect idempotent: a retry of a
 *   finished operation gets its result; one still running is told so.
 * - `issueStartGrantRpc` / `consumeStartGrantRpc`: a one-time permission for an external sign-in.
 * - `alarm` deletes expired transactions, a bounded number per run.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import {
  LITE_TXN_MAX_BOUND_LENGTH,
  LITE_TXN_MAX_DATA_BYTES,
  LITE_TXN_MAX_KEY_LENGTH,
  LITE_TXN_MAX_OPERATIONS,
  LITE_TXN_MAX_READS,
  LITE_TXN_MAX_RECORD_BYTES,
  LITE_TXN_MAX_RECORDS,
  LITE_TXN_MAX_RESULT_BYTES,
  LITE_TXN_MAX_START_GRANTS,
  LITE_TXN_MAX_UPDATES,
  LITE_TXN_OPERATION_LEASE_MS,
  LITE_TXN_PURPOSES,
  LITE_TXN_TTL_MS,
  isLiteTxnTransitionAllowed,
  type LiteStartGrantSpec,
  type LiteStartGrantStart,
  type LiteTxnBound,
  type LiteTxnRefusal,
  type LiteTxnSnapshot,
  type LiteTxnState,
} from '../types/login-ui-lite-txn';

const META_KEY = 'meta';
const TXN_PREFIX = 'txn:';
/** How many expired transactions one alarm run deletes before it schedules the next. */
const ALARM_DELETE_BATCH = 128;
const ALARM_RETRY_MS = 1_000;

interface StoredOperation {
  status: 'running' | 'done';
  startedAt: number;
  attempt: number;
  result?: unknown;
  /**
   * How the move asked for with the result went, the first time (null: none was asked). A resend
   * of the same completion gets this answer; it never makes the move again.
   */
  moveOutcome?: 'moved' | LiteTxnRefusal | null;
}

interface StoredGrant {
  spec: LiteStartGrantSpec;
  start: LiteStartGrantStart;
  consumed: boolean;
}

interface StoredTxn {
  v: 1;
  id: string;
  bound: LiteTxnBound;
  state: LiteTxnState;
  version: number;
  csrfToken: string;
  data: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  reads: number;
  updates: number;
  reuseKey: string | null;
  operations: Record<string, StoredOperation>;
  grants: Record<string, StoredGrant>;
}

interface StoredMeta {
  tenantId: string;
  bindingHash: string;
}

/** Which transaction a call is for. */
export interface LiteTxnRef {
  tenantId: string;
  bindingHash: string;
  txnId: string;
  /**
   * The public origin of the call: a transaction made for another origin is refused
   * (`binding_mismatch`). Left out only by the store's own tests.
   */
  publicOrigin?: string;
  /**
   * The tenant's current lite policy revision: a transaction made under another one is refused
   * (`policy_changed`), checked with the call itself. Left out only to record the result of an
   * operation already carried out.
   */
  policyRevision?: string;
  /**
   * The caller's live session (checked by the entrypoint), or null when it has none: a transaction
   * bound to a session is acted on, read or changed, only with that session of its user.
   */
  session?: { sessionId: string; userId: string } | null;
}

/** A change of `data`: a key set to null is removed. */
export type LiteTxnDataPatch = Record<string, unknown>;

export type LiteTxnResult =
  | { ok: true; txn: LiteTxnSnapshot }
  | { ok: false; reason: LiteTxnRefusal };

export interface LiteTxnCreateRequest {
  tenantId: string;
  bindingHash: string;
  bound: LiteTxnBound;
  data?: Record<string, unknown>;
  reuseKey?: string;
  /**
   * Only the live transaction of `reuseKey`, when there is one: none is made (`not_found`). For a
   * page that gives a transaction up, and would not make one only to do so.
   */
  reuseOnly?: boolean;
  /** How many live transactions this browser may hold (from the tenant's settings). */
  maxActive: number;
}

export type LiteTxnCreateResult =
  | { ok: true; txn: LiteTxnSnapshot; reused: boolean }
  | { ok: false; reason: LiteTxnRefusal };

export interface LiteTxnTransitionRequest extends LiteTxnRef {
  expectedVersion: number;
  to: LiteTxnState;
  patch?: LiteTxnDataPatch;
}

export type LiteTxnOperationBegin =
  | { ok: true; status: 'started'; attempt: number }
  | { ok: true; status: 'running' }
  | { ok: true; status: 'done'; result: unknown }
  | { ok: false; reason: LiteTxnRefusal };

export interface LiteTxnOperationComplete extends LiteTxnRef {
  operationId: string;
  /**
   * The attempt that carried the operation out (`beginOperationRpc`'s answer). A late completion
   * of an earlier attempt, after a retry started the operation again, is refused.
   */
  attempt: number;
  result: unknown;
  /** A move made together with recording the result. */
  transition?: { expectedVersion: number; to: LiteTxnState; patch?: LiteTxnDataPatch };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

function dataBytes(data: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(data)).byteLength;
}

/**
 * Whether the record fits, with room kept for the result of every running operation (so a later
 * write cannot use the room a result was promised).
 */
/**
 * The room kept for one running operation's completion: its result, and the fields a completion
 * adds (`result`, `moveOutcome` with the longest refusal, the status change).
 */
const COMPLETION_RESERVE_BYTES = LITE_TXN_MAX_RESULT_BYTES + 128;

function fitsRecord(txn: StoredTxn): boolean {
  const running = Object.values(txn.operations).filter((op) => op.status === 'running').length;
  const bytes = new TextEncoder().encode(JSON.stringify(txn)).byteLength;
  return bytes + running * COMPLETION_RESERVE_BYTES <= LITE_TXN_MAX_RECORD_BYTES;
}

/**
 * A result as recorded: its JSON, or a fixed marker when it is too large to keep or is not JSON
 * at all (a BigInt, a cycle). Either way the operation is final and not run again.
 */
function recordedResult(result: unknown): unknown {
  let json: unknown;
  try {
    json = asJson(result);
  } catch {
    return { error: 'result_invalid' };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(json ?? null)).byteLength;
  return bytes <= LITE_TXN_MAX_RESULT_BYTES ? json : { error: 'result_too_large' };
}

/** `asJson`, or null for a value that is not JSON (a BigInt, a cycle). */
function tryJson<T>(value: T): T | null {
  try {
    return asJson(value);
  } catch {
    return null;
  }
}

function boundString(value: unknown, required: boolean): string | null | undefined {
  if (value === null || value === undefined) return required ? undefined : null;
  return typeof value === 'string' && value.length > 0 && value.length <= LITE_TXN_MAX_BOUND_LENGTH
    ? value
    : undefined;
}

/** The bound values, checked one by one (strings, nulls, a purpose): nothing else is stored. */
function cleanBound(input: LiteTxnBound): LiteTxnBound | null {
  const strings = {
    tenantId: boundString(input.tenantId, true),
    publicOrigin: boundString(input.publicOrigin, true),
    clientId: boundString(input.clientId, false),
    challengeId: boundString(input.challengeId, false),
    returnTo: boundString(input.returnTo, false),
    policyRevision: boundString(input.policyRevision, true),
    sessionId: boundString(input.sessionId, false),
    userId: boundString(input.userId, false),
  };
  if (Object.values(strings).some((value) => value === undefined)) return null;
  if (!LITE_TXN_PURPOSES.includes(input.purpose)) return null;
  // An account action or a re-authentication acts for one signed-in session and user; a sign-in
  // or sign-up acts for nobody yet, so it carries neither (no later step can read a user from it).
  const forSession = input.purpose === 'account' || input.purpose === 'reauth';
  if (forSession !== (strings.sessionId !== null && strings.userId !== null)) return null;
  if (!forSession && (strings.sessionId !== null || strings.userId !== null)) return null;
  return {
    tenantId: strings.tenantId as string,
    publicOrigin: strings.publicOrigin as string,
    purpose: input.purpose,
    clientId: strings.clientId ?? null,
    challengeId: strings.challengeId ?? null,
    returnTo: strings.returnTo ?? null,
    policyRevision: strings.policyRevision as string,
    sessionId: strings.sessionId ?? null,
    userId: strings.userId ?? null,
  };
}

/** Keys that would name an inherited property of a plain object, never used as record keys. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= LITE_TXN_MAX_KEY_LENGTH &&
    !RESERVED_KEYS.has(value)
  );
}

/** A record's own entry (never an inherited property such as `toString`). */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * The value as JSON: what is stored is what was measured. RPC arguments arrive by structured
 * clone, so a caller could pass an ArrayBuffer or a Map that JSON would measure as `{}`.
 */
function asJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function applyPatch(
  data: Record<string, unknown>,
  patch: LiteTxnDataPatch | undefined
): Record<string, unknown> {
  if (!patch) return data;
  const next = { ...data };
  for (const [key, value] of Object.entries(asJson(patch))) {
    if (RESERVED_KEYS.has(key)) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function sameBound(a: LiteTxnBound, b: LiteTxnBound): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isFinished(txn: StoredTxn): boolean {
  return txn.state === 'completed' || txn.state === 'abandoned';
}

function snapshotOf(txn: StoredTxn): LiteTxnSnapshot {
  return {
    id: txn.id,
    bound: txn.bound,
    state: txn.state,
    version: txn.version,
    csrfToken: txn.csrfToken,
    data: txn.data,
    createdAt: txn.createdAt,
    expiresAt: txn.expiresAt,
  };
}

export class LiteTxnStore extends DurableObject<Env> {
  /** Whether the instance is for this tenant and binding (an instance with no record yet is). */
  async #metaMatches(tenantId: string, bindingHash: string): Promise<boolean> {
    const meta = await this.ctx.storage.get<StoredMeta>(META_KEY);
    return !meta || (meta.tenantId === tenantId && meta.bindingHash === bindingHash);
  }

  /** Saves a transaction, after checking the whole record's size. */
  async #save(txn: StoredTxn): Promise<boolean> {
    if (!fitsRecord(txn)) return false;
    await this.ctx.storage.put(TXN_PREFIX + txn.id, txn);
    return true;
  }

  /** The live transaction a call is for, or why there is none. */
  async #load(
    ref: LiteTxnRef,
    options: { checkRevision: boolean } = { checkRevision: true }
  ): Promise<StoredTxn | LiteTxnRefusal> {
    const meta = await this.ctx.storage.get<StoredMeta>(META_KEY);
    if (!meta || meta.tenantId !== ref.tenantId || meta.bindingHash !== ref.bindingHash) {
      return 'binding_mismatch';
    }
    if (!isKey(ref.txnId)) return 'not_found';
    const txn = await this.ctx.storage.get<StoredTxn>(TXN_PREFIX + ref.txnId);
    if (!txn) return 'not_found';
    if (txn.bound.tenantId !== ref.tenantId) return 'binding_mismatch';
    if (ref.publicOrigin !== undefined && txn.bound.publicOrigin !== ref.publicOrigin) {
      return 'binding_mismatch';
    }
    if (Date.now() >= txn.expiresAt) return 'expired';
    if (
      txn.bound.sessionId !== null &&
      (ref.session?.sessionId !== txn.bound.sessionId || ref.session.userId !== txn.bound.userId)
    ) {
      return 'session_invalid';
    }
    if (
      options.checkRevision &&
      ref.policyRevision !== undefined &&
      txn.bound.policyRevision !== ref.policyRevision
    ) {
      return 'policy_changed';
    }
    return txn;
  }

  async #scheduleCleanup(expiresAt: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
  }

  async createTxnRpc(request: LiteTxnCreateRequest): Promise<LiteTxnCreateResult> {
    const bound = cleanBound(request.bound);
    if (!bound) return { ok: false, reason: 'too_large' };
    if (bound.tenantId !== request.tenantId) {
      return { ok: false, reason: 'binding_mismatch' };
    }
    if (!(await this.#metaMatches(request.tenantId, request.bindingHash))) {
      return { ok: false, reason: 'binding_mismatch' };
    }
    const data = tryJson(request.data ?? {});
    if (!data || dataBytes(data) > LITE_TXN_MAX_DATA_BYTES) {
      return { ok: false, reason: 'too_large' };
    }
    if (request.reuseKey !== undefined && !isKey(request.reuseKey)) {
      return { ok: false, reason: 'too_large' };
    }

    const now = Date.now();
    const all = await this.ctx.storage.list<StoredTxn>({ prefix: TXN_PREFIX });
    const live = [...all.values()].filter((txn) => !isFinished(txn) && now < txn.expiresAt);
    if (request.reuseKey) {
      const existing = live.find(
        (txn) => txn.reuseKey === request.reuseKey && sameBound(txn.bound, bound)
      );
      if (existing) {
        // A reload reads the transaction again: it counts as a read.
        if (existing.reads >= LITE_TXN_MAX_READS) return { ok: false, reason: 'budget_exceeded' };
        existing.reads += 1;
        if (!(await this.#save(existing))) return { ok: false, reason: 'too_large' };
        return { ok: true, txn: snapshotOf(existing), reused: true };
      }
    }
    if (request.reuseOnly) return { ok: false, reason: 'not_found' };
    if (live.length >= request.maxActive) return { ok: false, reason: 'budget_exceeded' };
    const kept = [...all.values()].filter((txn) => now < txn.expiresAt).length;
    if (kept >= LITE_TXN_MAX_RECORDS) return { ok: false, reason: 'budget_exceeded' };

    const txn: StoredTxn = {
      v: 1,
      id: randomToken(),
      bound,
      state: 'open',
      version: 1,
      csrfToken: randomToken(),
      data,
      createdAt: now,
      expiresAt: now + LITE_TXN_TTL_MS,
      reads: 0,
      updates: 0,
      reuseKey: request.reuseKey ?? null,
      operations: {},
      grants: {},
    };
    if (!fitsRecord(txn)) return { ok: false, reason: 'too_large' };
    // The instance is claimed for this tenant and binding only once a transaction is made.
    await this.ctx.storage.put(META_KEY, {
      tenantId: request.tenantId,
      bindingHash: request.bindingHash,
    } satisfies StoredMeta);
    await this.ctx.storage.put(TXN_PREFIX + txn.id, txn);
    await this.#scheduleCleanup(txn.expiresAt);
    return { ok: true, txn: snapshotOf(txn), reused: false };
  }

  /** Reads a transaction (finished ones too, so a page can tell how it ended). */
  async getTxnRpc(ref: LiteTxnRef): Promise<LiteTxnResult> {
    const txn = await this.#load(ref);
    if (typeof txn === 'string') return { ok: false, reason: txn };
    if (txn.reads >= LITE_TXN_MAX_READS) return { ok: false, reason: 'budget_exceeded' };
    txn.reads += 1;
    if (!(await this.#save(txn))) return { ok: false, reason: 'too_large' };
    return { ok: true, txn: snapshotOf(txn) };
  }

  /** Applies a move to a loaded transaction (not yet saved), or says why it cannot. */
  #move(
    txn: StoredTxn,
    move: { expectedVersion: number; to: LiteTxnState; patch?: LiteTxnDataPatch },
    /** The move made with an operation's completion: it uses the update the start reserved. */
    reserved = false
  ): LiteTxnRefusal | null {
    if (isFinished(txn)) return 'finished';
    if (txn.version !== move.expectedVersion) return 'version_mismatch';
    if (!isLiteTxnTransitionAllowed(txn.state, move.to)) return 'invalid_transition';
    // Finishing is never refused for the budget: a finished transaction must not stay live. Nor
    // is the move an operation's completion makes: its update was counted when it started (the
    // side effect is carried out by then, so what it leaves must be recordable).
    const finishing = move.to === 'completed' || move.to === 'abandoned';
    if (txn.updates >= LITE_TXN_MAX_UPDATES && !finishing && !reserved) return 'budget_exceeded';
    let data: Record<string, unknown>;
    try {
      data = applyPatch(txn.data, move.patch);
    } catch {
      return 'too_large';
    }
    if (dataBytes(data) > LITE_TXN_MAX_DATA_BYTES) return 'too_large';
    txn.data = data;
    txn.state = move.to;
    txn.version += 1;
    if (!reserved) txn.updates += 1;
    return null;
  }

  async transitionRpc(request: LiteTxnTransitionRequest): Promise<LiteTxnResult> {
    const txn = await this.#load(request);
    if (typeof txn === 'string') return { ok: false, reason: txn };
    const refused = this.#move(txn, request);
    if (refused) return { ok: false, reason: refused };
    if (!(await this.#save(txn))) return { ok: false, reason: 'too_large' };
    return { ok: true, txn: snapshotOf(txn) };
  }

  async beginOperationRpc(
    request: LiteTxnRef & { operationId: string }
  ): Promise<LiteTxnOperationBegin> {
    if (!isKey(request.operationId)) return { ok: false, reason: 'too_large' };
    const txn = await this.#load(request);
    if (typeof txn === 'string') return { ok: false, reason: txn };
    const existing = own(txn.operations, request.operationId);
    const now = Date.now();
    if (
      existing &&
      (existing.status === 'done' || now - existing.startedAt < LITE_TXN_OPERATION_LEASE_MS)
    ) {
      // A retry asking how the operation went: a read.
      if (txn.reads >= LITE_TXN_MAX_READS) return { ok: false, reason: 'budget_exceeded' };
      txn.reads += 1;
      if (!(await this.#save(txn))) return { ok: false, reason: 'too_large' };
      return existing.status === 'done'
        ? { ok: true, status: 'done', result: existing.result }
        : { ok: true, status: 'running' };
    }
    if (isFinished(txn)) return { ok: false, reason: 'finished' };
    if (!existing && Object.keys(txn.operations).length >= LITE_TXN_MAX_OPERATIONS) {
      return { ok: false, reason: 'budget_exceeded' };
    }
    // A start is a change, and it reserves the change that records its result: recording is
    // never refused for the budget, since the side effect will have been carried out by then.
    if (txn.updates + 2 > LITE_TXN_MAX_UPDATES) return { ok: false, reason: 'budget_exceeded' };
    txn.updates += 2;
    const attempt = (existing?.attempt ?? 0) + 1;
    txn.operations[request.operationId] = { status: 'running', startedAt: now, attempt };
    if (!(await this.#save(txn))) return { ok: false, reason: 'too_large' };
    return { ok: true, status: 'started', attempt };
  }

  /**
   * Records an operation's result, then makes the move asked for with it. The result is recorded
   * whatever happens to the move (a concurrent post moved the transaction, it finished, the policy
   * changed): the side effect was carried out, and a retry must get its result, not run it again.
   * The move is made only on a live transaction of the current policy revision.
   */
  async completeOperationRpc(request: LiteTxnOperationComplete): Promise<LiteTxnResult> {
    const txn = await this.#load(request, { checkRevision: false });
    if (typeof txn === 'string') return { ok: false, reason: txn };
    if (!isKey(request.operationId)) return { ok: false, reason: 'not_found' };
    const operation = own(txn.operations, request.operationId);
    if (!operation) return { ok: false, reason: 'not_found' };

    // An attempt whose lease ran out and that another took over: told apart from a version
    // conflict, so its caller neither re-applies its move nor acts on what it did. Checked before
    // a finished operation is read back: the later attempt's completion is never this one's.
    if (operation.attempt !== request.attempt) return { ok: false, reason: 'superseded' };

    if (operation.status === 'done') {
      // A resend: the first completion's answer, read again (never the move made again).
      if (txn.reads >= LITE_TXN_MAX_READS) return { ok: false, reason: 'budget_exceeded' };
      txn.reads += 1;
      if (!(await this.#save(txn))) return { ok: false, reason: 'too_large' };
      const outcome = operation.moveOutcome ?? null;
      return outcome === null || outcome === 'moved'
        ? { ok: true, txn: snapshotOf(txn) }
        : { ok: false, reason: outcome };
    }

    // The first completion: the result goes into the room reserved when the operation started,
    // so this save always fits. The move asked for with it is then tried once, and its outcome
    // recorded with the result.
    let outcome: 'moved' | LiteTxnRefusal | null = null;
    const done: StoredOperation = {
      ...operation,
      status: 'done',
      result: recordedResult(request.result),
    };
    if (request.transition) {
      if (
        request.policyRevision !== undefined &&
        txn.bound.policyRevision !== request.policyRevision
      ) {
        outcome = 'policy_changed';
      } else {
        const moved = structuredClone(txn);
        moved.operations[request.operationId] = { ...done, moveOutcome: 'moved' };
        const refused = this.#move(moved, request.transition, true);
        if (!refused && fitsRecord(moved)) {
          await this.ctx.storage.put(TXN_PREFIX + moved.id, moved);
          return { ok: true, txn: snapshotOf(moved) };
        }
        outcome = refused ?? 'too_large';
      }
    }
    txn.operations[request.operationId] = { ...done, moveOutcome: outcome };
    // The reserved room holds the completion; should it not (a reserve that grew short), the
    // result is recorded as the fixed marker, so the operation is final all the same.
    if (!fitsRecord(txn)) {
      txn.operations[request.operationId] = {
        ...done,
        result: { error: 'result_too_large' },
        moveOutcome: outcome,
      };
    }
    await this.ctx.storage.put(TXN_PREFIX + txn.id, txn);
    return outcome === null ? { ok: true, txn: snapshotOf(txn) } : { ok: false, reason: outcome };
  }

  async issueStartGrantRpc(
    request: LiteTxnRef & { spec: LiteStartGrantSpec; start: LiteStartGrantStart }
  ): Promise<{ ok: true; grantId: string } | { ok: false; reason: LiteTxnRefusal }> {
    if (!isKey(request.spec.provider)) return { ok: false, reason: 'too_large' };
    const clientId = request.start?.clientId;
    const interactionId = request.start?.interactionId ?? null;
    const inviteToken = request.start?.inviteToken ?? null;
    if (!isKey(clientId) || (interactionId !== null && !isKey(interactionId))) {
      return { ok: false, reason: 'too_large' };
    }
    if (inviteToken !== null && !isKey(inviteToken)) return { ok: false, reason: 'too_large' };
    const txn = await this.#load(request);
    if (typeof txn === 'string') return { ok: false, reason: txn };
    if (isFinished(txn)) return { ok: false, reason: 'finished' };
    if (Object.keys(txn.grants).length >= LITE_TXN_MAX_START_GRANTS) {
      return { ok: false, reason: 'budget_exceeded' };
    }
    if (txn.updates >= LITE_TXN_MAX_UPDATES) return { ok: false, reason: 'budget_exceeded' };
    txn.updates += 1;
    const grantId = randomToken();
    txn.grants[grantId] = {
      spec: asJson(request.spec),
      start: { clientId, interactionId, inviteToken },
      consumed: false,
    };
    if (!(await this.#save(txn))) return { ok: false, reason: 'too_large' };
    return { ok: true, grantId };
  }

  /**
   * Uses a start grant once: it must be unused and match the provider, action and revision. The
   * answer carries what the grant was issued with for the start.
   */
  async consumeStartGrantRpc(
    request: LiteTxnRef & { grantId: string; spec: LiteStartGrantSpec }
  ): Promise<
    | { ok: true; txn: LiteTxnSnapshot; start: LiteStartGrantStart }
    | { ok: false; reason: LiteTxnRefusal }
  > {
    const txn = await this.#load(request);
    if (typeof txn === 'string') return { ok: false, reason: txn };
    if (isFinished(txn)) return { ok: false, reason: 'finished' };
    const grant = isKey(request.grantId) ? own(txn.grants, request.grantId) : undefined;
    if (
      !grant ||
      grant.consumed ||
      // A grant stored before it carried its start (none exists in a release) starts nothing.
      !grant.start ||
      grant.spec.provider !== request.spec.provider ||
      grant.spec.action !== request.spec.action ||
      grant.spec.policyRevision !== request.spec.policyRevision ||
      txn.bound.policyRevision !== request.spec.policyRevision
    ) {
      return { ok: false, reason: 'grant_invalid' };
    }
    if (txn.updates >= LITE_TXN_MAX_UPDATES) return { ok: false, reason: 'budget_exceeded' };
    txn.updates += 1;
    grant.consumed = true;
    if (!(await this.#save(txn))) return { ok: false, reason: 'too_large' };
    return {
      ok: true,
      txn: snapshotOf(txn),
      start: {
        clientId: grant.start.clientId,
        interactionId: grant.start.interactionId,
        inviteToken: grant.start.inviteToken ?? null,
      },
    };
  }

  /** Deletes expired transactions, at most ALARM_DELETE_BATCH per run, then schedules the next. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const all = await this.ctx.storage.list<StoredTxn>({ prefix: TXN_PREFIX });
    const expired: string[] = [];
    let nextExpiry: number | null = null;
    for (const [key, txn] of all) {
      if (now >= txn.expiresAt) expired.push(key);
      else if (nextExpiry === null || txn.expiresAt < nextExpiry) nextExpiry = txn.expiresAt;
    }
    const batch = expired.slice(0, ALARM_DELETE_BATCH);
    if (expired.length > batch.length) {
      await this.ctx.storage.delete(batch);
      await this.ctx.storage.setAlarm(now + ALARM_RETRY_MS);
    } else if (nextExpiry !== null) {
      if (batch.length > 0) await this.ctx.storage.delete(batch);
      await this.ctx.storage.setAlarm(nextExpiry);
    } else {
      // Nothing is left: the instance keeps nothing for this browser (its claim included).
      await this.ctx.storage.deleteAll();
    }
  }
}
