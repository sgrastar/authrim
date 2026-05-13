import type { ApprovalTransportEvidenceEvent } from '$lib/api/admin-approvals';

export type ApprovalEvidenceTone = 'info' | 'success' | 'warning' | 'danger';

export interface ApprovalEvidenceEventDescriptor {
	title: string;
	tone: ApprovalEvidenceTone;
	summary: string;
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function getApprovalEvidenceEventDescriptor(
	event: ApprovalTransportEvidenceEvent
): ApprovalEvidenceEventDescriptor {
	switch (event.kind) {
		case 'request_created':
			return {
				title: 'Request Created',
				tone: 'info',
				summary: 'The approval request was created and queued for step resolution.'
			};
		case 'step_initial':
			return {
				title: 'Initial Notification',
				tone: 'info',
				summary: 'The first completion path or notification was issued for this approval step.'
			};
		case 'step_artifact_issued':
			return {
				title: 'Artifact Issued',
				tone: 'info',
				summary: 'A completion artifact was issued manually for this approval step.'
			};
		case 'step_receipt_issued':
			return {
				title: 'Decision Receipt Issued',
				tone: 'success',
				summary: 'A post-decision receipt was recorded for approver follow-up and audit.'
			};
		case 'grant_subject_token_issued':
			return {
				title: 'Subject Token Issued',
				tone: 'info',
				summary:
					'A downstream subject token was issued for service-side token exchange and protected resource access.'
			};
		case 'grant_revoked':
			return {
				title: 'Grant Revoked',
				tone: 'danger',
				summary: 'An active elevation grant was revoked before expiry.'
			};
		case 'step_remind':
			return {
				title: 'Reminder Sent',
				tone: 'warning',
				summary: 'A reminder was sent for the pending approval step.'
			};
		case 'step_resend':
			return {
				title: 'Notification Reissued',
				tone: 'warning',
				summary: 'The completion path or notification was reissued for the pending step.'
			};
		case 'step_approved':
			return {
				title: 'Step Approved',
				tone: 'success',
				summary: 'The approver completed the step and the request moved forward.'
			};
		case 'step_denied':
			return {
				title: 'Step Denied',
				tone: 'danger',
				summary: 'The approver denied the step and the request was blocked.'
			};
		case 'request_cancelled':
			return {
				title: 'Request Cancelled',
				tone: 'danger',
				summary: 'The approval request was cancelled before all steps completed.'
			};
		default:
			return {
				title: event.kind,
				tone: 'info',
				summary: 'Approval transport evidence recorded an event for this request.'
			};
	}
}

export function getApprovalEvidenceArtifactSwitch(event: ApprovalTransportEvidenceEvent): {
	previousArtifactId: string | null;
	previousMethod: string | null;
	requestedMethod: string | null;
	allowedMethods: string[];
} | null {
	const metadata = asRecord(event.transport_detail?.metadata);
	const artifactSwitch = asRecord(metadata?.artifact_switch);
	if (!artifactSwitch) {
		return null;
	}

	return {
		previousArtifactId: asString(artifactSwitch.previous_artifact_id),
		previousMethod: asString(artifactSwitch.previous_method),
		requestedMethod: asString(artifactSwitch.requested_method),
		allowedMethods: Array.isArray(artifactSwitch.allowed_methods)
			? artifactSwitch.allowed_methods.filter((value): value is string => typeof value === 'string')
			: []
	};
}

export function getApprovalEvidenceCompletionArtifact(event: ApprovalTransportEvidenceEvent): {
	artifactId: string | null;
	path: string | null;
	expiresAt: number | null;
} | null {
	const metadata = asRecord(event.transport_detail?.metadata);
	const artifact = asRecord(metadata?.approval_completion_artifact);
	if (!artifact) {
		return null;
	}

	const expiresAt =
		typeof artifact.expires_at === 'number' && Number.isFinite(artifact.expires_at)
			? artifact.expires_at
			: null;

	return {
		artifactId: asString(artifact.artifact_id),
		path: asString(artifact.path),
		expiresAt
	};
}

export function getApprovalEvidenceDecisionReceipt(event: ApprovalTransportEvidenceEvent): {
	receiptId: string | null;
	path: string | null;
	portalPath: string | null;
	decision: string | null;
	requestStatus: string | null;
	expiresAt: number | null;
	grantIds: string[];
} | null {
	const metadata = asRecord(event.transport_detail?.metadata);
	const receipt = asRecord(metadata?.approval_decision_receipt);
	if (!receipt) {
		return null;
	}

	const expiresAt =
		typeof receipt.expires_at === 'number' && Number.isFinite(receipt.expires_at)
			? receipt.expires_at
			: null;

	return {
		receiptId: asString(receipt.receipt_id),
		path: asString(receipt.path),
		portalPath: asString(receipt.portal_path),
		decision: asString(receipt.decision),
		requestStatus: asString(receipt.request_status),
		expiresAt,
		grantIds: Array.isArray(receipt.grant_ids)
			? receipt.grant_ids.filter((value): value is string => typeof value === 'string')
			: []
	};
}

export function getApprovalEvidenceGrantSubjectTokenIssue(event: ApprovalTransportEvidenceEvent): {
	grantId: string | null;
	clientId: string | null;
	subjectTokenType: string | null;
	expiresIn: number | null;
	jti: string | null;
	targetAudience: string | null;
	resourceClass: string | null;
	resourceIds: string[];
	detailClasses: string[];
	redactionLevel: string | null;
	requiresOnlineCheck: boolean | null;
	failClosed: boolean | null;
	requireFullAccess: boolean | null;
} | null {
	const metadata = asRecord(event.transport_detail?.metadata);
	const issue = asRecord(metadata?.approval_grant_subject_token);
	if (!issue) {
		return null;
	}

	const expiresIn =
		typeof issue.expires_in === 'number' && Number.isFinite(issue.expires_in)
			? issue.expires_in
			: null;

	return {
		grantId: asString(issue.public_grant_id),
		clientId: asString(issue.client_id),
		subjectTokenType: asString(issue.subject_token_type),
		expiresIn,
		jti: asString(issue.jti),
		targetAudience: asString(issue.target_audience),
		resourceClass: asString(issue.resource_class),
		resourceIds: Array.isArray(issue.resource_ids)
			? issue.resource_ids.filter((value): value is string => typeof value === 'string')
			: [],
		detailClasses: Array.isArray(issue.detail_classes)
			? issue.detail_classes.filter((value): value is string => typeof value === 'string')
			: [],
		redactionLevel: asString(issue.redaction_level),
		requiresOnlineCheck:
			typeof issue.requires_online_check === 'boolean' ? issue.requires_online_check : null,
		failClosed: typeof issue.fail_closed === 'boolean' ? issue.fail_closed : null,
		requireFullAccess:
			typeof issue.require_full_access === 'boolean' ? issue.require_full_access : null
	};
}

export function getApprovalEvidenceEventMeta(event: ApprovalTransportEvidenceEvent): string[] {
	const meta: string[] = [];

	if (event.method) {
		meta.push(`Method: ${event.method}`);
	}
	if (event.transport_channel) {
		meta.push(`Channel: ${event.transport_channel}`);
	}
	if (event.notification_action) {
		meta.push(`Notify: ${event.notification_action}`);
	}
	if (typeof event.notification_count === 'number') {
		meta.push(`Count: ${event.notification_count}`);
	}
	if (event.reason_code) {
		meta.push(`Reason: ${event.reason_code}`);
	}

	return meta;
}
