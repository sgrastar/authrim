/**
 * The external sign-in start a lite transaction keeps (`data.social`) between the sign-in page's
 * `social_start` and the lite `/callback` (social-actions.ts).
 */
/** The longest page query a start keeps to go back to. */
const MAX_SEARCH_LENGTH = 2048;

/** An external sign-in started from this transaction, until its callback. */
export interface LitePendingSocial {
	interactionId: string;
	choiceStepId: string;
	/** The provider's ID as the Flow knows it (its slug, when it has one): the choice's handle. */
	provider: string;
	/** The grant the start was made with: its callback names it (ar-bridge's return). */
	grantId: string;
	/** The handoff the callback finished it with, once it did (a reload finds it). */
	handoff: string | null;
	/** The sign-in page's own query, to go back to (a local query string, or empty). */
	search: string;
	startedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/** A page query to go back to: empty, or `?` and no more than a query string holds. */
export function isLiteReturnSearch(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= MAX_SEARCH_LENGTH &&
		(value === '' || (value.startsWith('?') && !/[\s#\\]/u.test(value)))
	);
}

/**
 * The transaction's external sign-in start (for any interaction when `interactionId` is null);
 * null when there is none. It lasts as long as its transaction: ar-bridge keeps the start's state
 * for 10 minutes, and an account being made for another 5 from the provider's return, which the
 * transaction's own 15 minutes bound.
 */
export function readPendingSocial(
	data: Record<string, unknown>,
	interactionId: string | null
): LitePendingSocial | null {
	const social = data.social;
	if (!isRecord(social)) return null;
	if (interactionId !== null && social.interactionId !== interactionId) return null;
	if (!nonEmpty(social.interactionId) || !nonEmpty(social.choiceStepId)) return null;
	if (!nonEmpty(social.provider) || !isLiteReturnSearch(social.search)) return null;
	if (!nonEmpty(social.grantId)) return null;
	if (social.handoff !== undefined && social.handoff !== null && !nonEmpty(social.handoff)) {
		return null;
	}
	if (typeof social.startedAt !== 'number' || !Number.isFinite(social.startedAt)) return null;
	return {
		interactionId: social.interactionId,
		choiceStepId: social.choiceStepId,
		provider: social.provider,
		grantId: social.grantId,
		handoff: nonEmpty(social.handoff) ? social.handoff : null,
		search: social.search,
		startedAt: social.startedAt
	};
}
