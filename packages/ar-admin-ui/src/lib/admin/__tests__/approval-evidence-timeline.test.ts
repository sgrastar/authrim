import { describe, expect, it } from 'vitest';
import type { ApprovalTransportEvidenceEvent } from '$lib/api/admin-approvals';
import {
	getApprovalEvidenceArtifactSwitch,
	getApprovalEvidenceCompletionArtifact,
	getApprovalEvidenceDecisionReceipt,
	getApprovalEvidenceGrantSubjectTokenIssue,
	getApprovalEvidenceEventDescriptor,
	getApprovalEvidenceEventMeta
} from '../approval-evidence-timeline';

describe('approval evidence timeline helpers', () => {
	it('describes approval switch events with stable labels', () => {
		const descriptor = getApprovalEvidenceEventDescriptor({
			id: 'evt-1',
			kind: 'step_resend',
			at: Date.now(),
			request_status: 'pending',
			transport_detail: null
		} satisfies ApprovalTransportEvidenceEvent);

		expect(descriptor).toEqual({
			title: 'Notification Reissued',
			tone: 'warning',
			summary: 'The completion path or notification was reissued for the pending step.'
		});
	});

	it('describes grant revoke events with a danger tone', () => {
		const descriptor = getApprovalEvidenceEventDescriptor({
			id: 'evt-revoke',
			kind: 'grant_revoked',
			at: Date.now(),
			request_status: 'approved',
			transport_detail: null
		} satisfies ApprovalTransportEvidenceEvent);

		expect(descriptor).toEqual({
			title: 'Grant Revoked',
			tone: 'danger',
			summary: 'An active elevation grant was revoked before expiry.'
		});
	});

	it('extracts artifact switch and completion artifact metadata', () => {
		const event = {
			id: 'evt-2',
			kind: 'step_resend',
			at: Date.now(),
			request_status: 'pending',
			transport_detail: {
				request: null,
				response: null,
				metadata: {
					artifact_switch: {
						previous_artifact_id: 'apc_1',
						previous_method: 'portal_confirm',
						requested_method: 'passkey',
						allowed_methods: ['portal_confirm', 'passkey', 'reauth']
					},
					approval_completion_artifact: {
						artifact_id: 'apc_2',
						path: '/api/approval-artifacts/apc_2/portal',
						expires_at: 1730000000000
					}
				}
			}
		} satisfies ApprovalTransportEvidenceEvent;

		expect(getApprovalEvidenceArtifactSwitch(event)).toEqual({
			previousArtifactId: 'apc_1',
			previousMethod: 'portal_confirm',
			requestedMethod: 'passkey',
			allowedMethods: ['portal_confirm', 'passkey', 'reauth']
		});
		expect(getApprovalEvidenceCompletionArtifact(event)).toEqual({
			artifactId: 'apc_2',
			path: '/api/approval-artifacts/apc_2/portal',
			expiresAt: 1730000000000
		});
	});

	it('extracts decision receipt metadata', () => {
		const descriptor = getApprovalEvidenceEventDescriptor({
			id: 'evt-receipt',
			kind: 'step_receipt_issued',
			at: Date.now(),
			request_status: 'approved',
			transport_detail: {
				request: null,
				response: null,
				metadata: {
					approval_decision_receipt: {
						receipt_id: 'adr_1',
						path: '/api/approval-receipts/adr_1',
						portal_path: '/api/approval-receipts/adr_1/portal',
						decision: 'approved',
						request_status: 'approved',
						expires_at: 1730000100000,
						grant_ids: ['egr_1']
					}
				}
			}
		} satisfies ApprovalTransportEvidenceEvent);

		expect(descriptor).toEqual({
			title: 'Decision Receipt Issued',
			tone: 'success',
			summary: 'A post-decision receipt was recorded for approver follow-up and audit.'
		});
		expect(
			getApprovalEvidenceDecisionReceipt({
				id: 'evt-receipt',
				kind: 'step_receipt_issued',
				at: Date.now(),
				request_status: 'approved',
				transport_detail: {
					request: null,
					response: null,
					metadata: {
						approval_decision_receipt: {
							receipt_id: 'adr_1',
							path: '/api/approval-receipts/adr_1',
							portal_path: '/api/approval-receipts/adr_1/portal',
							decision: 'approved',
							request_status: 'approved',
							expires_at: 1730000100000,
							grant_ids: ['egr_1']
						}
					}
				}
			} satisfies ApprovalTransportEvidenceEvent)
		).toEqual({
			receiptId: 'adr_1',
			path: '/api/approval-receipts/adr_1',
			portalPath: '/api/approval-receipts/adr_1/portal',
			decision: 'approved',
			requestStatus: 'approved',
			expiresAt: 1730000100000,
			grantIds: ['egr_1']
		});
	});

	it('extracts downstream subject token issuance metadata', () => {
		const descriptor = getApprovalEvidenceEventDescriptor({
			id: 'evt-token',
			kind: 'grant_subject_token_issued',
			at: Date.now(),
			request_status: 'approved',
			transport_detail: {
				request: null,
				response: null,
				metadata: {
					approval_grant_subject_token: {
						public_grant_id: 'egr_1',
						client_id: 'svc-client-1',
						subject_token_type: 'urn:authrim:token-type:elevation-grant',
						expires_in: 180,
						jti: 'subject-jti-1',
						target_audience: 'svc://customer-portal',
						resource_class: 'customer_profile',
						resource_ids: ['profile-1'],
						detail_classes: ['profile_export'],
						redaction_level: 'raw',
						requires_online_check: true,
						fail_closed: true,
						require_full_access: true
					}
				}
			}
		} satisfies ApprovalTransportEvidenceEvent);

		expect(descriptor).toEqual({
			title: 'Subject Token Issued',
			tone: 'info',
			summary:
				'A downstream subject token was issued for service-side token exchange and protected resource access.'
		});
		expect(
			getApprovalEvidenceGrantSubjectTokenIssue({
				id: 'evt-token',
				kind: 'grant_subject_token_issued',
				at: Date.now(),
				request_status: 'approved',
				transport_detail: {
					request: null,
					response: null,
					metadata: {
						approval_grant_subject_token: {
							public_grant_id: 'egr_1',
							client_id: 'svc-client-1',
							subject_token_type: 'urn:authrim:token-type:elevation-grant',
							expires_in: 180,
							jti: 'subject-jti-1',
							target_audience: 'svc://customer-portal',
							resource_class: 'customer_profile',
							resource_ids: ['profile-1'],
							detail_classes: ['profile_export'],
							redaction_level: 'raw',
							requires_online_check: true,
							fail_closed: true,
							require_full_access: true
						}
					}
				}
			} satisfies ApprovalTransportEvidenceEvent)
		).toEqual({
			grantId: 'egr_1',
			clientId: 'svc-client-1',
			subjectTokenType: 'urn:authrim:token-type:elevation-grant',
			expiresIn: 180,
			jti: 'subject-jti-1',
			targetAudience: 'svc://customer-portal',
			resourceClass: 'customer_profile',
			resourceIds: ['profile-1'],
			detailClasses: ['profile_export'],
			redactionLevel: 'raw',
			requiresOnlineCheck: true,
			failClosed: true,
			requireFullAccess: true
		});
	});

	it('builds concise event meta strings', () => {
		const meta = getApprovalEvidenceEventMeta({
			id: 'evt-3',
			kind: 'step_approved',
			at: Date.now(),
			request_status: 'approved',
			method: 'passkey',
			transport_channel: 'Registered passkey on this device',
			notification_action: 'resend',
			notification_count: 2,
			reason_code: 'support_case'
		} satisfies ApprovalTransportEvidenceEvent);

		expect(meta).toEqual([
			'Method: passkey',
			'Channel: Registered passkey on this device',
			'Notify: resend',
			'Count: 2',
			'Reason: support_case'
		]);
	});
});
