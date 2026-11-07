/**
 * A post of the lite account page, and the account APIs' reads (account.ts and the widgets'
 * actions share them).
 */
import { fail, type RequestEvent } from '@sveltejs/kit';
import type { LiteBackendClient } from './backend-client';
import { liteBackendForEvent } from './backend-for-event';
import { readLiteForm } from './form';
import { sameToken } from './login-actions';
import { record } from './totp-passkey';
import { liteTxnClient, type LiteTxnView } from './txn-client';

/** GET of an account API (its JSON, or null with the status for a failure). */
export async function read(
	backend: LiteBackendClient,
	path: string,
	headers?: Record<string, string>
): Promise<
	{ ok: true; json: Record<string, unknown> } | { ok: false; status: number; error: string | null }
> {
	const answer = await backend.request(path, headers ? { headers } : {}).catch(() => null);
	if (!answer) return { ok: false, status: 503, error: null };
	if (answer.status === 200) return { ok: true, json: record(answer.json) };
	const code = record(answer.json).error;
	return { ok: false, status: answer.status, error: typeof code === 'string' ? code : null };
}

/** A post of the page: its transaction (form token, current policy), the browser's session. */
export async function openAccountPost(event: RequestEvent): Promise<
	| {
			post: {
				txns: NonNullable<ReturnType<typeof liteTxnClient>>;
				backend: LiteBackendClient;
				txn: LiteTxnView;
				fields: ReadonlyMap<string, string>;
			};
	  }
	| { failure: ReturnType<typeof fail> }
> {
	const refused = { failure: fail(403, { restart: true }) };
	const txns = liteTxnClient(event, { session: true });
	const backend = liteBackendForEvent(event, 'form_post');
	const form = await readLiteForm(event.request);
	if (!txns || !backend || !form.ok) return refused;
	const txnId = form.fields.get('txn');
	const token = form.fields.get('csrf');
	if (!txnId || !token) return refused;
	// Read only while the browser's session is the one it was made for, live, and its user's
	// (ar-auth checks): another tab's sign-in as someone else is not acted on from this page.
	const got = await txns.get(txnId, { current: true });
	if (!got.ok && got.reason === 'session_invalid') {
		return { failure: fail(409, { error: 'session_changed' as const }) };
	}
	if (!got.ok || !sameToken(got.txn.csrfToken, token)) return refused;
	if (got.txn.bound.purpose !== 'account') return refused;
	if (got.txn.state === 'completed' || got.txn.state === 'abandoned') return refused;
	return { post: { txns, backend, txn: got.txn, fields: form.fields } };
}

export type LiteAccountPost = Extract<
	Awaited<ReturnType<typeof openAccountPost>>,
	{ post: unknown }
>['post'];
