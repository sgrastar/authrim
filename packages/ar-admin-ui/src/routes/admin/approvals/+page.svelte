<script lang="ts">
	import { onMount } from 'svelte'
	import { Modal } from '$lib/components'
	import ApprovalCompletionGuideCard from '$lib/components/admin/ApprovalCompletionGuideCard.svelte'
	import ApprovalDecisionReceiptsPanel from '$lib/components/admin/ApprovalDecisionReceiptsPanel.svelte'
	import ApprovalGrantGuideCard from '$lib/components/admin/ApprovalGrantGuideCard.svelte'
	import ApprovalGrantIntegrationCard from '$lib/components/admin/ApprovalGrantIntegrationCard.svelte'
	import ApprovalEvidenceTimeline from '$lib/components/admin/ApprovalEvidenceTimeline.svelte'
	import ApprovalRequestPreviewPanel from '$lib/components/admin/ApprovalRequestPreviewPanel.svelte'
	import ApprovalStepGuideCard from '$lib/components/admin/ApprovalStepGuideCard.svelte'
	import {
		adminApprovalsAPI,
		type ApprovalCompletionArtifactIssueResult,
		type ApprovalDecisionReceiptRecord,
		type ApprovalGrantSubjectTokenResult,
		type ApprovalRequestPreviewResult,
		type ApprovalStepGuideResult,
		type ApprovalTransportEvidence,
		type ApprovalRequestCreateInput,
		type ApprovalRequestApproval,
		type ApprovalRequestRecord,
		type ApprovalRequestStatus,
		type ApprovalTransportMethod,
		type ElevationGrantRecord
	} from '$lib/api/admin-approvals'

	let loading = $state(true)
	let error = $state('')
	let requests = $state<ApprovalRequestRecord[]>([])
	let total = $state(0)

	let statusFilter = $state<ApprovalRequestStatus | ''>('')
	let investigationIdFilter = $state('')

	let showCreateModal = $state(false)
	let createBusy = $state(false)
	let createError = $state('')
	let createPreviewBusy = $state(false)
	let createPreviewError = $state('')
	let createPreview = $state<ApprovalRequestPreviewResult | null>(null)
	let createModel = $state<ApprovalRequestCreateInput>(buildInitialCreateModel())
	let createResourceIds = $state('')
	let createDetailClasses = $state('')
	let createReferenceSystem = $state('')
	let createReferenceId = $state('')
	let createReferenceUrl = $state('')
	let createTicketSystem = $state('')
	let createTicketId = $state('')
	let createTicketUrl = $state('')

	let selectedRequest = $state<ApprovalRequestRecord | null>(null)
	let showDetailModal = $state(false)
	let detailLoading = $state(false)
	let detailError = $state('')
	let actionBusy = $state(false)
	let actionError = $state('')
	let actionTransportProvider = $state('')
	let actionTransportStatus = $state('')
	let actionTransportTarget = $state('')
	let actionTransportCorrelationId = $state('')
	let actionTransportRequestId = $state('')
	let actionTransportRequestJson = $state('')
	let actionTransportResponseJson = $state('')
	let actionTransportMetadataJson = $state('')
	let detailEvidenceLoading = $state(false)
	let detailEvidenceError = $state('')
	let detailEvidence = $state<ApprovalTransportEvidence | null>(null)
	let detailReceiptsLoading = $state(false)
	let detailReceiptsError = $state('')
	let detailReceipts = $state<ApprovalDecisionReceiptRecord[]>([])
	let stepGuideLoadingId = $state<string | null>(null)
	let stepGuideError = $state('')
	let stepGuides = $state<Record<string, ApprovalStepGuideResult | undefined>>({})
	let issuingGrantId = $state<string | null>(null)
	let subjectTokenBusy = $state(false)
	let subjectTokenError = $state('')
	let subjectTokenClientId = $state('')
	let subjectTokenExpiresIn = $state(300)
	let issuedSubjectToken = $state<ApprovalGrantSubjectTokenResult | null>(null)
	let revokeGrantBusyId = $state<string | null>(null)
	let revokeGrantError = $state('')
	let issuingArtifactApprovalId = $state<string | null>(null)
	let issuedCompletionArtifact = $state<ApprovalCompletionArtifactIssueResult | null>(null)
	let actionReasonCode = $state('support_case')
	let actionReasonNote = $state('')
	let actionMethod = $state<ApprovalTransportMethod>('portal_confirm')
	const TRANSPORT_REQUEST_PLACEHOLDER = '{"channel":"portal_confirm"}'
	const TRANSPORT_RESPONSE_PLACEHOLDER = '{"status":"accepted"}'
	const TRANSPORT_METADATA_PLACEHOLDER = '{"attempt":2}'

	async function loadRequests() {
		loading = true
		error = ''

		try {
			const response = await adminApprovalsAPI.list({
				status: statusFilter || undefined,
				investigationId: investigationIdFilter.trim() || undefined,
				limit: 100
			})
			requests = response.items
			total = response.total
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load approvals'
		} finally {
			loading = false
		}
	}

	onMount(() => {
		loadRequests()
	})

	function buildInitialCreateModel(): ApprovalRequestCreateInput {
		return {
			target_subject_type: 'user',
			target_subject_id: '',
			request_surface: 'admin_audit',
			requested_action: 'detail_read',
			resource_class: 'admin_audit_detail',
			reason_code: 'support_case',
			policy_preset: 'support_case_default',
			reuse_scope: 'request',
			redaction_level: 'masked',
			partial_access_allowed: false,
			approvals: [
				{
					step_key: 'operator-1',
					side: 'admin_operator',
					subject_type: 'admin_user',
					subject_id: '',
					method: 'portal_confirm'
				}
			]
		}
	}

	function resetCreateForm() {
		createModel = buildInitialCreateModel()
		createResourceIds = ''
		createDetailClasses = ''
		createReferenceSystem = ''
		createReferenceId = ''
		createReferenceUrl = ''
		createTicketSystem = ''
		createTicketId = ''
		createTicketUrl = ''
		createBusy = false
		createError = ''
		createPreviewBusy = false
		createPreviewError = ''
		createPreview = null
	}

	function openCreateModal() {
		resetCreateForm()
		showCreateModal = true
	}

	function closeCreateModal() {
		showCreateModal = false
		resetCreateForm()
	}

	function resetActionTransportInputs() {
		actionTransportProvider = ''
		actionTransportStatus = ''
		actionTransportTarget = ''
		actionTransportCorrelationId = ''
		actionTransportRequestId = ''
		actionTransportRequestJson = ''
		actionTransportResponseJson = ''
		actionTransportMetadataJson = ''
	}

	async function openDetail(request: ApprovalRequestRecord) {
		showDetailModal = true
		selectedRequest = request
		detailLoading = true
		detailError = ''
		detailEvidence = null
		detailEvidenceLoading = false
		detailEvidenceError = ''
		detailReceipts = []
		detailReceiptsLoading = false
		detailReceiptsError = ''
		stepGuideLoadingId = null
		stepGuideError = ''
		stepGuides = {}
		issuingGrantId = null
		subjectTokenBusy = false
		subjectTokenError = ''
		subjectTokenClientId = ''
		subjectTokenExpiresIn = 300
		issuedSubjectToken = null
		revokeGrantBusyId = null
		revokeGrantError = ''
		issuingArtifactApprovalId = null
		issuedCompletionArtifact = null
		actionError = ''
		actionReasonNote = ''
		resetActionTransportInputs()

		try {
			selectedRequest = await adminApprovalsAPI.get(request.public_request_id)
			if (selectedRequest.has_detail) {
				await reloadDetailTracking(selectedRequest)
			}
		} catch (err) {
			detailError = err instanceof Error ? err.message : 'Failed to load approval request'
		} finally {
			detailLoading = false
		}
	}

	function closeDetail() {
		showDetailModal = false
		selectedRequest = null
		detailLoading = false
		detailError = ''
		detailEvidence = null
		detailEvidenceLoading = false
		detailEvidenceError = ''
		detailReceipts = []
		detailReceiptsLoading = false
		detailReceiptsError = ''
		stepGuideLoadingId = null
		stepGuideError = ''
		stepGuides = {}
		issuingGrantId = null
		subjectTokenBusy = false
		subjectTokenError = ''
		subjectTokenClientId = ''
		subjectTokenExpiresIn = 300
		issuedSubjectToken = null
		issuingArtifactApprovalId = null
		issuedCompletionArtifact = null
		actionBusy = false
		actionError = ''
		actionReasonNote = ''
		resetActionTransportInputs()
	}

	async function refreshSelectedRequest(requestId: string) {
		selectedRequest = await adminApprovalsAPI.get(requestId)
	}

	async function reloadDetailTracking(request: ApprovalRequestRecord) {
		detailEvidenceLoading = true
		detailEvidenceError = ''
		detailReceiptsLoading = true
		detailReceiptsError = ''

		const [evidenceResult, receiptResult] = await Promise.allSettled([
			adminApprovalsAPI.getEvidence(request.public_request_id),
			adminApprovalsAPI.getReceipts(request.public_request_id)
		])

		if (evidenceResult.status === 'fulfilled') {
			detailEvidence = evidenceResult.value
		} else {
			detailEvidenceError =
				evidenceResult.reason instanceof Error
					? evidenceResult.reason.message
					: 'Failed to load transport evidence'
		}
		detailEvidenceLoading = false

		if (receiptResult.status === 'fulfilled') {
			detailReceipts = receiptResult.value.items
		} else {
			detailReceiptsError =
				receiptResult.reason instanceof Error
					? receiptResult.reason.message
					: 'Failed to load decision receipts'
		}
		detailReceiptsLoading = false
	}

	async function loadStepGuide(approval: ApprovalRequestApproval) {
		if (!selectedRequest) return
		stepGuideLoadingId = approval.id
		stepGuideError = ''

		try {
			const guide = await adminApprovalsAPI.getStepGuide(selectedRequest.public_request_id, approval.id)
			stepGuides = {
				...stepGuides,
				[approval.id]: guide
			}
		} catch (err) {
			stepGuideError = err instanceof Error ? err.message : 'Failed to load approval step guide'
		} finally {
			stepGuideLoadingId = null
		}
	}

	async function approveStep(approval: ApprovalRequestApproval) {
		if (!selectedRequest) return
		actionBusy = true
		actionError = ''

		try {
			const transport = buildActionTransportPayload()
			await adminApprovalsAPI.approve(selectedRequest.public_request_id, approval.id, {
				method: actionMethod,
				reason_code: actionReasonCode || undefined,
				reason_note: actionReasonNote || undefined,
				...transport
			})
			await refreshSelectedRequest(selectedRequest.public_request_id)
			if (selectedRequest?.has_detail) {
				await reloadDetailTracking(selectedRequest)
			}
			await loadRequests()
			actionReasonNote = ''
			resetActionTransportInputs()
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'Failed to approve step'
		} finally {
			actionBusy = false
		}
	}

	async function denyStep(approval: ApprovalRequestApproval) {
		if (!selectedRequest) return
		actionBusy = true
		actionError = ''

		try {
			const transport = buildActionTransportPayload()
			await adminApprovalsAPI.deny(selectedRequest.public_request_id, approval.id, {
				method: actionMethod,
				reason_code: actionReasonCode || undefined,
				reason_note: actionReasonNote || undefined,
				...transport
			})
			await refreshSelectedRequest(selectedRequest.public_request_id)
			if (selectedRequest?.has_detail) {
				await reloadDetailTracking(selectedRequest)
			}
			await loadRequests()
			actionReasonNote = ''
			resetActionTransportInputs()
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'Failed to deny step'
		} finally {
			actionBusy = false
		}
	}

	async function remindStep(approval: ApprovalRequestApproval) {
		if (!selectedRequest) return
		actionBusy = true
		actionError = ''

		try {
			const transport = buildActionTransportPayload()
			const updated = await adminApprovalsAPI.remind(selectedRequest.public_request_id, approval.id, {
				method: actionMethod,
				reason_code: actionReasonCode || undefined,
				reason_note: actionReasonNote || undefined,
				...transport
			})
			const failedNotification = updated.notification_results?.find((result) => !result.success)
			if (failedNotification) {
				actionError = failedNotification.error || 'Notification transport failed'
			}
			await refreshSelectedRequest(selectedRequest.public_request_id)
			if (selectedRequest?.has_detail) {
				await reloadDetailTracking(selectedRequest)
			}
			await loadRequests()
			actionReasonNote = ''
			resetActionTransportInputs()
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'Failed to remind approval step'
		} finally {
			actionBusy = false
		}
	}

	async function resendStep(approval: ApprovalRequestApproval) {
		if (!selectedRequest) return
		actionBusy = true
		actionError = ''

		try {
			const transport = buildActionTransportPayload()
			const updated = await adminApprovalsAPI.resend(selectedRequest.public_request_id, approval.id, {
				method: actionMethod,
				reason_code: actionReasonCode || undefined,
				reason_note: actionReasonNote || undefined,
				...transport
			})
			const failedNotification = updated.notification_results?.find((result) => !result.success)
			if (failedNotification) {
				actionError = failedNotification.error || 'Notification transport failed'
			}
			await refreshSelectedRequest(selectedRequest.public_request_id)
			if (selectedRequest?.has_detail) {
				await reloadDetailTracking(selectedRequest)
			}
			await loadRequests()
			actionReasonNote = ''
			resetActionTransportInputs()
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'Failed to resend approval step'
		} finally {
			actionBusy = false
		}
	}

	async function cancelRequest() {
		if (!selectedRequest) return
		actionBusy = true
		actionError = ''

		try {
			await adminApprovalsAPI.cancel(selectedRequest.public_request_id, {
				reason_code: actionReasonCode || undefined,
				reason_note: actionReasonNote || undefined
			})
			await refreshSelectedRequest(selectedRequest.public_request_id)
			if (selectedRequest?.has_detail) {
				await reloadDetailTracking(selectedRequest)
			}
			await loadRequests()
			actionReasonNote = ''
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'Failed to cancel request'
		} finally {
			actionBusy = false
		}
	}

	async function issueCompletionArtifact(
		approval: ApprovalRequestApproval,
		methodOverride?: ApprovalTransportMethod
	) {
		if (!selectedRequest) return
		actionBusy = true
		actionError = ''
		issuingArtifactApprovalId = approval.id

		try {
			issuedCompletionArtifact = await adminApprovalsAPI.issueCompletionArtifact(
				selectedRequest.public_request_id,
				approval.id,
				{
					method: methodOverride ?? actionMethod,
					transport_channel: approval.transport_channel || undefined
				}
			)
			await refreshSelectedRequest(selectedRequest.public_request_id)
			if (selectedRequest?.has_detail) {
				await reloadDetailTracking(selectedRequest)
			}
			await loadRequests()
		} catch (err) {
			actionError = err instanceof Error ? err.message : 'Failed to issue completion artifact'
		} finally {
			actionBusy = false
		}
	}

	function formatDateTime(timestamp?: number | null): string {
		if (!timestamp) return '-'
		return new Date(timestamp).toLocaleString()
	}

	function getStatusBadgeClass(status: ApprovalRequestStatus): string {
		switch (status) {
			case 'approved':
				return 'status-badge status-approved'
			case 'partially_approved':
				return 'status-badge status-partial'
			case 'denied':
				return 'status-badge status-denied'
			case 'expired':
				return 'status-badge status-expired'
			case 'cancelled':
				return 'status-badge status-cancelled'
			default:
				return 'status-badge status-pending'
		}
	}

	function getStepStatusBadgeClass(status: ApprovalRequestApproval['status']): string {
		return getStatusBadgeClass(status as ApprovalRequestStatus)
	}

	function formatSide(side: ApprovalRequestApproval['side']): string {
		switch (side) {
			case 'admin_operator':
				return 'Admin Operator'
			case 'customer_data_owner':
				return 'Customer / Data Owner'
			case 'guardian_delegate':
				return 'Guardian / Delegate'
			default:
				return side
		}
	}

	function formatScopeSummary(request: ApprovalRequestRecord): string {
		const scope = request.scope_json || {}
		const resourceClass =
			typeof scope.resource_class === 'string' ? scope.resource_class : request.request_surface
		return `${request.requested_action} · ${resourceClass}`
	}

	function formatReference(reference?: { system: string; id: string; url?: string | null } | null) {
		if (!reference) return '-'
		return `${reference.system}:${reference.id}`
	}

	function pendingApprovals(request: ApprovalRequestRecord | null): ApprovalRequestApproval[] {
		if (!request) return []
		return request.approvals.filter((approval) => approval.status === 'pending')
	}

	function formatGrantStatusClass(status: ElevationGrantRecord['status']): string {
		switch (status) {
			case 'active':
				return 'status-badge status-approved'
			case 'expired':
				return 'status-badge status-expired'
			case 'revoked':
				return 'status-badge status-cancelled'
			default:
				return 'status-badge status-pending'
		}
	}

	function formatJson(value: unknown): string {
		return JSON.stringify(value ?? {}, null, 2)
	}

	function parseOptionalJson(text: string, field: string): Record<string, unknown> | null {
		const trimmed = text.trim()
		if (!trimmed) return null

		try {
			const parsed = JSON.parse(trimmed)
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>
			}
			throw new Error(`${field} must be a JSON object`)
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`${field}: ${error.message}`)
			}
			throw new Error(`${field}: invalid JSON`)
		}
	}

	function buildActionTransportPayload() {
		const summary =
			actionTransportProvider.trim() ||
			actionTransportStatus.trim() ||
			actionTransportTarget.trim() ||
			actionTransportCorrelationId.trim() ||
			actionTransportRequestId.trim()
				? {
						provider: actionTransportProvider.trim() || undefined,
						delivery_status: actionTransportStatus.trim() || undefined,
						target: actionTransportTarget.trim() || undefined,
						correlation_id: actionTransportCorrelationId.trim() || undefined,
						transport_request_id: actionTransportRequestId.trim() || undefined
					}
				: undefined

		const request = parseOptionalJson(actionTransportRequestJson, 'Transport request')
		const response = parseOptionalJson(actionTransportResponseJson, 'Transport response')
		const metadata = parseOptionalJson(actionTransportMetadataJson, 'Transport metadata')
		const detail = request || response || metadata ? { request, response, metadata } : undefined

		return {
			transport_summary: summary,
			transport_detail: detail
		}
	}

	function openGrantIssue(grant: ElevationGrantRecord) {
		issuingGrantId = grant.public_grant_id
		subjectTokenBusy = false
		subjectTokenError = ''
		subjectTokenExpiresIn = 300
		issuedSubjectToken = null
	}

	function closeGrantIssue() {
		issuingGrantId = null
		subjectTokenBusy = false
		subjectTokenError = ''
		subjectTokenClientId = ''
		subjectTokenExpiresIn = 300
		issuedSubjectToken = null
	}

	async function issueGrantSubjectToken(grant: ElevationGrantRecord) {
		if (!selectedRequest) return
		if (!subjectTokenClientId.trim()) {
			subjectTokenError = 'Service client ID is required'
			return
		}

		subjectTokenBusy = true
		subjectTokenError = ''
		try {
			issuedSubjectToken = await adminApprovalsAPI.issueSubjectToken(
				selectedRequest.public_request_id,
				grant.public_grant_id,
				{
					client_id: subjectTokenClientId.trim(),
					expires_in: subjectTokenExpiresIn || undefined
				}
			)
			if (selectedRequest.has_detail) {
				await reloadDetailTracking(selectedRequest)
			}
		} catch (err) {
			subjectTokenError =
				err instanceof Error ? err.message : 'Failed to issue downstream subject token'
		} finally {
			subjectTokenBusy = false
		}
	}

	async function revokeGrant(grant: ElevationGrantRecord) {
		if (!selectedRequest) return
		revokeGrantBusyId = grant.public_grant_id
		revokeGrantError = ''
		actionError = ''

		try {
			selectedRequest = await adminApprovalsAPI.revokeGrant(
				selectedRequest.public_request_id,
				grant.public_grant_id,
				{
					reason_code: actionReasonCode || 'manual_revoke',
					reason_note: actionReasonNote || undefined
				}
			)
			requests = requests.map((item) =>
				item.public_request_id === selectedRequest?.public_request_id ? selectedRequest! : item
			)
			if (selectedRequest.has_detail) {
				await reloadDetailTracking(selectedRequest)
			}
			if (issuingGrantId === grant.public_grant_id) {
				issuingGrantId = null
				issuedSubjectToken = null
			}
		} catch (err) {
			revokeGrantError = err instanceof Error ? err.message : 'Failed to revoke elevation grant'
		} finally {
			revokeGrantBusyId = null
		}
	}

	function addApprovalStep() {
		createPreview = null
		createPreviewError = ''
		createModel = {
			...createModel,
			approvals: [
				...createModel.approvals,
				{
					step_key: `step-${createModel.approvals.length + 1}`,
					side: 'admin_operator',
					subject_type: 'admin_user',
					subject_id: '',
					method: 'portal_confirm'
				}
			]
		}
	}

	function removeApprovalStep(index: number) {
		createPreview = null
		createPreviewError = ''
		createModel = {
			...createModel,
			approvals: createModel.approvals.filter((_, currentIndex) => currentIndex !== index)
		}
	}

	function updateApprovalStep(index: number, patch: Partial<ApprovalRequestCreateInput['approvals'][number]>) {
		createPreview = null
		createPreviewError = ''
		createModel = {
			...createModel,
			approvals: createModel.approvals.map((step, currentIndex) =>
				currentIndex === index ? { ...step, ...patch } : step
			)
		}
	}

	function validateCreateRequest(): string | null {
		if (!createModel.target_subject_id.trim()) {
			return 'Target subject ID is required'
		}
		if (!createModel.reason_code.trim()) {
			return 'Reason code is required'
		}
		if (createModel.approvals.length === 0) {
			return 'At least one approval step is required'
		}
		return null
	}

	function buildCreatePayload(): ApprovalRequestCreateInput {
		const payload: ApprovalRequestCreateInput = {
			...createModel,
			target_subject_id: createModel.target_subject_id.trim(),
			request_surface: createModel.request_surface.trim(),
			requested_action: createModel.requested_action.trim(),
			resource_class: createModel.resource_class.trim(),
			reason_code: createModel.reason_code.trim(),
			reason_note: createModel.reason_note?.trim() || undefined,
			dataset: createModel.dataset?.trim() || undefined,
			audience: createModel.audience?.trim() || undefined,
			resource_ids: createResourceIds
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean),
			detail_classes: createDetailClasses
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean),
			reference:
				createReferenceSystem.trim() && createReferenceId.trim()
					? {
							system: createReferenceSystem.trim(),
							id: createReferenceId.trim(),
							url: createReferenceUrl.trim() || undefined
						}
					: undefined,
			ticket_reference:
				createTicketSystem.trim() && createTicketId.trim()
					? {
							system: createTicketSystem.trim(),
							id: createTicketId.trim(),
							url: createTicketUrl.trim() || undefined
						}
					: undefined,
			approvals: createModel.approvals.map((step) => ({
				...step,
				step_key: step.step_key.trim(),
				subject_id: step.subject_id?.trim() || undefined,
				relation_type: step.relation_type?.trim() || undefined,
				relation_source: step.relation_source?.trim() || undefined,
				method: step.method || undefined,
				transport_channel: step.transport_channel?.trim() || undefined
			}))
		}

		if (!payload.resource_ids?.length) delete payload.resource_ids
		if (!payload.detail_classes?.length) delete payload.detail_classes

		return payload
	}

	function createPreviewHasResolutionErrors(): boolean {
		return !!createPreview?.steps.some((step) => !!step.transport_resolution_error)
	}

	function applyPreviewResolvedSteps() {
		if (!createPreview) return
		createModel = {
			...createModel,
			approvals: createPreview.steps.map((step) => ({
				step_key: step.step_key,
				side: step.side,
				subject_type: step.subject_type,
				subject_id: step.subject_id ?? undefined,
				relation_type: step.relation_type ?? undefined,
				relation_source: step.relation_source ?? undefined,
				method: step.method ?? undefined,
				transport_channel: step.transport_channel ?? undefined,
				expires_at: step.expires_at
			}))
		}
		createError = ''
	}

	async function previewCreateRequest() {
		createError = ''
		createPreviewError = ''
		const validationError = validateCreateRequest()
		if (validationError) {
			createPreview = null
			createPreviewError = validationError
			return
		}

		createPreviewBusy = true
		try {
			createPreview = await adminApprovalsAPI.preview(buildCreatePayload())
		} catch (err) {
			createPreview = null
			createPreviewError =
				err instanceof Error ? err.message : 'Failed to resolve approval request preview'
		} finally {
			createPreviewBusy = false
		}
	}

	async function createRequest() {
		createError = ''
		const validationError = validateCreateRequest()
		if (validationError) {
			createError = validationError
			return
		}

		createBusy = true
		try {
			const created = await adminApprovalsAPI.create(buildCreatePayload())
			const failedInitialNotification = created.notification_results?.find((result) => !result.success)
			closeCreateModal()
			await loadRequests()
			await openDetail(created)
			if (failedInitialNotification) {
				error =
					failedInitialNotification.error ||
					'Approval request was created, but one or more initial notifications failed.'
			}
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Failed to create approval request'
		} finally {
			createBusy = false
		}
	}
