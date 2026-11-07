/**
 * The lite Login UI's transactions, through the `LITE_TXN` service binding (ar-auth's
 * LiteTxnEntrypoint). The browser binding comes from the `__Host-authrim_lite` cookie, the public
 * origin and the visitor's IP from the request's edge context (lib/server/edge-context.ts): never
 * from the query, a form field or a tenant cookie, so none of them can move a transaction to
 * another tenant.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { getPlatformEnv } from '#lib/server/platform-env.js';
import { ensureBrowserBinding, readBrowserBinding } from './browser-binding';

export type LiteTxnPurpose = 'login' | 'signup' | 'reauth' | 'account';
export type LiteTxnState = 'open' | 'pending' | 'verified' | 'completed' | 'abandoned';

export interface LiteTxnView {
	id: string;
	bound: {
		tenantId: string;
		publicOrigin: string;
		purpose: LiteTxnPurpose;
		clientId: string | null;
		challengeId: string | null;
		returnTo: string | null;
		policyRevision: string;
		sessionId: string | null;
		userId: string | null;
	};
	state: LiteTxnState;
	version: number;
	csrfToken: string;
	data: Record<string, unknown>;
	createdAt: number;
	expiresAt: number;
}

export type LiteTxnAnswer = { ok: true; txn: LiteTxnView } | { ok: false; reason: string };

interface LiteTxnBinding {
	create(call: Record<string, unknown>): Promise<LiteTxnAnswer & { reused?: boolean }>;
	get(call: Record<string, unknown>): Promise<LiteTxnAnswer>;
	transition(call: Record<string, unknown>): Promise<LiteTxnAnswer>;
	beginOperation(
		call: Record<string, unknown>
	): Promise<
		| { ok: true; status: 'started'; attempt: number }
		| { ok: true; status: 'running' }
		| { ok: true; status: 'done'; result: unknown }
		| { ok: false; reason: string }
	>;
	completeOperation(call: Record<string, unknown>): Promise<LiteTxnAnswer>;
	issueStartGrant(
		call: Record<string, unknown>
	): Promise<{ ok: true; grantId: string } | { ok: false; reason: string }>;
}

export interface LiteTxnCreateInput {
	/** `account` and `reauth` are refused until their session check exists (lite plan PR7). */
	purpose: LiteTxnPurpose;
	clientId?: string | null;
	challengeId?: string | null;
	returnTo?: string | null;
	data?: Record<string, unknown>;
	reuseKey?: string;
}

const NO_BINDING = { ok: false, reason: 'invalid_binding' } as const;

const NOT_THROUGH_ROUTER = { ok: false, reason: 'not_through_router' } as const;

/**
 * The transactions of the request's browser, or null without the `LITE_TXN` binding or the
 * request's edge context (the lite guard sets it on every request; without it nothing here is
 * trusted). A transaction is made only for a request the Router checked at its edge: a request
 * straight to the Login UI's own hostname (workers.dev) has no trusted public origin.
 */
export function liteTxnClient(event: RequestEvent) {
	const service = getPlatformEnv(event)?.LITE_TXN as LiteTxnBinding | undefined;
	const edge = event.locals.edge;
	if (!service || !edge) return null;
	const publicOrigin = edge.publicOrigin;
	const clientIp = edge.clientIp;
	const call = (txnId: string) => {
		const binding = readBrowserBinding(event);
		return binding ? { publicOrigin, binding, txnId } : null;
	};

	return {
		/** Makes a transaction (and the browser binding, when the browser has none yet). */
		async create(input: LiteTxnCreateInput): Promise<LiteTxnAnswer & { reused?: boolean }> {
			if (edge.source !== 'router') return NOT_THROUGH_ROUTER;
			const { binding } = ensureBrowserBinding(event);
			return service.create({ ...input, publicOrigin, binding, clientIp });
		},
		/** `current`: checked against the tenant's current policy (before a form post acts). */
		async get(txnId: string, options: { current?: boolean } = {}): Promise<LiteTxnAnswer> {
			const base = call(txnId);
			return base ? service.get({ ...base, current: options.current === true }) : NO_BINDING;
		},
		async transition(
			txnId: string,
			move: { expectedVersion: number; to: LiteTxnState; patch?: Record<string, unknown> }
		): Promise<LiteTxnAnswer> {
			const base = call(txnId);
			return base ? service.transition({ ...base, ...move }) : NO_BINDING;
		},
		async beginOperation(txnId: string, operationId: string) {
			const base = call(txnId);
			return base ? service.beginOperation({ ...base, operationId }) : NO_BINDING;
		},
		/** Records an operation's result; `attempt` is what `beginOperation` answered. */
		async completeOperation(
			txnId: string,
			operationId: string,
			attempt: number,
			result: unknown,
			transition?: { expectedVersion: number; to: LiteTxnState; patch?: Record<string, unknown> }
		): Promise<LiteTxnAnswer> {
			const base = call(txnId);
			return base
				? service.completeOperation({ ...base, operationId, attempt, result, transition })
				: NO_BINDING;
		},
		/** A one-time start grant for the provider (its action is the transaction's purpose). */
		async issueStartGrant(txnId: string, provider: string) {
			const base = call(txnId);
			return base ? service.issueStartGrant({ ...base, provider }) : NO_BINDING;
		}
	};
}

export type LiteTxnClient = NonNullable<ReturnType<typeof liteTxnClient>>;
