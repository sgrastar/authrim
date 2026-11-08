/**
 * The lite account page's authenticator apps (lite plan PR7b; the SPA's AccountTotpWidget): the
 * list, adding one (its secret and QR code, then a code from it to activate it), its backup codes
 * (shown once, never kept), and removing one with a code or a backup code. A change ar-management
 * asks a step-up for is held for it (account-security.ts).
 *
 * A code or a backup code posted is never kept in the transaction (the SPA keeps it in memory
 * only): a held change is made again without it. A step-up with an authenticator is proof enough
 * for ar-management then; after another, it asks for the code again (a code from an app lasts
 * seconds, a backup code is spent once).
 */
import { fail, type RequestEvent } from '@sveltejs/kit';
import { openAccountPost, type LiteAccountPost } from './account-post';
import {
	holdForStepUp,
	move,
	moveCurrent,
	registerPendingAction,
	stepUpAsked,
	stepUpBusy
} from './account-security';
import { liteAccountItemId } from './account-widgets';
import { retryLater } from './login-actions';
import { formatTimestamp } from '#lib/utils/date.js';
import { record } from './totp-passkey';
import type { liteMessages } from './messages';

type LL = Awaited<ReturnType<typeof liteMessages>>['LL'];

/**
 * How long an enrollment begun is kept for its activation (the transaction lasts 15 minutes): one
 * past it is drawn no more and removed from the transaction when the page is next drawn.
 */
const ENROLL_TTL_MS = 600_000;
/**
 * How long the making of backup codes taken waits before another post may take it: well past any
 * answer of ar-management (a post that never ended gives it back only then). A post whose API call
 * reached ar-management later still would replace the codes made meanwhile; ar-management keeps no
 * turn of its own to refuse it (the residual case, left to it).
 */
const CODES_TTL_MS = 120_000;

