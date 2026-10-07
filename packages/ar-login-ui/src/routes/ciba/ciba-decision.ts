/**
 * The CIBA page's decision request and what its outcome means for the list. The page keeps the
 * state; this decides the message and whether the request can stay listed. A decision whose
 * answer never arrived is checked against the pending list before anything is said about it.
 */

import type { TranslationFunctions } from '$i18n/i18n-types';
import {
	cibaApprovalErrorMessage,
	classifyApprovalFailure,
	type ApprovalApiError
} from '$lib/api/approval-errors';

interface ApiResult {
	error?: ApprovalApiError;
}

export interface CibaDecisionApi {
	approve(authReqId: string): Promise<ApiResult>;
	reject(authReqId: string): Promise<ApiResult>;
	/** GET /api/ciba/requests/:auth_req_id: one request of the signed-in user. */
	getData(authReqId: string): Promise<{ data?: { status?: unknown }; error?: ApprovalApiError }>;
}

export type CibaDecisionOutcome =
	| { status: 'decided'; message: string }
	/**
	 * `dropRequest`: the request is gone or already decided, so it leaves the list. A request made
	 * before the person withdrew the application's access stays: it can still be denied.
	 */
	| { status: 'error'; message: string; dropRequest: boolean };

export async function decideCibaRequest(
	api: CibaDecisionApi,
	authReqId: string,
	decision: 'approve' | 'reject',
	LL: TranslationFunctions
): Promise<CibaDecisionOutcome> {
	const { error } =
		decision === 'approve' ? await api.approve(authReqId) : await api.reject(authReqId);
	if (!error) {
		return {
			status: 'decided',
			message: decision === 'approve' ? LL.ciba_approvedSuccess() : LL.ciba_rejectedSuccess()
		};
	}
	if (classifyApprovalFailure(error) === 'unknown') {
		return recheckCibaDecision(api, authReqId, LL);
	}
	return {
		status: 'error',
		message: cibaApprovalErrorMessage(
			LL,
			error,
			decision === 'approve' ? LL.ciba_errorApproveFailed() : LL.ciba_errorDenyFailed()
		),
		dropRequest: classifyApprovalFailure(error) === 'request_gone'
	};
}

/**
 * After a decision without an answer (network error, timeout) it may or may not have been saved.
 * The request itself says whether it is still waiting (the pending list is capped, so a request
 * missing from it proves nothing). Still pending says nothing either: the original request may
 * still be in flight. So the outcome stays unknown; a request no longer waiting (decided, expired,
 * or gone) leaves the list.
 */
async function recheckCibaDecision(
	api: CibaDecisionApi,
	authReqId: string,
	LL: TranslationFunctions
): Promise<CibaDecisionOutcome> {
	let current: Awaited<ReturnType<CibaDecisionApi['getData']>>;
	try {
		current = await api.getData(authReqId);
	} catch {
		current = { error: { error: 'network_error' } };
	}
	if (current.error) {
		return classifyApprovalFailure(current.error) === 'request_gone'
			? { status: 'error', message: LL.ciba_errorNoLongerWaiting(), dropRequest: true }
			: { status: 'error', message: LL.ciba_errorOutcomeUnknown(), dropRequest: false };
	}
	return current.data?.status === 'pending'
		? { status: 'error', message: LL.ciba_errorOutcomeUnknown(), dropRequest: false }
		: { status: 'error', message: LL.ciba_errorNoLongerWaiting(), dropRequest: true };
}
