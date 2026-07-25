import {
	readStoredFlowRuntimeState,
	type FlowRuntimeStartResponse,
	type StoredFlowRuntimeState
} from '@authrim/core';
import { LOGIN_UI_SESSION_STORAGE_KEYS } from './storage-keys';

export type { StoredFlowRuntimeState };

function getFlowRuntimeStateKey(interactionId: string): string {
	return `${LOGIN_UI_SESSION_STORAGE_KEYS.flowRuntimeStatePrefix}${interactionId}`;
}

export function persistFlowRuntimeState(
	flow: FlowRuntimeStartResponse,
	options: { postAuthRedirect?: string | null } = {}
): boolean {
	return persistStoredFlowRuntimeState({
		interaction_id: flow.interaction.id,
		contract_hash: flow.contract_hash,
		signature: flow.signature,
		...(options.postAuthRedirect ? { post_auth_redirect: options.postAuthRedirect } : {})
	});
}

export function persistStoredFlowRuntimeState(state: StoredFlowRuntimeState): boolean {
	try {
		sessionStorage.setItem(getFlowRuntimeStateKey(state.interaction_id), JSON.stringify(state));
		return true;
	} catch {
		return false;
	}
}

export function updateFlowRuntimePostAuthRedirect(
	interactionId: string,
	postAuthRedirect: string
): boolean {
	const state = readStoredFlowRuntimeState(
		sessionStorage.getItem(getFlowRuntimeStateKey(interactionId))
	);
	if (!state) return false;
	return persistStoredFlowRuntimeState({
		...state,
		post_auth_redirect: postAuthRedirect
	});
}

export function consumeFlowRuntimeState(interactionId: string): StoredFlowRuntimeState | null {
	const key = getFlowRuntimeStateKey(interactionId);
	try {
		const state = readStoredFlowRuntimeState(sessionStorage.getItem(key));
		sessionStorage.removeItem(key);
		return state;
	} catch {
		return null;
	}
}
