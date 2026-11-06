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
	purpose: LiteTxnPurpose;
	clientId?: string | null;
	challengeId?: string | null;
	returnTo?: string | null;
	sessionId?: string | null;
	userId?: string | null;
	data?: Record<string, unknown>;
	reuseKey?: string;
}

const NO_BINDING = { ok: false, reason: 'invalid_binding' } as const;

/** The transactions of the request's browser, or null without the `LITE_TXN` binding. */
export function liteTxnClient(event: RequestEvent) {
	const service = getPlatformEnv(event)?.LITE_TXN as LiteTxnBinding | undefined;
	if (!service) return null;
	const publicOrigin = event.locals.edge?.publicOrigin ?? event.url.origin;
	const clientIp = event.locals.edge?.clientIp ?? null;
	const call = (txnId: string) => {
		const binding = readBrowserBinding(event);
		return binding ? { publicOrigin, binding, txnId } : null;
	};

	return {
		/** Makes a transaction (and the browser binding, when the browser has none yet). */
		create(input: LiteTxnCreateInput) {
			const { binding } = ensureBrowserBinding(event);
			return service.create({ ...input, publicOrigin, binding, clientIp });
		},
		async get(txnId: string): Promise<LiteTxnAnswer> {
			const base = call(txnId);
			return base ? service.get(base) : NO_BINDING;
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
		async issueStartGrant(txnId: string, provider: string, action: LiteTxnPurpose) {
			const base = call(txnId);
			return base ? service.issueStartGrant({ ...base, provider, action }) : NO_BINDING;
		}
	};
}

export type LiteTxnClient = NonNullable<ReturnType<typeof liteTxnClient>>;