function text(value: unknown, max = 8192): string | null {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** An authenticator being added: its secret and link (its QR code is drawn from them). */
export interface LiteAccountTotpEnroll {
	credentialId: string;
	secret: string;
	otpauthUri: string;
	expiresAt: number;
}

export function readLiteAccountTotpEnroll(
	data: Record<string, unknown>,
	now = Date.now()
): LiteAccountTotpEnroll | null {
	const held = record(data.accountTotpEnroll);
	const credentialId = liteAccountItemId(held.credentialId);
	const secret =
		typeof held.secret === 'string' && /^[A-Z2-7]{16,128}=*$/u.test(held.secret)
			? held.secret
			: null;
	const otpauthUri =
		typeof held.otpauthUri === 'string' &&
		held.otpauthUri.length <= 2048 &&
		held.otpauthUri.startsWith('otpauth://totp/')
			? held.otpauthUri
			: null;
	return credentialId &&
		secret &&
		otpauthUri &&
		typeof held.expiresAt === 'number' &&
		held.expiresAt > now
		? { credentialId, secret, otpauthUri, expiresAt: held.expiresAt }
		: null;
}

export interface LiteAccountTotpView {
	credentials: Array<{
		id: string;
		name: string;
		meta: string;
		pending: boolean;
		used: string;
	}>;
	backupCodes: { total: number; remaining: number };
	/** Whether some credential is active (its backup codes may be made again). */
	active: boolean;
}

/** The list, as the SPA's widget shows it. */
export function liteAccountTotp(
	json: Record<string, unknown>,
	LL: LL,
	locale: string
): LiteAccountTotpView {
	const rows = Array.isArray(json.credentials) ? json.credentials : [];
	const credentials = rows.flatMap((raw) => {
		const row = record(raw);
		const id = liteAccountItemId(row.id);
		if (!id) return [];
		const lastUsed = typeof row.last_used_at === 'number' ? row.last_used_at : null;
		return [
			{
				id,
				name: text(row.label) ?? LL.account_totpDefaultName(),
				meta: `${text(row.algorithm) ?? ''} / ${typeof row.digits === 'number' ? row.digits : ''} / ${
					typeof row.period === 'number' ? row.period : ''
				}s`,
				pending: row.status !== 'active',
				used:
					lastUsed !== null
						? LL.account_totpLastUsed({ time: formatTimestamp(lastUsed, locale) })
						: formatTimestamp(row.created_at as number | null, locale)
			}
		];
	});
	const backup = record(json.backup_codes);
	const count = (value: unknown) =>
		typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
	return {
		credentials,
		backupCodes: { total: count(backup.total), remaining: count(backup.remaining) },
		active: rows.some((raw) => record(raw).status === 'active')
	};
}

/** Backup codes an answer gives (shown once: the action's answer, never the transaction). */
function backupCodesOf(json: unknown): string[] {
	const codes = record(json).backup_codes;
	return Array.isArray(codes)
		? codes
				.filter(
					(code): code is string => typeof code === 'string' && /^[A-Za-z0-9-]{4,32}$/u.test(code)
				)
				.slice(0, 32)
		: [];
}

function failed(answer: { status: number; json: unknown } | null, fallback = 'action_failed') {
	const error = record(answer?.json).error;
	return fail(answer && answer.status < 500 ? (answer.status === 429 ? 429 : 400) : 503, {
		error:
			error === 'remaining_login_method_required'
				? 'remaining_method'
				: error === 'invalid_code'
					? 'code_invalid'
					: answer?.status === 429
						? 'busy'
						: fallback,
		widget: 'totp'
	});
}

/** `totp_add`: an authenticator begun (its secret and QR code drawn, to activate it). */
async function startTotpAdd(
	_event: RequestEvent,
	post: LiteAccountPost,
	args: Record<string, string>
) {
	const label = (args.label ?? '').trim();
	if (label.length > 100) return fail(400, { error: 'action_failed' as const, widget: 'totp' });
	const answer = await post.backend
		.request('/api/account/totp/options', { json: label ? { label } : {} })
		.catch(() => null);
	if (stepUpAsked(answer)) return holdForStepUp(post, { action: 'totp_add', args: { label } });
	const json = record(answer?.json);
	const credentialId = liteAccountItemId(record(json.credential).id);
	// (ar-management answers an enrollment begun with 201.)
	if ((answer?.status !== 201 && answer?.status !== 200) || !credentialId) return failed(answer);
	const enroll = {
		credentialId,
		secret: json.secret,
		otpauthUri: json.otpauth_uri,
		expiresAt: Date.now() + ENROLL_TTL_MS
	};
	if (!readLiteAccountTotpEnroll({ accountTotpEnroll: enroll })) return failed(null);
	const kept = await move(post, { accountTotpEnroll: enroll });
	if (!kept) return retryLater();
	return { notice: 'totp_enroll' as const, widget: 'totp' };
}

/**
 * The enrollment of `credentialId` given up in the transaction, whatever moved it meanwhile (an
 * enrollment of another credential is kept). Whether none of it is left.
 */
async function clearEnroll(post: LiteAccountPost, credentialId: string): Promise<boolean> {
	const moved = await moveCurrent(
		post,
		(data) => record(data.accountTotpEnroll).credentialId === credentialId,
		{ accountTotpEnroll: null }
	);
	return moved !== null;
}

/**
 * Backup codes are made by one post at a time: an activation and a regeneration each replace all of
 * the account's codes, so of two at once (a double submit, another tab) the other is told to wait,
 * and a post whose turn another took (past its time) shows none: the codes shown are always the
 * last ones made. Never over a step-up whose check is under way (its post moves the transaction).
 */
async function takeCodes(
	post: LiteAccountPost
): Promise<{ post: LiteAccountPost; owner: string } | { failure: unknown }> {
	const now = Date.now();
	const taken = record(post.txn.data.accountTotpCodes);
	if (
		stepUpBusy(post.txn.data) ||
		(typeof taken.at === 'number' && taken.at <= now && now - taken.at < CODES_TTL_MS)
	) {
		return { failure: fail(409, { error: 'busy' as const, widget: 'totp' }) };
	}
	const owner = crypto.randomUUID();
	const moved = await move(post, { accountTotpCodes: { at: now, owner } });
	if (!moved) return { failure: retryLater() };
	return { post: { ...post, txn: moved }, owner };
}

/**
 * The turn given back: the transaction then (null when it could not be read), and whether it was
 * still this post's (none took it meanwhile).
 */
async function releaseCodes(post: LiteAccountPost, owner: string) {
	const moved = await moveCurrent(post, (data) => record(data.accountTotpCodes).owner === owner, {
		accountTotpCodes: null
	});
	// Its codes are shown only when the turn was given back by this post: a release that could not
	// be made (the transaction unread) shows none (it lapses on its own).
	return { txn: moved === 'gone' ? null : moved, mine: moved !== 'gone' && moved !== null };
}

/** `totp_regenerate`: new backup codes (shown once; one post at a time: takeCodes). */
async function regenerateBackupCodes(
	_event: RequestEvent,
	post: LiteAccountPost,
	args: Record<string, string>
) {
	const code = (args.code ?? '').replace(/\s+/gu, '');
	if (code && !/^(\d{6}|\d{8})$/u.test(code)) {
		return fail(400, { error: 'code_invalid' as const, widget: 'totp' });
	}
	const turn = await takeCodes(post);
	if ('failure' in turn) return turn.failure;
	const answer = await post.backend
		.request('/api/account/totp/backup-codes/regenerate', { json: code ? { code } : {} })
		.catch(() => null);
	const released = await releaseCodes(turn.post, turn.owner);
	if (stepUpAsked(answer)) {
		return holdForStepUp(
			{ ...post, txn: released.txn ?? turn.post.txn },
			{ action: 'totp_regenerate', args: {} }
		);
	}
	if (answer?.status !== 200) return failed(answer);
	if (!released.mine) return fail(409, { error: 'busy' as const, widget: 'totp' });
	return { backupCodes: backupCodesOf(answer.json), widget: 'totp' };
}

/**
 * `totp_delete`: an authenticator removed, with a code from it or a backup code (sent as the SPA
 * sends them: a code of 6 or 8 digits, else the backup code as given). One not yet activated, or
 * after a step-up with an authenticator, needs neither (ar-management decides).
 */
async function deleteTotp(
	_event: RequestEvent,
	post: LiteAccountPost,
	args: Record<string, string>
) {
	const id = liteAccountItemId(args.id);
	const proof = (args.proof ?? '').trim();
	if (!id) return fail(400, { error: 'action_failed' as const, widget: 'totp' });
	const digits = proof.replace(/\s+/gu, '');
	const backup = proof.toUpperCase().replace(/[^A-Z0-9]/gu, '');
	const body = !proof
		? {}
		: /^(\d{6}|\d{8})$/u.test(digits)
			? { code: digits }
			: /^[A-Z0-9]{12}$/u.test(backup) && proof.length <= 32
				? { backup_code: proof }
				: null;
	if (!body) return fail(400, { error: 'code_invalid' as const, widget: 'totp' });
	const answer = await post.backend
		.request(`/api/account/totp/${encodeURIComponent(id)}`, { method: 'DELETE', json: body })
		.catch(() => null);
	if (stepUpAsked(answer)) return holdForStepUp(post, { action: 'totp_delete', args: { id } });
	if (answer?.status !== 200) return failed(answer);
	// An authenticator removed while it was being added: its setup (and secret) goes with it.
	await clearEnroll(post, id);
	return { notice: 'totp_deleted' as const, widget: 'totp' };
}

registerPendingAction('totp_add', startTotpAdd);
registerPendingAction('totp_regenerate', regenerateBackupCodes);
registerPendingAction('totp_delete', deleteTotp);

export async function liteAccountTotpAddAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	return startTotpAdd(event, opened.post, { label: opened.post.fields.get('label') ?? '' });
}

