/**
 * LiteTxnEntrypoint: the lite Login UI's transactions (ar-lib-core LiteTxnStore), for the Login UI
 * Worker only.
 *
 * Reached through the Login UI's `LITE_TXN` service binding (props: caller `ar-login-ui`, this
 * environment, audience `authrim-lite-txn-v1`), never through a public route: the default fetch
 * of ar-auth has no route to it, and the Login UI's public proxy cannot reach it either.
 *
 * Every call:
 * - resolves the tenant from the public origin the browser used (the Router's edge context), the
 *   way a request to that host is resolved; the Login UI does not name the tenant;
 * - hashes the browser binding (the random value of the `__Host-authrim_lite` cookie) so the store
 *   never sees it, and addresses that browser's store instance;
 * - requires the tenant to be in lite mode now, and the transaction to belong to the tenant's
 *   current policy revision (`policy_changed`, checked by the store with the call itself: start
 *   again before any side effect).
 * Creating a transaction also counts it against a per-IP and a tenant-wide limit (atomic, never
 * the eventually consistent KV counter; refused when the counter cannot be reached).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { runSamlDrCoveredOperation } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';
import {
  checkRateLimit,
  checkedLiteBrowserBinding,
  readAuthorizationChallengeKind,
  liteBrowserBindingHash,
  liteTxnStoreFor,
  verifyHumanVerificationWithRunner,
  buildCanonicalTenantIssuerUrl,
  buildIssuerUrl,
  getTenantIdFromHost,
  readCurrentLitePolicySnapshot,
  readLiteRuntimeState,
  readLiteTxnLimits,
  resolveTenantFromVanityHost,
  type Env,
  type LiteStartGrantSpec,
  type LiteTxnBound,
  type LiteTxnPurpose,
  type LiteTxnState,
} from '@authrim/ar-lib-core';
import type {
  LiteTxnCreateResult,
  LiteTxnDataPatch,
  LiteTxnOperationBegin,
  LiteTxnResult,
  LiteTxnStore,
} from '@authrim/ar-lib-core/durable-objects/LiteTxnStore';

export const LITE_TXN_AUDIENCE = 'authrim-lite-txn-v1';

export interface LiteTxnEntrypointProps {
  caller: string;
  audience: string;
  environmentId: string;
}

/** Why the entrypoint refused before reaching the store. */
export type LiteTxnEntryRefusal =
  | 'unsupported_purpose'
  | 'origin_not_canonical'
  | 'invalid_return_to'
  | 'tenant_unknown'
  | 'not_lite'
  | 'policy_unknown'
  | 'policy_changed'
  | 'invalid_binding'
  | 'budget_exceeded'
  | 'invalid_request'
  | 'human_verification_failed'
  | 'unavailable';

type Refused = { ok: false; reason: LiteTxnEntryRefusal };

/** Which browser and transaction a call is for. */
export interface LiteTxnCall {
  /** The origin the browser used (the Router's edge context). */
  publicOrigin: string;
  /** The browser binding: the value of the `__Host-authrim_lite` cookie. */
  binding: string;
}

export interface LiteTxnCreateCall extends LiteTxnCall {
  /** The visitor's IP from the edge context, for the per-IP limit. */
  clientIp: string | null;
  purpose: LiteTxnPurpose;
  clientId?: string | null;
  challengeId?: string | null;
  returnTo?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  data?: Record<string, unknown>;
  reuseKey?: string;
}

/** A revision no transaction is made under: moves are refused, a result is still recorded. */
const NO_CURRENT_REVISION = '\u0000no-current-revision';

/**
 * The return target, checked: a URL of the public origin, or a local path (one leading `/`, no
 * backslash or control character). Null when there is none; undefined when it is not allowed.
 */
export function checkedReturnTo(value: unknown, publicOrigin: string): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/u.test(value)) return undefined;
  if (value.startsWith('/')) return value.startsWith('//') ? undefined : value;
  try {
    const url = new URL(value);
    // http(s) only and no user info (a `blob:` URL shares its creator's origin).
    return url.origin === publicOrigin &&
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function originOf(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.origin === value && (url.protocol === 'https:' || url.protocol === 'http:')
      ? url
      : null;
  } catch {
    return null;
  }
}

