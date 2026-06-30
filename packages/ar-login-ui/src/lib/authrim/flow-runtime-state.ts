import type { FlowRuntimeStartResponse } from '../api/flow-runtime';
import { LOGIN_UI_SESSION_STORAGE_KEYS } from './storage-keys';

export interface StoredFlowRuntimeState {
	interaction_id: string;
	contract_hash: string;
	signature: string;
	post_auth_redirect?: string;
}

function getFlowRuntimeStateKey(interactionId: string): string {
	return `${LOGIN_UI_SESSION_STORAGE_KEYS.flowRuntimeStatePrefix}${interactionId}`;
}

function readStoredFlowRuntimeState(value: string | null): StoredFlowRuntimeState | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as StoredFlowRuntimeState;
		if (!parsed || typeof parsed !== 'object') return null;
		if (
			typeof parsed.interaction_id !== 'string' ||
			typeof parsed.contract_hash !== 'string' ||
			typeof parsed.signature !== 'string'
		) {
			return null;
		}
		if (parsed.post_auth_redirect !== undefined && typeof parsed.post_auth_redirect !== 'string') {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
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