</script>

<svelte:head>
	<title>Approvals - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">Approvals</h1>
			<p class="page-description">
				Review mixed approval requests, inspect scope, and approve or deny pending steps.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={openCreateModal}>New Approval Request</button>
			<button class="btn btn-secondary" onclick={loadRequests} disabled={loading}>
				Refresh
			</button>
		</div>
	</div>

	<div class="panel filters-panel">
		<div class="filter-row">
			<div class="form-group">
				<label class="form-label" for="status-filter">Status</label>
				<select
					id="status-filter"
					class="form-select"
					bind:value={statusFilter}
					onchange={loadRequests}
				>
					<option value="">All statuses</option>
					<option value="pending">Pending</option>
					<option value="partially_approved">Partially Approved</option>
					<option value="approved">Approved</option>
					<option value="denied">Denied</option>
					<option value="expired">Expired</option>
					<option value="cancelled">Cancelled</option>
				</select>
			</div>
			<div class="form-group filter-grow">
				<label class="form-label" for="investigation-filter">Investigation ID</label>
				<input
					id="investigation-filter"
					class="form-input"
					type="text"
					placeholder="Filter by investigation ID..."
					bind:value={investigationIdFilter}
					onchange={loadRequests}
				/>
			</div>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<div class="panel">
		<div class="panel-header">
			<h2 class="panel-title">Requests</h2>
			<span class="panel-meta">{total} total</span>
		</div>

		{#if loading}
			<div class="empty-state">Loading approval requests…</div>
		{:else if requests.length === 0}
			<div class="empty-state">No approval requests matched the current filters.</div>
		{:else}
			<div class="table-wrapper">
				<table class="data-table">
					<thead>
						<tr>
							<th>Status</th>
							<th>Reason</th>
							<th>Scope</th>
							<th>Target</th>
							<th>Created</th>
							<th>Approvals</th>
							<th>Grants</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{#each requests as request (request.public_request_id)}
							<tr>
								<td>
									<span class={getStatusBadgeClass(request.status)}>{request.status}</span>
								</td>
								<td>
									<div class="cell-primary">{request.reason_code}</div>
									<div class="cell-secondary">{request.investigation_id}</div>
								</td>
								<td>{formatScopeSummary(request)}</td>
								<td>
									<div class="cell-primary">{request.target_subject_type}</div>
									<div class="cell-secondary">{request.target_subject_id}</div>
								</td>
								<td>{formatDateTime(request.created_at)}</td>
								<td>{request.approvals.length}</td>
								<td>{request.grants?.length ?? 0}</td>
								<td class="row-actions">
									<button class="btn btn-sm btn-secondary" onclick={() => openDetail(request)}>
										View
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>

<Modal open={showDetailModal} onClose={closeDetail} title="Approval Request Detail" size="lg">
	{#if detailLoading}
		<div class="empty-state">Loading approval request detail…</div>
	{:else if detailError}
		<div class="alert alert-error">{detailError}</div>
	{:else if selectedRequest}
		<div class="detail-grid">
			<div class="detail-card">
				<h3>Request</h3>
				<dl class="detail-list">
					<div><dt>Status</dt><dd><span class={getStatusBadgeClass(selectedRequest.status)}>{selectedRequest.status}</span></dd></div>
					<div><dt>Reason</dt><dd>{selectedRequest.reason_code}</dd></div>
					<div><dt>Requested Action</dt><dd>{selectedRequest.requested_action}</dd></div>
					<div><dt>Redaction</dt><dd>{selectedRequest.redaction_level}</dd></div>
					<div><dt>Reuse Scope</dt><dd>{selectedRequest.reuse_scope}</dd></div>
					<div><dt>Reference</dt><dd>{formatReference(selectedRequest.reference)}</dd></div>
					<div><dt>Ticket</dt><dd>{formatReference(selectedRequest.ticket_reference)}</dd></div>
					<div><dt>Expires</dt><dd>{formatDateTime(selectedRequest.expires_at)}</dd></div>
				</dl>
			</div>

			<div class="detail-card">
				<h3>Resolved Policy</h3>
				<dl class="detail-list">
					<div><dt>Preset</dt><dd>{selectedRequest.resolved_policy?.preset ?? selectedRequest.policy_preset}</dd></div>
					<div><dt>TTL (seconds)</dt><dd>{selectedRequest.resolved_policy?.request_ttl_seconds ?? '-'}</dd></div>
					<div><dt>Remind Cooldown</dt><dd>{selectedRequest.resolved_policy?.notification_cooldown_seconds?.remind ?? '-'}s</dd></div>
					<div><dt>Resend Cooldown</dt><dd>{selectedRequest.resolved_policy?.notification_cooldown_seconds?.resend ?? '-'}s</dd></div>
					<div><dt>Partial Access</dt><dd>{selectedRequest.partial_access_allowed ? 'Allowed' : 'Blocked'}</dd></div>
					<div><dt>Target</dt><dd>{selectedRequest.target_subject_type}:{selectedRequest.target_subject_id}</dd></div>
				</dl>
			</div>
		</div>

		<div class="panel detail-panel">
			<h3 class="panel-title">Approval Steps</h3>
			<div class="steps-list">
				{#each selectedRequest.approvals as approval (approval.id)}
					<div class="step-card">
						<div class="step-header">
							<div>
								<div class="cell-primary">{approval.step_key}</div>
								<div class="cell-secondary">
									{formatSide(approval.side)} · {approval.subject_type}
									{#if approval.subject_id}
										· {approval.subject_id}
									{/if}
								</div>
							</div>
							<span class={getStepStatusBadgeClass(approval.status)}>{approval.status}</span>
						</div>

							<div class="step-meta">
								<div>Expires: {formatDateTime(approval.expires_at)}</div>
								<div>Method: {approval.method ?? '-'}</div>
								<div>Reason: {approval.reason_code ?? '-'}</div>
								<div>Notifications: {approval.notification_count}</div>
								<div>Last Notify: {formatDateTime(approval.last_notified_at)}</div>
								<div>Last Action: {approval.last_notification_action ?? '-'}</div>
							</div>

						{#if approval.status === 'pending'}
							<div class="step-actions">
								<button class="btn btn-sm btn-primary" onclick={() => approveStep(approval)} disabled={actionBusy}>
									Approve
								</button>
								<button class="btn btn-sm btn-danger" onclick={() => denyStep(approval)} disabled={actionBusy}>
									Deny
								</button>
								<button class="btn btn-sm btn-secondary" onclick={() => remindStep(approval)} disabled={actionBusy}>
									Remind
								</button>
								<button class="btn btn-sm btn-secondary" onclick={() => resendStep(approval)} disabled={actionBusy}>
									Resend
								</button>
								<button class="btn btn-sm btn-secondary" onclick={() => issueCompletionArtifact(approval)} disabled={actionBusy}>
									Issue Artifact
								</button>
								<button class="btn btn-sm btn-secondary" onclick={() => loadStepGuide(approval)} disabled={stepGuideLoadingId === approval.id}>
									{stepGuideLoadingId === approval.id ? 'Resolving…' : 'Resolve Guide'}
								</button>
							</div>
							{#if stepGuideError && stepGuideLoadingId === null}
								<div class="alert alert-error">{stepGuideError}</div>
							{/if}
							{#if stepGuides[approval.id]}
								<ApprovalStepGuideCard
									guide={stepGuides[approval.id]!}
									onIssueFallback={(method) => issueCompletionArtifact(approval, method as ApprovalTransportMethod)}
								/>
							{/if}
							{#if issuingArtifactApprovalId === approval.id && issuedCompletionArtifact}
								<div class="grant-issue-panel">
									<ApprovalCompletionGuideCard
										requirements={issuedCompletionArtifact.completion_requirements}
										completionPath={issuedCompletionArtifact.completion_path}
										artifactId={issuedCompletionArtifact.artifact.artifact_id}
									/>
									<div class="detail-grid compact-grid">
										<div><strong>Artifact ID</strong><div class="cell-secondary">{issuedCompletionArtifact.artifact.artifact_id}</div></div>
										<div><strong>Method</strong><div class="cell-secondary">{issuedCompletionArtifact.artifact.method}</div></div>
										<div><strong>Completion Path</strong><div class="cell-secondary">{issuedCompletionArtifact.completion_path}</div></div>
										<div><strong>Expires</strong><div class="cell-secondary">{formatDateTime(issuedCompletionArtifact.artifact.expires_at)}</div></div>
									</div>
								</div>
							{/if}
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<div class="panel detail-panel">
			<h3 class="panel-title">Elevation Grants</h3>
			{#if !selectedRequest.grants?.length}
				<div class="empty-state compact-empty-state">No grants issued for this request.</div>
			{:else}
				<div class="steps-list">
					{#each selectedRequest.grants as grant (grant.public_grant_id)}
						<div class="step-card">
							<div class="step-header">
								<div>
									<div class="cell-primary">{grant.public_grant_id}</div>
									<div class="cell-secondary">
										{grant.resource_class} · {grant.target_audience}
									</div>
								</div>
								<span class={formatGrantStatusClass(grant.status)}>{grant.status}</span>
							</div>
							<div class="step-meta">
								<div>Actor: {grant.actor_subject_type} · {grant.actor_subject_id}</div>
								<div>Redaction: {grant.redaction_level}</div>
								<div>Issued: {formatDateTime(grant.issued_at)}</div>
								<div>Expires: {formatDateTime(grant.expires_at)}</div>
								{#if grant.revoked_at}
									<div>Revoked: {formatDateTime(grant.revoked_at)}</div>
								{/if}
								{#if grant.revoke_reason}
									<div>Revoke Reason: {grant.revoke_reason}</div>
								{/if}
							</div>
							<details class="grant-details">
								<summary>Scope</summary>
								<pre class="json-block">{formatJson(grant.scope_json)}</pre>
							</details>
							<ApprovalGrantGuideCard {grant} />
							<div class="step-actions">
								{#if grant.status === 'active'}
									<button
										class="btn btn-sm btn-secondary"
										onclick={() => openGrantIssue(grant)}
										disabled={subjectTokenBusy && issuingGrantId === grant.public_grant_id}
									>
										Issue Subject Token
									</button>
									<button
										class="btn btn-sm btn-danger"
										onclick={() => revokeGrant(grant)}
										disabled={revokeGrantBusyId === grant.public_grant_id}
									>
										{revokeGrantBusyId === grant.public_grant_id ? 'Revoking…' : 'Revoke'}
									</button>
								{/if}
								{#if issuingGrantId === grant.public_grant_id}
									<button class="btn btn-sm btn-secondary" onclick={closeGrantIssue}>
										Close
									</button>
								{/if}
							</div>
							{#if revokeGrantError && revokeGrantBusyId === null}
								<div class="alert alert-error">{revokeGrantError}</div>
							{/if}
							{#if issuingGrantId === grant.public_grant_id}
								<div class="grant-issue-panel">
									<div class="detail-grid compact-grid">
										<div class="form-group">
											<label class="form-label" for="subject-token-client-id">Service Client ID</label>
											<input
												id="subject-token-client-id"
												class="form-input"
												type="text"
												bind:value={subjectTokenClientId}
												placeholder="svc-client-1"
											/>
										</div>
										<div class="form-group">
											<label class="form-label" for="subject-token-expiry">TTL (seconds)</label>
											<input
												id="subject-token-expiry"
												class="form-input"
												type="number"
												min="60"
												max="1800"
												bind:value={subjectTokenExpiresIn}
											/>
										</div>
									</div>
									<div class="step-actions">
										<button
											class="btn btn-sm btn-primary"
											onclick={() => issueGrantSubjectToken(grant)}
											disabled={subjectTokenBusy}
										>
											{subjectTokenBusy ? 'Issuing…' : 'Issue'}
										</button>
									</div>
									{#if subjectTokenError}
										<div class="alert alert-error">{subjectTokenError}</div>
									{/if}
									{#if issuedSubjectToken}
										<div class="detail-grid compact-grid">
											<div>
												<strong>Expires In</strong>
												<div>{issuedSubjectToken.expires_in}s</div>
											</div>
											<div>
												<strong>Subject Token Type</strong>
												<div>{issuedSubjectToken.subject_token_type}</div>
											</div>
											<div>
												<strong>Grant Type</strong>
												<div>{issuedSubjectToken.token_exchange_hint.grant_type}</div>
											</div>
											<div>
												<strong>Requested Token Type</strong>
												<div>{issuedSubjectToken.token_exchange_hint.requested_token_type}</div>
											</div>
										</div>
										<details class="grant-details" open>
											<summary>Subject Token</summary>
											<textarea class="form-textarea monospace-textarea" rows="8" readonly>{issuedSubjectToken.subject_token}</textarea>
										</details>
										<details class="grant-details">
											<summary>Authorization Details</summary>
											<pre class="json-block">{formatJson(issuedSubjectToken.authorization_details)}</pre>
										</details>
										<ApprovalGrantIntegrationCard token={issuedSubjectToken} />
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<div class="panel detail-panel">
			<h3 class="panel-title">Transport Evidence</h3>
			{#if !selectedRequest.has_detail}
				<div class="empty-state compact-empty-state">
					No externalized transport evidence is stored for this request.
				</div>
			{:else if detailEvidenceLoading}
				<div class="empty-state compact-empty-state">Loading transport evidence…</div>
			{:else if detailEvidenceError}
				<div class="alert alert-error">{detailEvidenceError}</div>
			{:else if detailEvidence}
				<ApprovalEvidenceTimeline
					evidence={detailEvidence}
					{formatDateTime}
					{formatJson}
				/>
			{/if}
		</div>

		<div class="panel detail-panel">
			<h3 class="panel-title">Decision Receipts</h3>
			{#if !selectedRequest.has_detail}
				<div class="empty-state compact-empty-state">
					Decision receipts are not stored without externalized transport evidence.
				</div>
			{:else if detailReceiptsLoading}
				<div class="empty-state compact-empty-state">Loading decision receipts…</div>
			{:else if detailReceiptsError}
				<div class="alert alert-error">{detailReceiptsError}</div>
			{:else}
				<ApprovalDecisionReceiptsPanel receipts={detailReceipts} {formatDateTime} />
			{/if}
		</div>

		<div class="panel detail-panel">
			<h3 class="panel-title">Operator Action</h3>
			<div class="filter-row">
				<div class="form-group">
					<label class="form-label" for="approval-method">Decision Method</label>
					<select id="approval-method" class="form-select" bind:value={actionMethod}>
						<option value="portal_confirm">Portal Confirm</option>
						<option value="reauth">Reauth</option>
						<option value="passkey">Passkey</option>
						<option value="ciba">CIBA</option>
						<option value="email_otp">Email OTP</option>
						<option value="sms_otp">SMS OTP</option>
					</select>
				</div>
				<div class="form-group">
					<label class="form-label" for="approval-reason-code">Reason Code</label>
					<input id="approval-reason-code" class="form-input" bind:value={actionReasonCode} />
				</div>
			</div>
			<div class="form-group">
				<label class="form-label" for="approval-reason-note">Reason Note</label>
				<textarea
					id="approval-reason-note"
					class="form-textarea"
					rows="3"
					bind:value={actionReasonNote}
					placeholder="Optional operator note for approval, denial, or cancellation"
				></textarea>
			</div>
			<details class="grant-details">
				<summary>Transport Summary / Detail (Optional)</summary>
				<div class="filter-row">
					<div class="form-group">
						<label class="form-label" for="approval-transport-provider">Provider</label>
						<input
							id="approval-transport-provider"
							class="form-input"
							bind:value={actionTransportProvider}
							placeholder="portal / email / sms / ciba"
						/>
					</div>
					<div class="form-group">
						<label class="form-label" for="approval-transport-status">Delivery Status</label>
						<input
							id="approval-transport-status"
							class="form-input"
							bind:value={actionTransportStatus}
							placeholder="queued / sent / delivered / failed"
						/>
					</div>
				</div>
				<div class="filter-row">
					<div class="form-group">
						<label class="form-label" for="approval-transport-target">Target</label>
						<input
							id="approval-transport-target"
							class="form-input"
							bind:value={actionTransportTarget}
							placeholder="admin-2 / user@example.com / +81..."
						/>
					</div>
					<div class="form-group">
						<label class="form-label" for="approval-transport-correlation">Correlation ID</label>
						<input
							id="approval-transport-correlation"
							class="form-input"
							bind:value={actionTransportCorrelationId}
							placeholder="corr-123"
						/>
					</div>
					<div class="form-group">
						<label class="form-label" for="approval-transport-request-id">Transport Request ID</label>
						<input
							id="approval-transport-request-id"
							class="form-input"
							bind:value={actionTransportRequestId}
							placeholder="provider request id"
						/>
					</div>
				</div>
				<div class="form-group">
					<label class="form-label" for="approval-transport-request-json">Transport Request JSON</label>
					<textarea
						id="approval-transport-request-json"
						class="form-textarea monospace-textarea"
						rows="4"
						bind:value={actionTransportRequestJson}
						placeholder={TRANSPORT_REQUEST_PLACEHOLDER}
					></textarea>
				</div>
				<div class="form-group">
					<label class="form-label" for="approval-transport-response-json">Transport Response JSON</label>
					<textarea
						id="approval-transport-response-json"
						class="form-textarea monospace-textarea"
						rows="4"
						bind:value={actionTransportResponseJson}
						placeholder={TRANSPORT_RESPONSE_PLACEHOLDER}
					></textarea>
				</div>
				<div class="form-group">
					<label class="form-label" for="approval-transport-metadata-json">Transport Metadata JSON</label>
					<textarea
						id="approval-transport-metadata-json"
						class="form-textarea monospace-textarea"
						rows="4"
						bind:value={actionTransportMetadataJson}
						placeholder={TRANSPORT_METADATA_PLACEHOLDER}
					></textarea>
				</div>
			</details>
			{#if actionError}
				<div class="alert alert-error">{actionError}</div>
			{/if}
			<div class="detail-actions">
				<button
					class="btn btn-danger"
					onclick={cancelRequest}
					disabled={actionBusy || !['pending', 'partially_approved'].includes(selectedRequest.status)}
				>
					Cancel Request
				</button>
				<div class="panel-meta">
					{pendingApprovals(selectedRequest).length} pending step(s)
				</div>
			</div>
		</div>

		<div class="panel detail-panel">
			<h3 class="panel-title">Scope JSON</h3>
			<pre class="json-block">{formatJson(selectedRequest.scope_json)}</pre>
		</div>
	{/if}
</Modal>

<Modal open={showCreateModal} onClose={closeCreateModal} title="Create Approval Request" size="lg">
	<div class="filter-row">
		<div class="form-group">
			<label class="form-label" for="create-target-type">Target Type</label>
			<select id="create-target-type" class="form-select" bind:value={createModel.target_subject_type}>
				<option value="user">User</option>
				<option value="artifact">Artifact</option>
				<option value="service_resource">Service Resource</option>
				<option value="tenant_resource">Tenant Resource</option>
			</select>
		</div>
		<div class="form-group">
			<label class="form-label" for="create-target-id">Target ID</label>
			<input id="create-target-id" class="form-input" bind:value={createModel.target_subject_id} />
		</div>
		<div class="form-group">
			<label class="form-label" for="create-policy-preset">Policy Preset</label>
			<select id="create-policy-preset" class="form-select" bind:value={createModel.policy_preset}>
				<option value="support_case_default">Support Case</option>
				<option value="technical_debug_default">Technical Debug</option>
				<option value="security_investigation_default">Security Investigation</option>
				<option value="guardian_support_default">Guardian Support</option>
				<option value="compliance_review_default">Compliance Review</option>
			</select>
		</div>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label class="form-label" for="create-surface">Request Surface</label>
			<input id="create-surface" class="form-input" bind:value={createModel.request_surface} />
		</div>
		<div class="form-group">
			<label class="form-label" for="create-action">Requested Action</label>
			<input id="create-action" class="form-input" bind:value={createModel.requested_action} />
		</div>
		<div class="form-group">
			<label class="form-label" for="create-resource-class">Resource Class</label>
			<input id="create-resource-class" class="form-input" bind:value={createModel.resource_class} />
		</div>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label class="form-label" for="create-resource-ids">Resource IDs</label>
			<input
				id="create-resource-ids"
				class="form-input"
				bind:value={createResourceIds}
				placeholder="Comma separated"
			/>
		</div>
		<div class="form-group">
			<label class="form-label" for="create-detail-classes">Detail Classes</label>
			<input
				id="create-detail-classes"
				class="form-input"
				bind:value={createDetailClasses}
				placeholder="Comma separated"
			/>
		</div>
		<div class="form-group">
			<label class="form-label" for="create-redaction-level">Redaction Level</label>
			<select id="create-redaction-level" class="form-select" bind:value={createModel.redaction_level}>
				<option value="summary_only">Summary Only</option>
				<option value="masked">Masked</option>
				<option value="raw">Raw</option>
			</select>
		</div>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label class="form-label" for="create-reason-code">Reason Code</label>
			<input id="create-reason-code" class="form-input" bind:value={createModel.reason_code} />
		</div>
		<div class="form-group">
			<label class="form-label" for="create-dataset">Dataset</label>
			<input id="create-dataset" class="form-input" bind:value={createModel.dataset} />
		</div>
		<div class="form-group">
			<label class="form-label" for="create-audience">Audience</label>
			<input id="create-audience" class="form-input" bind:value={createModel.audience} />
		</div>
	</div>

	<div class="form-group">
		<label class="form-label" for="create-reason-note">Reason Note</label>
		<textarea id="create-reason-note" class="form-textarea" rows="3" bind:value={createModel.reason_note}></textarea>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label class="form-label" for="create-reference-system">Reference System</label>
			<input id="create-reference-system" class="form-input" bind:value={createReferenceSystem} />
		</div>
		<div class="form-group">
			<label class="form-label" for="create-reference-id">Reference ID</label>
			<input id="create-reference-id" class="form-input" bind:value={createReferenceId} />
		</div>
		<div class="form-group">
			<label class="form-label" for="create-reference-url">Reference URL</label>
			<input id="create-reference-url" class="form-input" bind:value={createReferenceUrl} />
		</div>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label class="form-label" for="create-ticket-system">Ticket System</label>
			<input id="create-ticket-system" class="form-input" bind:value={createTicketSystem} />
		</div>
		<div class="form-group">
			<label class="form-label" for="create-ticket-id">Ticket ID</label>
			<input id="create-ticket-id" class="form-input" bind:value={createTicketId} />
		</div>
		<div class="form-group">
			<label class="form-label" for="create-ticket-url">Ticket URL</label>
			<input id="create-ticket-url" class="form-input" bind:value={createTicketUrl} />
		</div>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label class="form-label" for="create-reuse-scope">Reuse Scope</label>
			<select id="create-reuse-scope" class="form-select" bind:value={createModel.reuse_scope}>
				<option value="request">Request</option>
				<option value="case">Case</option>
			</select>
		</div>
		<div class="form-group checkbox-group">
			<label class="checkbox-label">
				<input type="checkbox" bind:checked={createModel.partial_access_allowed} />
				<span>Allow partial access</span>
			</label>
		</div>
	</div>

	<div class="panel detail-panel">
		<div class="panel-header">
			<h3 class="panel-title">Approval Steps</h3>
			<button class="btn btn-sm btn-secondary" onclick={addApprovalStep}>Add Step</button>
		</div>
		<div class="steps-list">
			{#each createModel.approvals as step, index (`${step.step_key}-${index}`)}
				<div class="step-card">
					<div class="filter-row">
						<div class="form-group">
							<label class="form-label" for={`step-key-${index}`}>Step Key</label>
							<input
								id={`step-key-${index}`}
								class="form-input"
								value={step.step_key}
								oninput={(event) =>
									updateApprovalStep(index, {
										step_key: (event.currentTarget as HTMLInputElement).value
									})}
							/>
						</div>
						<div class="form-group">
							<label class="form-label" for={`step-side-${index}`}>Side</label>
							<select
								id={`step-side-${index}`}
								class="form-select"
								value={step.side}
								onchange={(event) =>
									updateApprovalStep(index, {
										side: (event.currentTarget as HTMLSelectElement).value as typeof step.side
									})}
							>
								<option value="admin_operator">Admin Operator</option>
								<option value="customer_data_owner">Customer / Data Owner</option>
								<option value="guardian_delegate">Guardian / Delegate</option>
							</select>
						</div>
						<div class="form-group">
							<label class="form-label" for={`step-subject-type-${index}`}>Subject Type</label>
							<select
								id={`step-subject-type-${index}`}
								class="form-select"
								value={step.subject_type}
								onchange={(event) =>
									updateApprovalStep(index, {
										subject_type: (event.currentTarget as HTMLSelectElement).value as typeof step.subject_type
									})}
							>
								<option value="admin_user">Admin User</option>
								<option value="end_user">End User</option>
								<option value="customer_delegate">Customer Delegate</option>
								<option value="service_principal">Service Principal</option>
							</select>
						</div>
					</div>
					<div class="filter-row">
						<div class="form-group">
							<label class="form-label" for={`step-subject-id-${index}`}>Subject ID</label>
							<input
								id={`step-subject-id-${index}`}
								class="form-input"
								value={step.subject_id ?? ''}
								oninput={(event) =>
									updateApprovalStep(index, {
										subject_id: (event.currentTarget as HTMLInputElement).value
									})}
							/>
						</div>
						<div class="form-group">
							<label class="form-label" for={`step-relation-type-${index}`}>Relation Type</label>
							<input
								id={`step-relation-type-${index}`}
								class="form-input"
								value={step.relation_type ?? ''}
								oninput={(event) =>
									updateApprovalStep(index, {
										relation_type: (event.currentTarget as HTMLInputElement).value
									})}
							/>
						</div>
						<div class="form-group">
							<label class="form-label" for={`step-relation-source-${index}`}>Relation Source</label>
							<input
								id={`step-relation-source-${index}`}
								class="form-input"
								value={step.relation_source ?? ''}
								oninput={(event) =>
									updateApprovalStep(index, {
										relation_source: (event.currentTarget as HTMLInputElement).value
									})}
							/>
						</div>
					</div>
					<div class="filter-row">
						<div class="form-group">
							<label class="form-label" for={`step-method-${index}`}>Initial Method</label>
							<select
								id={`step-method-${index}`}
								class="form-select"
								value={step.method ?? ''}
								onchange={(event) =>
									updateApprovalStep(index, {
										method:
											((event.currentTarget as HTMLSelectElement).value || undefined) as typeof step.method
									})}
							>
								<option value="">No initial notification</option>
								<option value="portal_confirm">Portal Confirm</option>
								<option value="email_otp">Email OTP</option>
								<option value="sms_otp">SMS OTP</option>
								<option value="ciba">CIBA</option>
								<option value="passkey">Passkey</option>
								<option value="reauth">Reauth</option>
							</select>
						</div>
						<div class="form-group">
							<label class="form-label" for={`step-transport-channel-${index}`}>Transport Channel</label>
							<input
								id={`step-transport-channel-${index}`}
								class="form-input"
								value={step.transport_channel ?? ''}
								oninput={(event) =>
									updateApprovalStep(index, {
										transport_channel: (event.currentTarget as HTMLInputElement).value
									})}
								placeholder="Email, phone, or portal target"
							/>
						</div>
					</div>
					<div class="step-actions">
						<button
							class="btn btn-sm btn-danger"
							onclick={() => removeApprovalStep(index)}
							disabled={createModel.approvals.length === 1}
						>
							Remove
						</button>
					</div>
				</div>
			{/each}
		</div>
	</div>

	<ApprovalRequestPreviewPanel
		preview={createPreview}
		loading={createPreviewBusy}
		error={createPreviewError}
		canApplyResolvedSteps={!!createPreview && !createPreviewHasResolutionErrors()}
		onApplyResolvedSteps={applyPreviewResolvedSteps}
	/>

	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}
	{#if createPreview && createPreviewHasResolutionErrors()}
		<div class="alert alert-warning">
			Preview found unresolved transport details. Fix the affected steps or adjust the target before
			creating the request.
		</div>
	{/if}

	<div class="detail-actions">
		<button class="btn btn-secondary" onclick={closeCreateModal} disabled={createBusy}>Cancel</button>
		<button
			class="btn btn-secondary"
			onclick={previewCreateRequest}
			disabled={createBusy || createPreviewBusy}
		>
			{createPreviewBusy ? 'Resolving…' : 'Preview Resolution'}
		</button>
		<button class="btn btn-primary" onclick={createRequest} disabled={createBusy}>
			{createBusy ? 'Creating…' : 'Create Request'}
		</button>
	</div>
</Modal>

<style>
	.detail-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.detail-card,
	.detail-panel {
		margin-bottom: 1rem;
	}

	.compact-grid {
		margin-bottom: 0.75rem;
	}

	.detail-list {
		display: grid;
		gap: 0.75rem;
	}

	.detail-list div {
		display: grid;
		gap: 0.15rem;
	}

	.detail-list dt {
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-secondary);
	}

	.detail-list dd {
		margin: 0;
		color: var(--color-text-primary);
	}

	.filter-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 1rem;
	}

	.filter-grow {
		min-width: 0;
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1rem;
	}

	.panel-meta,
	.cell-secondary {
		color: var(--color-text-secondary);
		font-size: 0.875rem;
	}

	.cell-primary {
		font-weight: 600;
	}

	.table-wrapper {
		overflow-x: auto;
	}

	.data-table {
		width: 100%;
		border-collapse: collapse;
	}

	.data-table th,
	.data-table td {
		padding: 0.75rem;
		border-bottom: 1px solid var(--color-border-subtle);
		text-align: left;
		vertical-align: top;
	}

	.row-actions {
		white-space: nowrap;
	}

	.status-badge {
		display: inline-flex;
		align-items: center;
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		font-size: 0.8rem;
		font-weight: 700;
		text-transform: capitalize;
	}

	.status-pending {
		background: rgba(234, 179, 8, 0.14);
		color: #a16207;
	}

	.status-partial {
		background: rgba(59, 130, 246, 0.14);
		color: #1d4ed8;
	}

	.status-approved {
		background: rgba(34, 197, 94, 0.14);
		color: #15803d;
	}

	.status-denied,
	.status-cancelled {
		background: rgba(239, 68, 68, 0.14);
		color: #b91c1c;
	}

	.status-expired {
		background: rgba(107, 114, 128, 0.16);
		color: #4b5563;
	}

	.steps-list {
		display: grid;
		gap: 0.75rem;
	}

	.step-card {
		padding: 1rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: 0.75rem;
		background: var(--color-surface-subtle);
	}

	.step-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		margin-bottom: 0.5rem;
	}

	.step-meta {
		display: grid;
		gap: 0.25rem;
		font-size: 0.875rem;
		color: var(--color-text-secondary);
	}

	.step-note {
		margin-top: 0.75rem;
		padding: 0.75rem;
		border-radius: 0.75rem;
		background: color-mix(in srgb, var(--color-surface-subtle) 82%, transparent);
		font-size: 0.9rem;
		color: var(--color-text-primary);
		white-space: pre-wrap;
	}

	.step-actions,
	.detail-actions,
	.page-actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		flex-wrap: wrap;
		margin-top: 0.75rem;
	}

	.empty-state {
		padding: 2rem;
		text-align: center;
		color: var(--color-text-secondary);
	}

	.compact-empty-state {
		padding: 1rem;
	}

	.json-block {
		margin: 0;
		padding: 1rem;
		border-radius: 0.75rem;
		background: var(--color-surface-subtle);
		overflow-x: auto;
		font-size: 0.85rem;
	}

	.grant-details summary {
		cursor: pointer;
		font-weight: 600;
		color: var(--color-text-primary);
	}

	.grant-issue-panel {
		margin-top: 0.75rem;
		padding: 1rem;
		border-radius: 0.75rem;
		border: 1px solid var(--color-border-subtle);
		background: color-mix(in srgb, var(--color-surface-subtle) 88%, transparent);
	}

	.monospace-textarea {
		width: 100%;
		font-family:
			'SFMono-Regular',
			'SF Mono',
			Consolas,
			'Liberation Mono',
			Menlo,
			monospace;
	}

	.checkbox-group {
		display: flex;
		align-items: end;
	}

	.checkbox-label {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 600;
	}
</style>
