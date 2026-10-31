// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowRuntimeStartResponse } from '$lib/api/flow-runtime';
import {
	clearExternalFlowRuntimeHandoff,
	consumeFlowRuntimeState,
	recordExternalFlowRuntimeHandoff,
	peekFlowRuntimeState,
	persistFlowRuntimeState,
	updateFlowRuntimePostAuthRedirect
} from '../flow-runtime-state';
import { LOGIN_UI_SESSION_STORAGE_KEYS } from '../storage-keys';

function createFlow(interactionId: string): FlowRuntimeStartResponse {
	return {
		schema_version: 'authrim.login_ui.contract.v1',
		interaction: {
			id: interactionId,
			state: 'active',
			flow_id: 'flow_login',
			flow_version_id: 'fv_1',
			current_node_id: 'auth',
			current_step_id: 'auth:step',
			expires_at: Math.floor(Date.now() / 1000) + 600
		},
		contract: {
			flow_kind: 'login',
			ui: { steps: [] }
		},
		contract_hash: 'hash_1',
		signature: 'sig_1',
		expires_in: 600,
		resumed: false
	};
}

describe('Flow runtime session state', () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	it('updates the stored post-auth redirect without changing signed runtime fields', () => {
		expect(persistFlowRuntimeState(createFlow('interaction_1'))).toBe(true);

		expect(updateFlowRuntimePostAuthRedirect('interaction_1', '/login/complete')).toBe(true);

		const state = consumeFlowRuntimeState('interaction_1');
		expect(state).toEqual({
			interaction_id: 'interaction_1',
			contract_hash: 'hash_1',
			signature: 'sig_1',
			post_auth_redirect: '/login/complete'
		});
	});

	it('returns false when external IdP callback state references an unknown interaction', () => {
		expect(updateFlowRuntimePostAuthRedirect('missing', '/login/complete')).toBe(false);
		expect(
			sessionStorage.getItem(`${LOGIN_UI_SESSION_STORAGE_KEYS.flowRuntimeStatePrefix}missing`)
		).toBeNull();
	});

	describe("the interaction an external provider's return resumes", () => {
		const interactionKey = LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeInteractionId;
		const kindKey = LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeKind;

		it('records an open Flow for the callback to resume', () => {
			expect(recordExternalFlowRuntimeHandoff(createFlow('interaction_open'), 'login')).toBe(true);

			expect(sessionStorage.getItem(interactionKey)).toBe('interaction_open');
			expect(sessionStorage.getItem(kindKey)).toBe('login');
		});

		it('does not resume an earlier, abandoned Flow when a later sign-in begins', () => {
			// An external sign-in begun for Flow A and abandoned leaves its interaction behind ...
			recordExternalFlowRuntimeHandoff(createFlow('interaction_a'), 'registration');
			expect(sessionStorage.getItem(interactionKey)).toBe('interaction_a');

			// ... and the next one clears it before anything else: when its Flow is complete or
			// cannot be stored, the callback has nothing of Flow A to pick up.
			clearExternalFlowRuntimeHandoff();

			expect(sessionStorage.getItem(interactionKey)).toBeNull();
			expect(sessionStorage.getItem(kindKey)).toBeNull();
		});

		it('replaces the earlier interaction with this one', () => {
			recordExternalFlowRuntimeHandoff(createFlow('interaction_a'), 'registration');
			recordExternalFlowRuntimeHandoff(createFlow('interaction_b'), 'login');

			expect(sessionStorage.getItem(interactionKey)).toBe('interaction_b');
			expect(sessionStorage.getItem(kindKey)).toBe('login');
		});

		it('forgets the interaction when asked to, and when there is no Flow', () => {
			recordExternalFlowRuntimeHandoff(createFlow('interaction_a'), 'login');
			clearExternalFlowRuntimeHandoff();
			expect(sessionStorage.getItem(interactionKey)).toBeNull();

			recordExternalFlowRuntimeHandoff(createFlow('interaction_a'), 'login');
			expect(recordExternalFlowRuntimeHandoff(null, 'login')).toBe(true);
			expect(sessionStorage.getItem(interactionKey)).toBeNull();
		});
	});

	it('can be read without being removed, so a resume that fails for a moment can be tried again', () => {
		persistFlowRuntimeState(createFlow('interaction_1'));

		expect(peekFlowRuntimeState('interaction_1')).toMatchObject({
			interaction_id: 'interaction_1'
		});
		expect(peekFlowRuntimeState('interaction_1')).toMatchObject({
			interaction_id: 'interaction_1'
		});
		expect(consumeFlowRuntimeState('interaction_1')).toMatchObject({
			interaction_id: 'interaction_1'
		});
		expect(peekFlowRuntimeState('interaction_1')).toBeNull();
	});
});
