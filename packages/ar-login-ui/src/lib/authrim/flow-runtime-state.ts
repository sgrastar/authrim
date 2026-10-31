import {
	readStoredFlowRuntimeState,
	type FlowRuntimeStartResponse,
	type StoredFlowRuntimeState
} from '@authrim/core';
import {
	LOGIN_UI_SESSION_STORAGE_KEYS,
	removeLoginUiSessionItems,
	setLoginUiSessionItem
} from './storage-keys';

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

/**
 * The stored state of an interaction, left in place. The page that resumes an interaction reads it
 * this way and removes it (consumeFlowRuntimeState) only once the interaction is complete or has
 * been handed on with its state stored again, so that a resume that fails for a moment can be tried
 * again.
 */
export function peekFlowRuntimeState(interactionId: string): StoredFlowRuntimeState | null {
	try {
		return readStoredFlowRuntimeState(
			sessionStorage.getItem(getFlowRuntimeStateKey(interactionId))
		);
	} catch {
		return null;
	}
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

/**
 * Forgets which interaction the external provider's return was to resume. Every external sign-in
 * starts by clearing it: the callback reads it, and one left by an earlier, abandoned attempt
 * (another Flow, another client) must not be picked up by this one.
 */
export function clearExternalFlowRuntimeHandoff(): void {
	try {
		removeLoginUiSessionItems([
			LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeInteractionId,
			LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeKind
		]);
	} catch {
		// Non-fatal: the callback then has nothing to resume.
	}
}

/**
 * Records the interaction the callback resumes after the external sign-in, replacing whatever an
 * earlier attempt left. Returns false if it could not be stored.
 */
export function recordExternalFlowRuntimeHandoff(
	flow: { interaction: { id: string; state: string } } | null,
	kind: 'login' | 'registration'
): boolean {
	clearExternalFlowRuntimeHandoff();
	if (!flow) return true;
	try {
		setLoginUiSessionItem(
			LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeInteractionId,
			flow.interaction.id
		);
		setLoginUiSessionItem(LOGIN_UI_SESSION_STORAGE_KEYS.externalFlowRuntimeKind, kind);
		return true;
	} catch {
		return false;
	}
}
