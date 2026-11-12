import { flowRuntimeAPI } from '#lib/api/flow-runtime.js';
import { readFormPost, submitFormPost } from '#lib/utils/form-post.js';
import { isValidRedirectUrl } from '#lib/utils/url-validation.js';
import { consumeFlowRuntimeState } from './flow-runtime-state.js';

/**
 * "Back to the app": cancels the sign-in at the backend (`/cancel`, authorised by the
 * interaction's kept contract hash and signature) and sends the browser where it says: a real
 * form post when the application uses `form_post` (asked for with the structured relay header),
 * else its redirect. `failed` (the backend refused, 409 or 503, or the answer has no destination)
 * and `invalid_redirect` leave the page as it is, for another try.
 */
export async function cancelRuntimeInteraction(input: {
	interactionId: string;
	contractHash: string;
	signature: string;
	stepId?: string;
	nodeId?: string;
}): Promise<'left' | 'failed' | 'invalid_redirect'> {
	try {
		const { data, error } = await flowRuntimeAPI.cancel(input.interactionId, {
			contract_hash: input.contractHash,
			signature: input.signature,
			...(input.stepId ? { step_id: input.stepId, node_id: input.nodeId } : {})
		});
		const formPost = error ? null : readFormPost(data);
		if (error || (!formPost && !data?.redirect_url)) return 'failed';
		if (!formPost && !isValidRedirectUrl(data?.redirect_url ?? '')) return 'invalid_redirect';
		consumeFlowRuntimeState(input.interactionId);
		if (formPost) submitFormPost(formPost);
		else window.location.href = data?.redirect_url ?? '';
		return 'left';
	} catch {
		return 'failed';
	}
}
