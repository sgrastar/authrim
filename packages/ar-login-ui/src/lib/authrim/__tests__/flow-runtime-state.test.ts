// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import type { FlowRuntimeStartResponse } from '$lib/api/flow-runtime';
import {
	consumeFlowRuntimeState,
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
});
