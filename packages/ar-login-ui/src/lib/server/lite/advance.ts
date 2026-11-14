/**
 * Inside a verified form post: the SPA's own advance. The steps the SPA submits without the
 * person (not rendered; a completion once signed in; an account action that asks nothing) are
 * submitted here, up to MAX_RUNTIME_AUTO_ADVANCE_STEPS, until the Flow completes or reaches a
 * step the person must see. Never from a page view (plan §14).
 */
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import {
	MAX_RUNTIME_AUTO_ADVANCE_STEPS,
	runtimeAutoSubmitHandle,
	runtimeStepWaitsForSignIn
} from '#lib/authrim/flow-runtime-steps.js';
import { LITE_FLOW_COMPONENTS } from '@authrim/ar-lib-core/services/lite-compatibility';
import type { LiteBackendClient } from './backend-client';
import type { LiteFlowState } from './flow-driver';
import { readLiteFlowConsent } from './flow-consent';

export type LiteAdvanceResult =
	/** The Flow completed: its output (the continuation). */
	| { kind: 'completed'; output: Record<string, unknown> | null }
	/** A step the person must see (the step itself): the page draws it. */
	| { kind: 'draw'; step: FlowRuntimeStep }
	/** A completion (or a held condition) reached without a signed-in session: nothing more can
	 * happen here. */
	| { kind: 'sign_in_required' }
	| { kind: 'failed'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function advanceLiteFlow(
	backend: LiteBackendClient,
	state: LiteFlowState,
	first: FlowRuntimeStep | null,
	options: {
		signedIn: boolean;
		steps?: readonly FlowRuntimeStep[];
		/**
		 * The consent decision a step's submit carries (the post's, or one kept for its terms): `{}`
		 * for a step without consent; null when the step asks for consent no decision is at hand
		 * for, which stops here for the page to ask (its Continue draws the terms). Without it, a
		 * step with consent is never submitted.
		 */
		consentInput?: (step: FlowRuntimeStep) => Promise<Record<string, unknown> | null>;
	}
): Promise<LiteAdvanceResult> {
	let step = first;
	for (let i = 0; i < MAX_RUNTIME_AUTO_ADVANCE_STEPS; i++) {
		if (!step) return { kind: 'failed', error: 'step_missing' };
		// Nothing the lite UI does not drive is submitted, here as on a page view.
		if (!LITE_FLOW_COMPONENTS.has(step.component)) {
			return { kind: 'failed', error: 'step_unsupported' };
		}
		const handle = runtimeAutoSubmitHandle(step);
		if (handle === null) return { kind: 'draw', step };
		// The completion, or a condition held for the sign-in (it reads the person), waits for one.
		if (runtimeStepWaitsForSignIn(step) && !options.signedIn) return { kind: 'sign_in_required' };
		const input = options.consentInput
			? await options.consentInput(step)
			: readLiteFlowConsent(step) === null
				? {}
				: null;
		if (!input) return { kind: 'draw', step };
		const answer = await backend.request(
			`/api/v1/login/interactions/${encodeURIComponent(state.interactionId)}/submit`,
			{
				json: {
					step_id: step.id,
					node_id: step.source_node_id,
					selected_handle: handle,
					contract_hash: state.contractHash,
					signature: state.signature,
					input
				}
			}
		);
		const json = isRecord(answer.json) ? answer.json : {};
		if (answer.status !== 200) {
			return {
				kind: 'failed',
				error: typeof json.error === 'string' ? json.error : 'submit_failed'
			};
		}
		if (json.completed === true) {
			return { kind: 'completed', output: isRecord(json.output) ? json.output : null };
		}
		const next = isRecord(json.step) ? (json.step as unknown as FlowRuntimeStep) : null;
		const interaction = isRecord(json.interaction) ? json.interaction : {};
		step =
			next ??
			options.steps?.find((candidate) => candidate.id === interaction.current_step_id) ??
			null;
	}
	return { kind: 'failed', error: 'too_many_steps' };
}
