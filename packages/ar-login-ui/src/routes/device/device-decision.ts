/**
 * The device page's flow, without Svelte: look a user code up, show what it asks for, then approve
 * or deny exactly that code. The page renders the state this reports and forwards input to it.
 *
 * - The code that is approved or denied is the one whose details were shown. Editing the input
 *   discards the shown details, and an answer to an older lookup is ignored.
 * - A decision whose answer never arrived (network error, timeout) may have been saved. The flow
 *   looks the code up again and reports success only when the server attributes the approval to
 *   the signed-in user; otherwise it says the outcome is unknown.
 */

import type { TranslationFunctions } from '$i18n/i18n-types';
import {
	classifyApprovalFailure,
	deviceApprovalErrorMessage,
	type ApprovalApiError
} from '$lib/api/approval-errors';

interface ApiResult<T> {
	data?: T;
	error?: ApprovalApiError;
}

export interface DeviceCodeDetails {
	client_name: string;
	client_uri?: string;
	logo_uri?: string;
	scopes: string[];
}

export interface DeviceDecisionApi {
	lookup(userCode: string): Promise<ApiResult<DeviceCodeDetails>>;
	approve(userCode: string): Promise<ApiResult<unknown>>;
	deny(userCode: string): Promise<ApiResult<unknown>>;
}

export type DeviceDecision = 'approve' | 'deny';

export type DeviceLookupOutcome =
	| { status: 'found'; details: DeviceCodeDetails }
	| { status: 'error'; message: string; error?: ApprovalApiError };

export type DeviceDecisionOutcome =
	/** Approved or denied. */
	| { status: 'decided' }
	/** The code cannot be decided any more: back to code entry for a new code from the device. */
	| { status: 'restart'; message: string }
	/** Nothing changed: the person can try the same code again. */
	| { status: 'error'; message: string }
	/** No answer arrived: the decision may or may not have been saved. */
	| { status: 'unknown' };

export async function lookUpDeviceCode(
	api: DeviceDecisionApi,
	userCode: string,
	LL: TranslationFunctions
): Promise<DeviceLookupOutcome> {
	const { data, error } = await api.lookup(userCode);
	if (error || !data) {
		return {
			status: 'error',
			message: deviceApprovalErrorMessage(LL, error, LL.device_errorVerifyFailed()),
			error
		};
	}
	return {
		status: 'found',
		details: {
			client_name: data.client_name,
			client_uri: data.client_uri,
			logo_uri: data.logo_uri,
			scopes: data.scopes
		}
	};
}

export async function decideDeviceCode(
	api: DeviceDecisionApi,
	userCode: string,
	decision: DeviceDecision,
	LL: TranslationFunctions
): Promise<DeviceDecisionOutcome> {
	const { error } = decision === 'approve' ? await api.approve(userCode) : await api.deny(userCode);
	if (!error) {
		return { status: 'decided' };
	}
	const failure = classifyApprovalFailure(error);
	if (failure === 'unknown') {
		return { status: 'unknown' };
	}
	const message = deviceApprovalErrorMessage(
		LL,
		error,
		decision === 'approve' ? LL.device_errorApproveFailed() : LL.device_errorDenyFailed()
	);
	return failure === 'invalid_code' || failure === 'consent_withdrawn'
		? { status: 'restart', message }
		: { status: 'error', message };
}

/**
 * After a decision without an answer, what can be said about it. Only an approval the server
 * attributes to the signed-in user counts as done. A code still pending proves nothing (the
 * original request may still be in flight), nor does a code decided by someone else or a denial
 * (which records no user): those stay "outcome unknown". An expired code cannot be decided.
 */
export async function recheckDeviceDecision(
	api: DeviceDecisionApi,
	userCode: string,
	decision: DeviceDecision,
	LL: TranslationFunctions
): Promise<DeviceDecisionOutcome> {
	const lookup = await lookUpDeviceCode(api, userCode, LL);
	if (lookup.status === 'found') {
		return { status: 'error', message: LL.device_errorOutcomeUnknown() };
	}
	if (classifyApprovalFailure(lookup.error) !== 'invalid_code') {
		return { status: 'error', message: LL.device_errorOutcomeUnknown() };
	}
	if (
		decision === 'approve' &&
		lookup.error?.code_status === 'approved' &&
		lookup.error.decided_by_self === true
	) {
		return { status: 'decided' };
	}
	return {
		status: 'restart',
		message:
			lookup.error?.code_status === 'expired'
				? LL.device_errorInvalidOrExpiredCode()
				: LL.device_errorOutcomeUnknown()
	};
}

