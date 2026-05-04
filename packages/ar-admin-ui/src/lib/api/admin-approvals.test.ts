import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminApprovalsAPI } from './admin-approvals'

describe('adminApprovalsAPI', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('builds list query params for status and investigation id', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ items: [], total: 0 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)

		await adminApprovalsAPI.list({
			status: 'pending',
			investigationId: 'inv_123',
			limit: 10
		})

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/approvals?status=pending&investigation_id=inv_123&limit=10'),
			expect.any(Object)
		)
	})

	it('posts decision payload to approve endpoint', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ id: 'req-1', approvals: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)

		await adminApprovalsAPI.approve('req-1', 'step-1', {
			method: 'portal_confirm',
			reason_code: 'support_case'
		})

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/approvals/req-1/steps/step-1/approve'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					method: 'portal_confirm',
					reason_code: 'support_case'
				})
			})
		)
	})

	it('posts create payload to approvals endpoint', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ public_request_id: 'apr_1', approvals: [] }), {
					status: 201,
					headers: { 'Content-Type': 'application/json' }
				})
			)

		await adminApprovalsAPI.create({
			target_subject_type: 'user',
			target_subject_id: 'user-1',
			request_surface: 'admin_audit',
			requested_action: 'detail_read',
			resource_class: 'admin_audit_detail',
			reason_code: 'support_case',
			policy_preset: 'support_case_default',
			approvals: [
				{
					step_key: 'operator-1',
					side: 'admin_operator',
					subject_type: 'admin_user',
					subject_id: 'admin-2'
				}
			]
		})

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/approvals'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					target_subject_type: 'user',
					target_subject_id: 'user-1',
					request_surface: 'admin_audit',
					requested_action: 'detail_read',
					resource_class: 'admin_audit_detail',
					reason_code: 'support_case',
					policy_preset: 'support_case_default',
					approvals: [
						{
							step_key: 'operator-1',
							side: 'admin_operator',
							subject_type: 'admin_user',
							subject_id: 'admin-2'
						}
					]
				})
			})
		)
	})

	it('posts preview payload to the preview endpoint', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ request: { investigation_id: 'inv_1' }, steps: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)

		await adminApprovalsAPI.preview({
			target_subject_type: 'user',
			target_subject_id: 'user-1',
			request_surface: 'admin_audit',
			requested_action: 'detail_read',
			resource_class: 'admin_audit_detail',
			reason_code: 'support_case',
			policy_preset: 'support_case_default',
			approvals: [
				{
					step_key: 'operator-1',
					side: 'admin_operator',
					subject_type: 'admin_user',
					subject_id: 'admin-2'
				}
			]
		})

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/approvals/preview'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					target_subject_type: 'user',
					target_subject_id: 'user-1',
					request_surface: 'admin_audit',
					requested_action: 'detail_read',
					resource_class: 'admin_audit_detail',
					reason_code: 'support_case',
					policy_preset: 'support_case_default',
					approvals: [
						{
							step_key: 'operator-1',
							side: 'admin_operator',
							subject_type: 'admin_user',
							subject_id: 'admin-2'
						}
					]
				})
			})
		)
	})

	it('posts remind payload to remind endpoint', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ id: 'req-1', approvals: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)

		await adminApprovalsAPI.remind('req-1', 'step-1', {
			method: 'portal_confirm',
			reason_code: 'support_case'
		})

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/approvals/req-1/steps/step-1/remind'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					method: 'portal_confirm',
					reason_code: 'support_case'
				})
			})
		)
	})

	it('loads approval transport evidence from the detail endpoint', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ version: 1, request: {}, events: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)

		await adminApprovalsAPI.getEvidence('apr_1')

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/approvals/apr_1/evidence'),
			expect.any(Object)
		)
	})

	it('loads approval decision receipts from the receipts endpoint', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ request_id: 'apr_1', investigation_id: 'inv_1', items: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)

		await adminApprovalsAPI.getReceipts('apr_1')

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/approvals/apr_1/receipts'),
			expect.any(Object)
		)
	})

	it('loads approval step guide from the guide endpoint', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ approval_id: 'step_1', guide: null }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)

		await adminApprovalsAPI.getStepGuide('apr_1', 'step_1')

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/approvals/apr_1/steps/step_1/guide'),
			expect.any(Object)
		)
	})

	it('posts subject token issuance payload to the grant endpoint', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ subject_token: 'jwt', expires_in: 180 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)

		await adminApprovalsAPI.issueSubjectToken('apr_1', 'egr_1', {
			client_id: 'svc-client-1',
			expires_in: 180
		})

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/approvals/apr_1/grants/egr_1/subject-token'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					client_id: 'svc-client-1',
					expires_in: 180
				})
			})
		)
	})

	it('posts revoke payload to the grant revoke endpoint', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ grants: [] }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)

		await adminApprovalsAPI.revokeGrant('apr_1', 'egr_1', {
			reason_code: 'manual_revoke',
			reason_note: 'Support case closed'
		})

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/approvals/apr_1/grants/egr_1/revoke'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					reason_code: 'manual_revoke',
					reason_note: 'Support case closed'
				})
			})
		)
	})

	it('posts artifact issuance payload to the approval step artifacts endpoint', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ artifact: { artifact_id: 'apc_1' } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)

		await adminApprovalsAPI.issueCompletionArtifact('apr_1', 'step_1', {
			method: 'portal_confirm',
			expires_in_seconds: 600
		})

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/approvals/apr_1/steps/step_1/artifacts'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					method: 'portal_confirm',
					expires_in_seconds: 600
				})
			})
		)
	})
})