/**
 * `totp_activate`: the authenticator begun, activated with a code from it; its backup codes shown
 * once. A step-up asked for holds nothing of the code (one from an app lasts seconds): once proven,
 * the person enters a new one.
 */
export async function liteAccountTotpActivateAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const { post } = opened;
	const enroll = readLiteAccountTotpEnroll(post.txn.data);
	if (!enroll || post.fields.get('credential') !== enroll.credentialId) {
		return fail(409, { error: 'action_failed' as const, widget: 'totp' });
	}
	const code = (post.fields.get('code') ?? '').replace(/\s+/gu, '');
	if (!/^(\d{6}|\d{8})$/u.test(code)) {
		return fail(400, { error: 'code_invalid' as const, widget: 'totp' });
	}
	const turn = await takeCodes(post);
	if ('failure' in turn) return turn.failure;
	const answer = await post.backend
		.request('/api/account/totp/activate', { json: { credential_id: enroll.credentialId, code } })
		.catch(() => null);
	const released = await releaseCodes(turn.post, turn.owner);
	const after = { ...post, txn: released.txn ?? turn.post.txn };
	if (stepUpAsked(answer)) return holdForStepUp(after, { action: 'totp_reenter', args: {} });
	if (answer?.status !== 200 || record(answer.json).ok !== true)
		return failed(answer, 'code_invalid');
	// Activated: its setup given up, and its codes shown whatever else moved the transaction (they
	// are shown only now), unless another post made newer ones meanwhile.
	await clearEnroll(after, enroll.credentialId);
	if (!released.mine) return fail(409, { error: 'busy' as const, widget: 'totp' });
	return { backupCodes: backupCodesOf(answer.json), widget: 'totp' };
}

/** After a step-up asked for at activation: nothing to make again (a new code is entered). */
registerPendingAction('totp_reenter', async () => ({
	notice: 'totp_reenter' as const,
	widget: 'totp'
}));

/**
 * `totp_cancel`: the authenticator begun given up (here; its pending credential stays listed). Only
 * the one the form was drawn for: an older page's form gives up no later enrollment.
 */
export async function liteAccountTotpCancelAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const credentialId = liteAccountItemId(opened.post.fields.get('credential'));
	if (!credentialId) return fail(400, { error: 'action_failed' as const, widget: 'totp' });
	if (!(await clearEnroll(opened.post, credentialId))) return retryLater();
	return { notice: 'totp_cancelled' as const, widget: 'totp' };
}

/**
 * Whether the transaction keeps an enrollment no longer drawn (past its time, or unreadable): the
 * page removes it (its secret is kept no longer than drawn).
 */
export function liteAccountTotpEnrollStale(data: Record<string, unknown>): boolean {
	return data.accountTotpEnroll !== undefined && readLiteAccountTotpEnroll(data) === null;
}

export async function liteAccountTotpRegenerateAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	return regenerateBackupCodes(event, opened.post, { code: opened.post.fields.get('code') ?? '' });
}

export async function liteAccountTotpDeleteAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	return deleteTotp(event, opened.post, {
		id: opened.post.fields.get('totp') ?? '',
		proof: opened.post.fields.get('proof') ?? ''
	});
}

export const liteAccountTotpActions = {
	totp_add: liteAccountTotpAddAction,
	totp_activate: liteAccountTotpActivateAction,
	totp_cancel: liteAccountTotpCancelAction,
	totp_regenerate: liteAccountTotpRegenerateAction,
	totp_delete: liteAccountTotpDeleteAction
};