export class LiteTxnEntrypoint extends WorkerEntrypoint<Env, LiteTxnEntrypointProps> {
  #authorize(): void {
    const props = this.ctx.props;
    if (
      props?.caller !== 'ar-login-ui' ||
      props.audience !== LITE_TXN_AUDIENCE ||
      !this.env.AUTHRIM_ENVIRONMENT_NAME ||
      props.environmentId !== this.env.AUTHRIM_ENVIRONMENT_NAME
    ) {
      throw new Error('lite_txn_unauthorized');
    }
  }

  /**
   * The tenant, its lite policy revision and the browser's store instance; or the refusal.
   * - `current`: a call that changes a transaction reads the tenant's current policy, not the
   *   runtime cache, so a change under an earlier revision is refused at once.
   * - `requireLite: false` (recording an operation's result): the call goes on when the tenant is
   *   no longer in lite mode, with a revision that matches no transaction, so the store records
   *   the result and refuses any move.
   */
  async #context(
    call: LiteTxnCall,
    options: { current: boolean; requireLite: boolean } = { current: true, requireLite: true }
  ): Promise<
    | Refused
    | {
        ok: true;
        tenantId: string;
        policyRevision: string;
        bindingHash: string;
        publicOrigin: string;
        store: DurableObjectStub<LiteTxnStore>;
      }
  > {
    this.#authorize();
    const namespace = this.env.LITE_TXN_STORE;
    if (!namespace) return { ok: false, reason: 'unavailable' };
    const binding = checkedLiteBrowserBinding(call.binding);
    if (!binding) return { ok: false, reason: 'invalid_binding' };
    const origin = typeof call.publicOrigin === 'string' ? originOf(call.publicOrigin) : null;
    if (!origin) return { ok: false, reason: 'tenant_unknown' };
    const byHost = getTenantIdFromHost(origin.host, this.env);
    const tenantId = byHost.success
      ? byHost.tenantId
      : await resolveTenantFromVanityHost(this.env, origin.hostname);
    if (!tenantId) return { ok: false, reason: 'tenant_unknown' };

    const policyRevision = await this.#policyRevision(tenantId, options.current);
    if (typeof policyRevision !== 'string' && options.requireLite) {
      return { ok: false, reason: policyRevision.refusal };
    }
    const bindingHash = await liteBrowserBindingHash(binding);
    const store = liteTxnStoreFor(namespace, tenantId, bindingHash);
    return {
      ok: true,
      tenantId,
      policyRevision: typeof policyRevision === 'string' ? policyRevision : NO_CURRENT_REVISION,
      bindingHash,
      publicOrigin: origin.origin,
      store,
    };
  }

  /** The tenant's lite policy revision now, or why there is none. */
  async #policyRevision(
    tenantId: string,
    current: boolean
  ): Promise<string | { refusal: 'not_lite' | 'policy_unknown' }> {
    // The runtime cache first: a tenant that was never lite costs no policy read.
    const lite = await readLiteRuntimeState(this.env, tenantId);
    if (lite === 'unknown') return { refusal: 'policy_unknown' };
    if (lite === 'off') return { refusal: 'not_lite' };
    if (!current) return lite.policyRevision;
    try {
      const snapshot = await readCurrentLitePolicySnapshot(this.env, tenantId);
      return snapshot.liteMode === 'always' ? snapshot.policyRevision : { refusal: 'not_lite' };
    } catch {
      return { refusal: 'policy_unknown' };
    }
  }

  /** Each call runs under the DR writer coverage, as the Worker's other entries do. */
  #covered<T>(operation: () => Promise<T>): Promise<T> {
    return runSamlDrCoveredOperation(this.env, this.ctx, () => operation());
  }

  create(call: LiteTxnCreateCall): Promise<LiteTxnCreateResult | Refused> {
    return this.#covered(async () => {
      // An account action or a re-authentication acts for the signed-in session and user, which
      // this entrypoint does not check yet: both are refused until it does (lite plan PR7).
      if (call.purpose !== 'login' && call.purpose !== 'signup') {
        this.#authorize();
        return { ok: false, reason: 'unsupported_purpose' } as const;
      }
      const context = await this.#context(call);
      if (!context.ok) return context;
      // The browser must be on the tenant's canonical issuer origin (not a shared Login UI host,
      // a non-primary vanity domain or workers.dev): the page goes there first (plan R4-2).
      let canonicalOrigin: string;
      try {
        canonicalOrigin = new URL(
          await buildCanonicalTenantIssuerUrl(
            this.env,
            context.tenantId,
            buildIssuerUrl(this.env, context.tenantId),
            { strict: true }
          )
        ).origin;
      } catch {
        return { ok: false, reason: 'unavailable' } as const;
      }
      if (canonicalOrigin !== call.publicOrigin) {
        return { ok: false, reason: 'origin_not_canonical', canonicalOrigin } as const;
      }
      // Checked on the canonical origin (a request from another host goes there first).
      const returnTo = checkedReturnTo(call.returnTo, call.publicOrigin);
      if (returnTo === undefined) {
        return { ok: false, reason: 'invalid_return_to' } as const;
      }
      const limits = await readLiteTxnLimits(this.env, context.tenantId);
      try {
        for (const [key, maxRequests] of [
          [call.clientIp || 'unknown', limits.perIpPerMinute],
          ['tenant-total', limits.perTenantPerMinute],
        ] as const) {
          const counted = await checkRateLimit(
            this.env,
            key,
            { maxRequests, windowSeconds: 60, endpointClass: 'liteTxnCreate', requireAtomic: true },
            context.tenantId
          );
          if (!counted.allowed) return { ok: false, reason: 'budget_exceeded' } as const;
        }
      } catch {
        return { ok: false, reason: 'unavailable' } as const;
      }
      const bound: LiteTxnBound = {
        tenantId: context.tenantId,
        publicOrigin: call.publicOrigin,
        purpose: call.purpose,
        clientId: call.clientId ?? null,
        challengeId: call.challengeId ?? null,
        returnTo,
        policyRevision: context.policyRevision,
        // Only login and signup reach here (see above): neither acts for a session or user yet.
        sessionId: null,
        userId: null,
      };
      return context.store.createTxnRpc({
        tenantId: context.tenantId,
        bindingHash: context.bindingHash,
        bound,
        data: call.data,
        reuseKey: call.reuseKey,
        maxActive: limits.perBrowser,
      });
    });
  }

  /**
   * Reads a transaction. To show a page the runtime cache is enough; before a form post acts
   * (`current: true`) the tenant's current policy is read, so a post under an earlier revision is
   * refused before any backend call.
   */
  get(call: LiteTxnCall & { txnId: string; current?: boolean }): Promise<LiteTxnResult | Refused> {
    return this.#covered(async () => {
      const context = await this.#context(call, {
        current: call.current === true,
        requireLite: true,
      });
      if (!context.ok) return context;
      return context.store.getTxnRpc(this.#ref(context, call.txnId));
    });
  }

  transition(
    call: LiteTxnCall & {
      txnId: string;
      expectedVersion: number;
      to: LiteTxnState;
      patch?: LiteTxnDataPatch;
    }
  ): Promise<LiteTxnResult | Refused> {
    return this.#covered(async () => {
      const context = await this.#context(call);
      if (!context.ok) return context;
      return context.store.transitionRpc({
        ...this.#ref(context, call.txnId),
        expectedVersion: call.expectedVersion,
        to: call.to,
        patch: call.patch,
      });
    });
  }

  beginOperation(
    call: LiteTxnCall & { txnId: string; operationId: string }
  ): Promise<LiteTxnOperationBegin | Refused> {
    return this.#covered(async () => {
      const context = await this.#context(call);
      if (!context.ok) return context;
      return context.store.beginOperationRpc({
        ...this.#ref(context, call.txnId),
        operationId: call.operationId,
      });
    });
  }

  /**
   * Records an operation's result, and makes the move asked for with it. The result is recorded
   * whatever the tenant's policy is now (the operation was carried out); the move is made only
   * under the current revision of a tenant still in lite mode.
   */
  completeOperation(
    call: LiteTxnCall & {
      txnId: string;
      operationId: string;
      attempt: number;
      result: unknown;
      transition?: { expectedVersion: number; to: LiteTxnState; patch?: LiteTxnDataPatch };
    }
  ): Promise<LiteTxnResult | Refused> {
    return this.#covered(async () => {
      const context = await this.#context(call, { current: true, requireLite: false });
      if (!context.ok) return context;
      return context.store.completeOperationRpc({
        ...this.#ref(context, call.txnId),
        operationId: call.operationId,
        attempt: call.attempt,
        result: call.result,
        transition: call.transition,
      });
    });
  }

  /**
   * A one-time start grant for an external sign-in with the provider (ar-bridge or ar-saml
   * consumes it); its action is the transaction's purpose.
   *
   * The page's proof of work is verified here, before the grant is made: the start that consumes
   * the grant does not verify again. A sign-in with a provider may create the account (JIT), and
   * the start cannot know beforehand whether it will, so a sign-in's proof must also meet the
   * sign-up requirement (as a guest sign-in's does).
   */
  issueStartGrant(
    call: LiteTxnCall & {
      txnId: string;
      provider: string;
      humanVerificationResponse?: unknown;
      /** The Login UI's own client, which its handoff is finalized for. */
      clientId: string;
      /** The Flow interaction the sign-in belongs to, when a Flow runs. */
      interactionId?: string | null;
    }
  ): Promise<{ ok: true; grantId: string } | { ok: false; reason: string }> {
    return this.#covered(async () => {
      const context = await this.#context(call);
      if (!context.ok) return context;
      const ref = this.#ref(context, call.txnId);
      // (The stub's RPC types wrap the answer; it is the store's LiteTxnResult.)
      const read = (await context.store.getTxnRpc(ref)) as LiteTxnResult;
      if (!read.ok) return read;
      const purpose = read.txn.bound.purpose;
      // Only sign-ins and sign-ups are made yet (see create); nothing else starts a provider. A
      // sign-in that answers a re-authentication challenge would start as one (ar-bridge reads
      // the challenge), under the re-authentication requirement the page's proof was not made
      // for: refused, as re-authentication transactions are, until their session check (PR7).
      if (purpose !== 'login' && purpose !== 'signup') {
        return { ok: false, reason: 'unsupported_purpose' } as const;
      }
      const challengeId = read.txn.bound.challengeId;
      if (
        challengeId !== null &&
        (await readAuthorizationChallengeKind(this.env, context.tenantId, challengeId)) !== 'login'
      ) {
        return { ok: false, reason: 'unsupported_purpose' } as const;
      }
      const interactionId = call.interactionId ?? null;
      if (
        typeof call.clientId !== 'string' ||
        !call.clientId ||
        (interactionId !== null && (typeof interactionId !== 'string' || !interactionId))
      ) {
        return { ok: false, reason: 'invalid_request' } as const;
      }
      let verified = false;
      try {
        verified = (
          await verifyHumanVerificationWithRunner(this.env, {
            tenantId: context.tenantId,
            action: purpose,
            // Either may happen whatever the page was for: a sign-in may create the account
            // (JIT), and a sign-up that finds the account signs in to it.
            alsoRequiredFor: [purpose === 'login' ? 'signup' : 'login'],
            responseToken: call.humanVerificationResponse,
          })
        ).verified;
      } catch {
        verified = false;
      }
      if (!verified) return { ok: false, reason: 'human_verification_failed' } as const;
      const spec: LiteStartGrantSpec = {
        provider: call.provider,
        action: purpose,
        policyRevision: context.policyRevision,
      };
      return context.store.issueStartGrantRpc({
        ...ref,
        spec,
        start: { clientId: call.clientId, interactionId },
      });
    });
  }

  #ref(
    context: {
      tenantId: string;
      bindingHash: string;
      policyRevision: string;
      publicOrigin: string;
    },
    txnId: string
  ) {
    return {
      tenantId: context.tenantId,
      bindingHash: context.bindingHash,
      txnId,
      policyRevision: context.policyRevision,
      publicOrigin: context.publicOrigin,
    };
  }
}