export interface DeviceFlowState {
	step: 'input' | 'verified';
	/** The code as typed (formatted XXXX-XXXX). */
	userCode: string;
	/** The details of the looked-up code; shown only in the `verified` step. */
	deviceInfo: DeviceCodeDetails | null;
	error: string;
	success: string;
	verifying: boolean;
	loading: boolean;
}

export interface DeviceFlowOptions {
	api: DeviceDecisionApi;
	/** The current translations (read at the time of each message). */
	translations: () => TranslationFunctions;
	onChange: (state: DeviceFlowState) => void;
	/** Called after the code was denied. */
	onDenied: () => void;
}

export function formatUserCode(value: string): string {
	const clean = value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
	return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4, 8)}` : clean;
}

export type DeviceFlow = ReturnType<typeof createDeviceFlow>;

export function createDeviceFlow(options: DeviceFlowOptions) {
	let state: DeviceFlowState = {
		step: 'input',
		userCode: '',
		deviceInfo: null,
		error: '',
		success: '',
		verifying: false,
		loading: false
	};
	/** The code whose details are shown, as sent to the lookup; the only code a decision uses. */
	let confirmedCode: string | null = null;
	/** Incremented by every lookup and every edit: an answer for an older value is stale. */
	let lookupTicket = 0;

	function update(patch: Partial<DeviceFlowState>) {
		state = { ...state, ...patch };
		options.onChange(state);
	}

	function restart(message: string) {
		confirmedCode = null;
		lookupTicket += 1;
		update({ step: 'input', deviceInfo: null, userCode: '', error: message, success: '' });
	}

	return {
		get state(): DeviceFlowState {
			return state;
		},

		/** The input changed: forget any lookup in flight and any shown details. */
		setUserCode(value: string): string {
			const formatted = formatUserCode(value);
			if (formatted !== state.userCode || confirmedCode !== null) {
				lookupTicket += 1;
				confirmedCode = null;
				update({
					userCode: formatted,
					step: 'input',
					deviceInfo: null,
					verifying: false,
					success: ''
				});
			}
			return formatted;
		},

		dismissError() {
			update({ error: '' });
		},

		async verify() {
			const LL = options.translations();
			if (state.verifying || state.loading) return;
			const code = state.userCode.replace(/-/g, '');
			if (code.length !== 8) {
				update({ error: LL.device_errorInvalidCode() });
				return;
			}
			const ticket = ++lookupTicket;
			confirmedCode = null;
			update({ error: '', verifying: true });
			let outcome: DeviceLookupOutcome;
			try {
				outcome = await lookUpDeviceCode(options.api, code, LL);
			} catch {
				outcome = { status: 'error', message: LL.device_errorVerifyFailed() };
			}
			if (ticket !== lookupTicket) return; // The code was edited meanwhile.
			if (outcome.status === 'found') {
				confirmedCode = code;
				update({ verifying: false, step: 'verified', deviceInfo: outcome.details });
			} else {
				update({ verifying: false, error: outcome.message });
			}
		},

		async decide(decision: DeviceDecision) {
			const LL = options.translations();
			const code = confirmedCode;
			if (state.loading || state.step !== 'verified' || !code) return;
			update({ loading: true, error: '' });
			let outcome: DeviceDecisionOutcome;
			try {
				outcome = await decideDeviceCode(options.api, code, decision, LL);
				if (outcome.status === 'unknown') {
					outcome = await recheckDeviceDecision(options.api, code, decision, LL);
				}
			} catch {
				outcome = { status: 'error', message: LL.device_errorOutcomeUnknown() };
			}
			update({ loading: false });
			if (outcome.status === 'decided') {
				if (decision === 'approve') {
					update({ success: LL.device_success() });
				} else {
					options.onDenied();
				}
			} else if (outcome.status === 'restart') {
				restart(outcome.message);
			} else if (outcome.status === 'error') {
				update({ error: outcome.message });
			} else {
				update({ error: LL.device_errorOutcomeUnknown() });
			}
		}
	};
}
