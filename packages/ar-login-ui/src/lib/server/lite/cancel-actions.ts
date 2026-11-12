/**
 * The lite step page's `cancel` action: "Back to the app" on a sign-in whose Flow says it can be
 * left (`cancel_available`). A verified form post like the others (`openPost`); the backend decides
 * (`/cancel`), and the page relays the browser to where it says: the application's redirect, or a
 * form post as data. Refused, the page is drawn again with the error.
 */
import { fail } from '@sveltejs/kit';
import { LITE_RELAY_SUBMIT_SCRIPT, relayFormActionOrigin } from '#lib/lite/relay.js';
import {
	cancelLiteInteraction,
	cancelRequestKeyOfTxn,
	clearCancelWaiting,
	setCancelWaiting
} from './cancel';
import { forwardSetCookies } from './cookies';
import { cspHashSource } from './csp';
import { guarded, openPost } from './login-actions';
import { readKeptFlow } from './flow-driver';
import { liteMessages } from './messages';

export const liteCancelAction = guarded(async (event) => {
	// Not resumed: an interaction a cancel already ended (its answer lost) is answered again by
	// `/cancel`, which decides whether it may (409 `cancel_not_available`).
	const opened = await openPost(event, { cancel: true });
	if ('failure' in opened) return opened.failure;
	const post = opened.post;
	// No operation is recorded: a cancel may be sent again whatever came of the last (a lost or
	// failed answer), and `/cancel` gives the stored answer for an interaction it ended.
	const again = post.txn.state === 'completed';
	const requestKey = cancelRequestKeyOfTxn(post.txn);
	const stillState = post.txn.state === 'verified' ? 'verified' : 'pending';
	// Marked before it is sent, with the interaction it is for: if it ends the interaction and its
	// answer is lost, the page asks again for that one (never resumes or starts another).
	if (!again && !readKeptFlow({ flow: post.txn.data.cancelPending })) {
		const marked = await post.txns
			.transition(post.txn.id, {
				expectedVersion: post.txn.version,
				to: stillState,
				patch: { cancelPending: post.flow.state }
			})
			.catch(() => null);
		if (!marked?.ok) return fail(409, { error: 'cancel_failed' as const });
		post.txn = marked.txn;
		if (requestKey) await setCancelWaiting(event, requestKey, post.txn.id);
	}
	const outcome = await cancelLiteInteraction(
		post.backend,
		post.flow.state,
		post.flow.step,
		post.txn.bound.publicOrigin
	);
	if (outcome.kind === 'failed') {
		// Refused while the interaction is live (409 `cancel_not_available`): nothing is pending.
		// Anything else (503, a failed call) may have ended it: the page asks again.
		if (outcome.status === 409 && !again) {
			if (requestKey) await clearCancelWaiting(event, requestKey, post.txn.id);
			await post.txns
				.transition(post.txn.id, {
					expectedVersion: post.txn.version,
					to: stillState,
					patch: { cancelPending: null }
				})
				.catch(() => null);
		}
		forwardSetCookies(event, post.backend.setCookies());
		return fail(outcome.status === 429 ? 429 : 409, {
			error: outcome.status === 429 ? ('busy' as const) : ('cancel_failed' as const)
		});
	}
	// A form post as data goes only to an acceptable destination (an http(s) origin).
	const postOrigin =
		outcome.kind === 'form_post'
			? relayFormActionOrigin({ method: 'post', action: outcome.action, fields: outcome.fields })
			: null;
	if (outcome.kind === 'form_post' && !postOrigin) {
		forwardSetCookies(event, post.backend.setCookies());
		return fail(409, { error: 'cancel_failed' as const });
	}
	// The sign-in is over for good: it no longer counts as live, and a reload does not resume it.
	// The relay goes on whatever the move answers.
	if (!again) {
		await post.txns
			.transition(post.txn.id, {
				expectedVersion: post.txn.version,
				to: 'completed',
				patch: {
					cancelled: true,
					cancelPending: null,
					completedTo: outcome.kind === 'redirect' ? outcome.url : outcome.action,
					code: null,
					totp: null,
					passkey: null,
					social: null,
					checked: null,
					signedIn: null,
					signInRedirect: null
				}
			})
			.catch(() => null);
	}
	if (requestKey) await clearCancelWaiting(event, requestKey, post.txn.id);
	forwardSetCookies(event, post.backend.setCookies());
	const { LL } = await liteMessages(event.locals.locale);
	if (outcome.kind === 'redirect') {
		event.locals.liteRelay = { url: outcome.url, continueLabel: LL.common_continue() };
	} else if (postOrigin) {
		event.locals.liteRelayPost = {
			action: outcome.action,
			fields: outcome.fields,
			continueLabel: LL.common_continue()
		};
		// The page's form-action names only the destination's origin; its fixed script posts the form.
		event.locals.liteCsp = {
			scriptHashes: [await cspHashSource(LITE_RELAY_SUBMIT_SCRIPT)],
			formAction: postOrigin
		};
	}
	return { cancelled: true };
});
