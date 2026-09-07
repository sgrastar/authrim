<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminControlPlaneAPI,
		type ControlProvisioningAuthorityStatus,
		type ControlProvisioningOperation,
		type ControlProvisioningOperationStep,
		type ReleaseRolloutStatus,
		type ShardCleanupCandidate,
		type TenantDisasterRecovery,
		type WorkerInventoryDriftFinding,
		type WorkerInventoryDriftReviewState
	} from '$lib/api/admin-control-plane';
	import { toDateTimeLocalValue } from '$lib/datetime-local';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let findings = $state<WorkerInventoryDriftFinding[]>([]);
	let provisioningAuthority = $state<ControlProvisioningAuthorityStatus | null>(null);
	let loading = $state(true);
	let error = $state('');
	let reviewingId = $state('');
	let operationId = $state('');
	let operation = $state<ControlProvisioningOperation | null>(null);
	let inspecting = $state(false);
	let operationError = $state('');
	let retryError = $state('');
	let retryingStep = $state('');
	let canceling = $state(false);
	let cancelConfirming = $state(false);
	let restoring = $state(false);
	let restoreConfirming = $state(false);
	let cleanupCandidates = $state<ShardCleanupCandidate[]>([]);
	let cleanupError = $state('');
	let cleanupActingId = $state('');
	let approvalCandidate = $state<ShardCleanupCandidate | null>(null);
	let cleanupConfirmation = $state('');
	let cleanupExportMode = $state<'skipped' | 'manual_verified'>('skipped');
	let cleanupExportEvidenceId = $state('');
	let cleanupDeleteDatabase = $state(true);
	let recoveryTenantId = $state('');
	let recoveryStartConfirmation = $state('');
	let recoveryOperationId = $state('');
	let recovery = $state<TenantDisasterRecovery | null>(null);
	let recoveryError = $state('');
	let recoveryActing = $state(false);
	let restoreReference = $state('');
	let restoreCompletedAt = $state('');
	let recoveryReactivateConfirmation = $state('');
	let releaseRollout = $state<ReleaseRolloutStatus | null>(null);
	let releaseRetryTargetId = $state('');
	let releaseRetryError = $state('');

	async function load() {
		loading = true;
		error = '';
		cleanupError = '';
		try {
			const [authorityResponse, driftResponse, cleanupResponse, releaseResponse] =
				await Promise.all([
					adminControlPlaneAPI.getProvisioningAuthorityStatus(),
					adminControlPlaneAPI.listDriftFindings(),
					adminControlPlaneAPI.listShardCleanupCandidates(),
					adminControlPlaneAPI.getReleaseRolloutStatus()
				]);
			provisioningAuthority = authorityResponse.authority;
			findings = driftResponse.items;
			cleanupCandidates = cleanupResponse.items;
			releaseRollout = releaseResponse.rollout;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_control_plane_load_failed();
			provisioningAuthority = null;
			findings = [];
			cleanupCandidates = [];
			releaseRollout = null;
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
		const searchParams = new URL(window.location.href).searchParams;
		const requestedOperationId = searchParams.get('operation');
		if (requestedOperationId) {
			operationId = requestedOperationId;
			void inspectOperation();
		}
		const requestedRecoveryId = searchParams.get('recovery');
		if (requestedRecoveryId) {
			recoveryOperationId = requestedRecoveryId;
			void inspectRecovery();
		}
		const timer = window.setInterval(() => {
			if (
				cleanupCandidates.some(
					(candidate) =>
						candidate.quarantineOperationState === 'draining' ||
						(candidate.cleanupState !== null &&
							!['succeeded', 'blocked'].includes(candidate.cleanupState))
				)
			) {
				void load();
			}
			if (
				recovery &&
				![
					'operator_restore_required',
					'ready_for_reactivation',
					'succeeded',
					'blocked',
					'canceled'
				].includes(recovery.state)
			) {
				void inspectRecovery(true);
			}
			if (releaseRollout && !['idle', 'completed'].includes(releaseRollout.phase)) {
				void refreshReleaseRollout();
			}
		}, 5000);
		return () => window.clearInterval(timer);
	});

	function formatDate(value: number): string {
		const date = new Date(value * 1000);
		return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
	}

	function idempotencyKey(prefix: string): string {
		const suffix =
			crypto.randomUUID?.() ??
			Array.from(crypto.getRandomValues(new Uint8Array(16)))
				.map((byte) => byte.toString(16).padStart(2, '0'))
				.join('');
		return `${prefix}:${suffix}`;
	}

	async function refreshReleaseRollout() {
		try {
			releaseRollout = (await adminControlPlaneAPI.getReleaseRolloutStatus()).rollout;
		} catch {
			// The persistent global banner reports Control unavailability fail-closed.
		}
	}

	async function retryReleaseTarget(targetId: string) {
		if (!releaseRollout?.operationId || releaseRetryTargetId) return;
		releaseRetryTargetId = targetId;
		releaseRetryError = '';
		try {
			releaseRollout = (
				await adminControlPlaneAPI.retryReleaseRolloutTarget(releaseRollout.operationId, targetId)
			).rollout;
		} catch (caught) {
			releaseRetryError = caught instanceof Error ? caught.message : 'Release target retry failed';
		} finally {
			releaseRetryTargetId = '';
		}
	}

	async function startRecovery() {
		const tenantId = recoveryTenantId.trim();
		if (recoveryActing || recoveryStartConfirmation !== `START_TENANT_RECOVERY:${tenantId}`) return;
		recoveryActing = true;
		recoveryError = '';
		try {
			const response = await adminControlPlaneAPI.startTenantDisasterRecovery(
				tenantId,
				idempotencyKey('tenant-dr-start')
			);
			recovery = response.recovery;
			recoveryOperationId = response.recovery.operationId;
			recoveryStartConfirmation = '';
		} catch (caught) {
			recoveryError =
				caught instanceof Error ? caught.message : $LL.admin_control_plane_recovery_action_failed();
		} finally {
			recoveryActing = false;
		}
	}

	async function inspectRecovery(background = false) {
		const candidate = recoveryOperationId.trim();
		if (!candidate || (recoveryActing && !background)) return;
		if (!background) recoveryActing = true;
		recoveryError = '';
		try {
			const response = await adminControlPlaneAPI.getTenantDisasterRecovery(candidate);
			recovery = response.recovery;
			recoveryTenantId = response.recovery.tenantId;
			if (!restoreCompletedAt) {
				restoreCompletedAt = toDateTimeLocalValue(new Date());
			}
		} catch (caught) {
			if (!background) {
				recoveryError =
					caught instanceof Error ? caught.message : $LL.admin_control_plane_recovery_load_failed();
			}
		} finally {
			if (!background) recoveryActing = false;
		}
	}

	async function confirmRecoveryRestore() {
		if (!recovery?.canConfirmRestore || recoveryActing || !restoreReference.trim()) return;
		const restoredAt = Math.floor(new Date(restoreCompletedAt).getTime() / 1000);
		if (!Number.isSafeInteger(restoredAt) || restoredAt <= 0) return;
		recoveryActing = true;
		recoveryError = '';
		try {
			const response = await adminControlPlaneAPI.confirmTenantDisasterRecoveryRestore(
				recovery.operationId,
				{ restoreReference: restoreReference.trim(), restoredAt, tenantId: recovery.tenantId },
				idempotencyKey('tenant-dr-restore')
			);
			recovery = response.recovery;
			restoreReference = '';
		} catch (caught) {
			recoveryError =
				caught instanceof Error ? caught.message : $LL.admin_control_plane_recovery_action_failed();
		} finally {
			recoveryActing = false;
		}
	}

	async function verifyRecoveryMigration() {
		if (!recovery?.canVerify || recoveryActing) return;
		recoveryActing = true;
		recoveryError = '';
		try {
			recovery = (
				await adminControlPlaneAPI.verifyTenantDisasterRecoveryMigration(recovery.operationId)
			).recovery;
		} catch (caught) {
			recoveryError =
				caught instanceof Error ? caught.message : $LL.admin_control_plane_recovery_action_failed();
		} finally {
			recoveryActing = false;
		}
	}

	async function reactivateRecovery() {
		if (
			!recovery?.canReactivate ||
			recoveryActing ||
			recoveryReactivateConfirmation !== `REACTIVATE_RECOVERED_TENANT:${recovery.tenantId}`
		) {
			return;
		}
		recoveryActing = true;
		recoveryError = '';
		try {
			recovery = (
				await adminControlPlaneAPI.reactivateTenantDisasterRecovery(
					recovery.operationId,
					recovery.tenantId,
					idempotencyKey('tenant-dr-reactivate')
				)
			).recovery;
			recoveryReactivateConfirmation = '';
		} catch (caught) {
			recoveryError =
				caught instanceof Error ? caught.message : $LL.admin_control_plane_recovery_action_failed();
		} finally {
			recoveryActing = false;
		}
	}

	function reviewLabel(state: WorkerInventoryDriftReviewState): string {
		switch (state) {
			case 'reviewed':
				return $LL.admin_control_plane_reviewed();
			case 'dismissed':
				return $LL.admin_control_plane_dismissed();
			default:
				return $LL.admin_control_plane_unreviewed();
		}
	}

	function notificationLabel(state: WorkerInventoryDriftFinding['notificationState']): string {
		return state === 'acknowledged'
			? $LL.admin_control_plane_acknowledged()
			: $LL.admin_control_plane_pending();
	}

	function operationStatusLabel(status: ControlProvisioningOperationStep['status']): string {
		switch (status) {
			case 'queued':
				return $LL.admin_control_plane_status_queued();
			case 'running':
				return $LL.admin_control_plane_status_running();
			case 'waiting_retry':
				return $LL.admin_control_plane_status_waiting_retry();
			case 'succeeded':
				return $LL.admin_control_plane_status_succeeded();
			case 'blocked':
				return $LL.admin_control_plane_status_blocked();
			case 'canceled':
				return $LL.admin_control_plane_status_canceled();
			case 'skipped':
				return $LL.admin_control_plane_status_skipped();
			case 'rolled_back':
				return $LL.admin_control_plane_status_rolled_back();
		}
	}

	function tokenOwnershipLabel(
		ownership: ControlProvisioningAuthorityStatus['tokenOwnership']
	): string {
		switch (ownership) {
			case 'account':
				return $LL.admin_control_plane_token_account();
			case 'user':
				return $LL.admin_control_plane_token_user();
			default:
				return $LL.admin_control_plane_token_none();
		}
	}

	function capabilityStateLabel(
		state: ControlProvisioningAuthorityStatus['capabilityState']
	): string {
		switch (state) {
			case 'ready':
				return $LL.admin_control_plane_capability_ready();
			case 'pending':
				return $LL.admin_control_plane_capability_pending();
			case 'blocked':
				return $LL.admin_control_plane_capability_blocked();
			default:
				return $LL.admin_control_plane_capability_disabled();
		}
	}

	function replaceCleanupCandidate(candidate: ShardCleanupCandidate) {
		cleanupCandidates = cleanupCandidates.map((item) =>
			item.shardId === candidate.shardId ? candidate : item
		);
		if (approvalCandidate?.shardId === candidate.shardId) approvalCandidate = candidate;
	}

	function bindingProgress(candidate: ShardCleanupCandidate): string {
		const removed = candidate.bindings.filter((binding) => binding.state === 'removed').length;
		return candidate.bindings.length === 0 ? '-' : `${removed}/${candidate.bindings.length}`;
	}

	async function quarantineShard(candidate: ShardCleanupCandidate) {
		if (cleanupActingId) return;
		cleanupActingId = candidate.shardId;
		cleanupError = '';
		try {
			const response = await adminControlPlaneAPI.quarantineShard(candidate.shardId);
			replaceCleanupCandidate(response.candidate);
		} catch (caught) {
			cleanupError =
				caught instanceof Error ? caught.message : $LL.admin_control_plane_cleanup_action_failed();
		} finally {
			cleanupActingId = '';
		}
	}

	async function retryShardQuarantine(candidate: ShardCleanupCandidate) {
		if (cleanupActingId || !candidate.quarantineOperationId) return;
		cleanupActingId = candidate.shardId;
		cleanupError = '';
		try {
			const response = await adminControlPlaneAPI.retryShardQuarantine(
				candidate.shardId,
				candidate.quarantineOperationId
			);
			replaceCleanupCandidate(response.candidate);
		} catch (caught) {
			cleanupError =
				caught instanceof Error ? caught.message : $LL.admin_control_plane_cleanup_action_failed();
		} finally {
			cleanupActingId = '';
		}
	}

	function openCleanupApproval(candidate: ShardCleanupCandidate) {
		approvalCandidate = candidate;
		cleanupConfirmation = '';
		cleanupExportMode = 'skipped';
		cleanupExportEvidenceId = '';
		cleanupDeleteDatabase = true;
		cleanupError = '';
	}

	function closeCleanupApproval() {
		approvalCandidate = null;
		cleanupConfirmation = '';
		cleanupExportEvidenceId = '';
	}

	async function approveShardCleanup() {
		const candidate = approvalCandidate;
		if (
			!candidate ||
			cleanupActingId ||
			!candidate.quarantineOperationId ||
			cleanupConfirmation !== 'DELETE_RETIRED_TENANT_SHARD' ||
			(cleanupExportMode === 'manual_verified' && !cleanupExportEvidenceId.trim())
		) {
			return;
		}
		cleanupActingId = candidate.shardId;
		cleanupError = '';
		try {
			const response = await adminControlPlaneAPI.approveShardCleanup(candidate.shardId, {
				quarantineOperationId: candidate.quarantineOperationId,
				confirmation: 'DELETE_RETIRED_TENANT_SHARD',
				exportMode: cleanupExportMode,
				exportEvidenceId:
					cleanupExportMode === 'manual_verified' ? cleanupExportEvidenceId.trim() : null,
				deleteDatabase: cleanupDeleteDatabase
			});
			replaceCleanupCandidate(response.candidate);
			closeCleanupApproval();
		} catch (caught) {
			cleanupError =
				caught instanceof Error ? caught.message : $LL.admin_control_plane_cleanup_action_failed();
		} finally {
			cleanupActingId = '';
		}
	}

	async function retryShardCleanup(candidate: ShardCleanupCandidate) {
		if (cleanupActingId || !candidate.cleanupOperationId) return;
		cleanupActingId = candidate.shardId;
		cleanupError = '';
		try {
			const response = await adminControlPlaneAPI.retryShardCleanup(
				candidate.shardId,
				candidate.cleanupOperationId
			);
			replaceCleanupCandidate(response.candidate);
		} catch (caught) {
			cleanupError =
				caught instanceof Error ? caught.message : $LL.admin_control_plane_cleanup_action_failed();
		} finally {
			cleanupActingId = '';
		}
	}

	async function inspectOperation() {
		const id = operationId.trim();
		if (!id || inspecting) return;
		inspecting = true;
		operationError = '';
		retryError = '';
		cancelConfirming = false;
		restoreConfirming = false;
		operation = null;
		try {
			const response = await adminControlPlaneAPI.getProvisioningOperation(id);
			operation = response.operation;
		} catch (caught) {
			operationError =
				caught instanceof Error ? caught.message : $LL.admin_control_plane_operation_load_failed();
		} finally {
			inspecting = false;
		}
	}

	function isRetryableStep(
		step: ControlProvisioningOperationStep
	): step is ControlProvisioningOperationStep & {
		stepKey: 'create_d1' | 'apply_migrations' | 'reconcile_worker_bindings';
	} {
		const action =
			step.stepKey === 'create_d1'
				? 'retry_create_d1'
				: step.stepKey === 'apply_migrations'
					? 'retry_apply_migrations'
					: 'retry_reconcile_worker_bindings';
		return (
			operation?.status === 'blocked' &&
			step.status === 'blocked' &&
			(step.stepKey === 'create_d1' ||
				step.stepKey === 'apply_migrations' ||
				step.stepKey === 'reconcile_worker_bindings') &&
			operation.availableActions.includes(action)
		);
	}

	async function retryStep(
		step: ControlProvisioningOperationStep & {
			stepKey: 'create_d1' | 'apply_migrations' | 'reconcile_worker_bindings';
		}
	) {
		if (!operation || retryingStep || canceling || restoring) return;
		retryingStep = step.stepKey;
		retryError = '';
		try {
			const response = await adminControlPlaneAPI.retryProvisioningOperationStep(
				operation.operationId,
				step.stepKey
			);
			operation = response.operation;
		} catch (caught) {
			retryError =
				caught instanceof Error ? caught.message : $LL.admin_control_plane_retry_failed();
		} finally {
			retryingStep = '';
		}
	}

	async function cancelOperation() {
		if (
			!operation ||
			canceling ||
			!cancelConfirming ||
			!operation.availableActions.includes('cancel')
		) {
			return;
		}
		canceling = true;
		retryError = '';
		try {
			const response = await adminControlPlaneAPI.cancelProvisioningOperation(
				operation.operationId
			);
			operation = response.operation;
		} catch (caught) {
			retryError =
				caught instanceof Error ? caught.message : $LL.admin_control_plane_cancel_failed();
		} finally {
			canceling = false;
			cancelConfirming = false;
		}
	}

	async function restorePreviousSettings() {
		if (
			!operation ||
			restoring ||
			!restoreConfirming ||
			!operation.availableActions.includes('restore_previous_settings')
		) {
			return;
		}
		restoring = true;
		retryError = '';
		try {
			const response = await adminControlPlaneAPI.restoreProvisioningOperationPreviousSettings(
				operation.operationId
			);
			operation = response.operation;
		} catch (caught) {
			retryError =
				caught instanceof Error ? caught.message : $LL.admin_control_plane_restore_failed();
		} finally {
			restoring = false;
			restoreConfirming = false;
		}
	}

	async function setDisposition(
		finding: WorkerInventoryDriftFinding,
		disposition: 'reviewed' | 'dismissed'
	) {
		reviewingId = finding.findingId;
		error = '';
		try {
			const response = await adminControlPlaneAPI.reviewDriftFinding(
				finding.findingId,
				disposition
			);
			findings = findings.map((item) =>
				item.findingId === response.finding.findingId ? response.finding : item
			);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_control_plane_review_failed();
		} finally {
			reviewingId = '';
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_control_plane_page_title()}</title>
</svelte:head>

{#snippet pageActions()}
	<button
		class="btn btn-secondary"
		onclick={load}
		disabled={loading}
		title={$LL.admin_control_plane_refresh()}
	>
		<i class="i-ph-arrow-clockwise" aria-hidden="true"></i>
		<span>{$LL.admin_control_plane_refresh()}</span>
	</button>
{/snippet}

{#snippet sectionActions()}
	<span class="badge badge-neutral">{findings.length}</span>
{/snippet}

{#snippet cleanupSectionActions()}
	<span class="badge badge-neutral">{cleanupCandidates.length}</span>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_control_plane_title()}
		description={$LL.admin_control_plane_description()}
		actions={pageActions}
	/>

	{#if error}
		<div class="alert alert-error" role="alert">{error}</div>
	{/if}

	<AdminSection title={$LL.admin_control_plane_authority_title()}>
		{#if loading}
			<p class="text-muted">{$LL.admin_control_plane_loading()}</p>
		{:else if provisioningAuthority}
			<dl class="authority-summary">
				<div>
					<dt>{$LL.admin_control_plane_automatic_provisioning()}</dt>
					<dd>
						<span
							class:badge-ready={provisioningAuthority.automaticExecutionAvailable}
							class="badge badge-neutral"
						>
							{provisioningAuthority.automaticProvisioningEnabled
								? $LL.admin_control_plane_automatic_on()
								: $LL.admin_control_plane_automatic_off()}
						</span>
					</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_active_executor()}</dt>
					<dd>
						{provisioningAuthority.activeExecutor === 'control'
							? $LL.admin_control_plane_executor_control()
							: $LL.admin_control_plane_executor_setup()}
					</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_token_ownership()}</dt>
					<dd>{tokenOwnershipLabel(provisioningAuthority.tokenOwnership)}</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_capability_state()}</dt>
					<dd>{capabilityStateLabel(provisioningAuthority.capabilityState)}</dd>
				</div>
			</dl>
		{/if}
	</AdminSection>

	<AdminSection title={$LL.admin_control_plane_recovery_title()}>
		{#if recoveryError}
			<div class="alert alert-error" role="alert">{recoveryError}</div>
		{/if}
		<div class="recovery-controls">
			<form
				onsubmit={(event) => {
					event.preventDefault();
					void startRecovery();
				}}
			>
				<h3>{$LL.admin_control_plane_recovery_start()}</h3>
				<label>
					<span>{$LL.admin_control_plane_recovery_tenant()}</span>
					<input
						class="form-input"
						bind:value={recoveryTenantId}
						maxlength="128"
						autocomplete="off"
					/>
				</label>
				<label>
					<span>{$LL.admin_control_plane_recovery_confirmation()}</span>
					<input
						class="form-input code-input"
						bind:value={recoveryStartConfirmation}
						placeholder={`START_TENANT_RECOVERY:${recoveryTenantId.trim()}`}
						maxlength="160"
						autocomplete="off"
					/>
				</label>
				<button
					class="btn btn-danger-outline"
					type="submit"
					disabled={recoveryActing ||
						!recoveryTenantId.trim() ||
						recoveryStartConfirmation !== `START_TENANT_RECOVERY:${recoveryTenantId.trim()}`}
				>
					<i class="i-ph-first-aid" aria-hidden="true"></i>
					<span>{$LL.admin_control_plane_recovery_start()}</span>
				</button>
			</form>

			<form
				onsubmit={(event) => {
					event.preventDefault();
					void inspectRecovery();
				}}
			>
				<h3>{$LL.admin_control_plane_recovery_inspect()}</h3>
				<label>
					<span>{$LL.admin_control_plane_operation_id()}</span>
					<input
						class="form-input"
						bind:value={recoveryOperationId}
						maxlength="128"
						autocomplete="off"
					/>
				</label>
				<button
					class="btn btn-secondary"
					type="submit"
					disabled={recoveryActing || !recoveryOperationId.trim()}
				>
					<i class="i-ph-magnifying-glass" aria-hidden="true"></i>
					<span>{$LL.admin_control_plane_recovery_inspect()}</span>
				</button>
			</form>
		</div>

		{#if recovery}
			<dl class="operation-summary recovery-summary">
				<div>
					<dt>{$LL.admin_control_plane_recovery_tenant()}</dt>
					<dd>{recovery.tenantId}</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_operation_status()}</dt>
					<dd><span class="badge badge-neutral">{recovery.state}</span></dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_recovery_route_generation()}</dt>
					<dd>{recovery.pinnedRouteGeneration}</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_recovery_drain_until()}</dt>
					<dd>{recovery.drainNotBefore ? formatDate(recovery.drainNotBefore) : '-'}</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_recovery_lookup_stage()}</dt>
					<dd>
						{recovery.lookupReprojection.stage}
						{#if recovery.lookupReprojection.leaseActive}
							<span class="badge badge-neutral"
								>{$LL.admin_control_plane_recovery_lease_active()}</span
							>
						{/if}
					</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_recovery_lookup_rows()}</dt>
					<dd>
						{recovery.lookupReprojection.projectedRows} /
						{recovery.lookupReprojection.verifiedRows}
					</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_last_error()}</dt>
					<dd class="code-value">{recovery.lastErrorCode ?? '-'}</dd>
				</div>
			</dl>

			{#if recovery.canConfirmRestore}
				<form
					class="recovery-action"
					onsubmit={(event) => {
						event.preventDefault();
						void confirmRecoveryRestore();
					}}
				>
					<label>
						<span>{$LL.admin_control_plane_recovery_restore_reference()}</span>
						<input
							class="form-input"
							bind:value={restoreReference}
							maxlength="512"
							autocomplete="off"
						/>
					</label>
					<label>
						<span>{$LL.admin_control_plane_recovery_restored_at()}</span>
						<input class="form-input" type="datetime-local" bind:value={restoreCompletedAt} />
					</label>
					<button
						class="btn btn-danger-outline"
						type="submit"
						disabled={recoveryActing || !restoreReference.trim() || !restoreCompletedAt}
					>
						<i class="i-ph-check-circle" aria-hidden="true"></i>
						<span>{$LL.admin_control_plane_recovery_confirm_restore()}</span>
					</button>
				</form>
			{/if}

			{#if recovery.canVerify}
				<div class="recovery-action">
					<button
						class="btn btn-secondary"
						onclick={verifyRecoveryMigration}
						disabled={recoveryActing}
					>
						<i class="i-ph-checks" aria-hidden="true"></i>
						<span>{$LL.admin_control_plane_recovery_verify_migration()}</span>
					</button>
				</div>
			{/if}

			{#if recovery.canReactivate}
				<form
					class="recovery-action"
					onsubmit={(event) => {
						event.preventDefault();
						void reactivateRecovery();
					}}
				>
					<label>
						<span>{$LL.admin_control_plane_recovery_confirmation()}</span>
						<input
							class="form-input code-input"
							bind:value={recoveryReactivateConfirmation}
							placeholder={`REACTIVATE_RECOVERED_TENANT:${recovery.tenantId}`}
							maxlength="180"
							autocomplete="off"
						/>
					</label>
					<button
						class="btn btn-danger-outline"
						type="submit"
						disabled={recoveryActing ||
							recoveryReactivateConfirmation !== `REACTIVATE_RECOVERED_TENANT:${recovery.tenantId}`}
					>
						<i class="i-ph-power" aria-hidden="true"></i>
						<span>{$LL.admin_control_plane_recovery_reactivate()}</span>
					</button>
				</form>
			{/if}

			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_control_plane_cleanup_shard()}</th>
						<th>{$LL.admin_control_plane_cleanup_role()}</th>
						<th>{$LL.admin_control_plane_recovery_residency()}</th>
						<th>{$LL.admin_control_plane_recovery_restore()}</th>
						<th>{$LL.admin_control_plane_recovery_migration()}</th>
						<th>{$LL.admin_control_plane_recovery_lookup()}</th>
						<th>{$LL.admin_control_plane_recovery_binding_smoke()}</th>
					</tr>
				</thead>
				<tbody>
					{#each recovery.targets as target (target.shardId)}
						<tr>
							<td class="code-value">{target.shardId}</td>
							<td>{target.dataRole}</td>
							<td>{target.residencyPartition}</td>
							<td>{target.restoreConfirmedAt ? formatDate(target.restoreConfirmedAt) : '-'}</td>
							<td>{target.migrationVerifiedAt ? formatDate(target.migrationVerifiedAt) : '-'}</td>
							<td>{target.lookupReprojectedAt ? formatDate(target.lookupReprojectedAt) : '-'}</td>
							<td>
								{target.bindingSmokeVerifiedAt ? formatDate(target.bindingSmokeVerifiedAt) : '-'}
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		{/if}
	</AdminSection>

	{#if releaseRollout && releaseRollout.phase !== 'idle'}
		<AdminSection title={$LL.admin_release_rollout_recovery_title()}>
			<p>{$LL.admin_release_rollout_recovery_description()}</p>
			<dl class="operation-summary">
				<div>
					<dt>{$LL.admin_release_rollout_version_path()}</dt>
					<dd class="code-value">
						{$LL.admin_release_rollout_versions({
							source: releaseRollout.sourceVersion ?? '-',
							target: releaseRollout.targetVersion ?? '-'
						})}
					</dd>
				</div>
				<div>
					<dt>{$LL.admin_release_rollout_database_progress()}</dt>
					<dd>
						{$LL.admin_release_rollout_progress({
							completed: releaseRollout.completedTargets,
							total: releaseRollout.totalTargets
						})}
					</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_operation_status()}</dt>
					<dd><span class="badge badge-neutral">{releaseRollout.phase}</span></dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_operation_id()}</dt>
					<dd class="code-value">{releaseRollout.operationId ?? '-'}</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_updated()}</dt>
					<dd>{releaseRollout.updatedAt ? formatDate(releaseRollout.updatedAt) : '-'}</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_last_error()}</dt>
					<dd class="code-value">{releaseRollout.lastErrorCode ?? '-'}</dd>
				</div>
			</dl>
			{#if releaseRetryError}
				<div class="alert alert-error" role="alert">{releaseRetryError}</div>
			{/if}
			{#if releaseRollout.blockedTargetCount > 0}
				<h3>
					{$LL.admin_release_rollout_blocked_targets({
						count: releaseRollout.blockedTargetCount
					})}
				</h3>
				<AdminDataTable width="wide">
					<thead>
						<tr>
							<th>{$LL.admin_control_plane_cleanup_shard()}</th>
							<th>{$LL.admin_control_plane_step()}</th>
							<th>{$LL.admin_control_plane_attempts()}</th>
							<th>{$LL.admin_control_plane_last_error()}</th>
							<th>{$LL.admin_control_plane_updated()}</th>
							<th><span class="sr-only">{$LL.admin_release_rollout_retry_target()}</span></th>
						</tr>
					</thead>
					<tbody>
						{#each releaseRollout.blockedTargets as target (target.targetId)}
							<tr>
								<td class="code-value">{target.targetId}</td>
								<td class="code-value">{target.streamId}</td>
								<td>{target.attemptCount}</td>
								<td class="code-value">{target.lastErrorCode}</td>
								<td>{formatDate(target.updatedAt)}</td>
								<td>
									<button
										class="btn btn-secondary btn-sm"
										onclick={() => retryReleaseTarget(target.targetId)}
										disabled={Boolean(releaseRetryTargetId)}
									>
										<i class="i-ph-arrow-clockwise" aria-hidden="true"></i>
										<span>
											{releaseRetryTargetId === target.targetId
												? $LL.admin_release_rollout_retrying_target()
												: $LL.admin_release_rollout_retry_target()}
										</span>
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			{/if}
		</AdminSection>
	{/if}

	<AdminSection title={$LL.admin_control_plane_operation_inspection()}>
		<form
			class="operation-search"
			onsubmit={(event) => {
				event.preventDefault();
				void inspectOperation();
			}}
		>
			<label for="control-plane-operation-id">{$LL.admin_control_plane_operation_id()}</label>
			<div class="operation-search-controls">
				<input
					id="control-plane-operation-id"
					class="form-input"
					bind:value={operationId}
					placeholder={$LL.admin_control_plane_operation_id_placeholder()}
					maxlength="128"
					autocomplete="off"
				/>
				<button
					class="btn btn-secondary"
					type="submit"
					disabled={inspecting || !operationId.trim()}
				>
					<i class="i-ph-magnifying-glass" aria-hidden="true"></i>
					<span>{$LL.admin_control_plane_inspect()}</span>
				</button>
			</div>
		</form>

		{#if operationError}
			<div class="alert alert-error" role="alert">{operationError}</div>
		{:else if operation}
			{#if retryError}
				<div class="alert alert-error" role="alert">{retryError}</div>
			{/if}
			<dl class="operation-summary">
				<div>
					<dt>{$LL.admin_control_plane_operation_status()}</dt>
					<dd><span class="badge badge-neutral">{operationStatusLabel(operation.status)}</span></dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_operation_kind()}</dt>
					<dd>{operation.operationKind}</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_attempts()}</dt>
					<dd>{operation.attemptCount}</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_updated()}</dt>
					<dd>{formatDate(operation.updatedAt)}</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_next_retry()}</dt>
					<dd>{operation.nextAttemptAt ? formatDate(operation.nextAttemptAt) : '-'}</dd>
				</div>
				<div>
					<dt>{$LL.admin_control_plane_last_error()}</dt>
					<dd class="code-value">{operation.lastErrorCode ?? '-'}</dd>
				</div>
			</dl>

			{#if operation.availableActions.includes('cancel')}
				<div class="operation-retry-action">
					<div>
						<strong>{$LL.admin_control_plane_cancel_available()}</strong>
					</div>
					{#if cancelConfirming}
						<div class="operation-action-buttons">
							<button
								class="btn btn-ghost btn-sm"
								onclick={() => (cancelConfirming = false)}
								disabled={canceling}
							>
								<i class="i-ph-arrow-counter-clockwise" aria-hidden="true"></i>
								<span>{$LL.admin_control_plane_keep_operation()}</span>
							</button>
							<button class="btn btn-danger btn-sm" onclick={cancelOperation} disabled={canceling}>
								<i class="i-ph-x-circle" aria-hidden="true"></i>
								<span>{$LL.admin_control_plane_confirm_cancel()}</span>
							</button>
						</div>
					{:else}
						<button
							class="btn btn-danger-outline btn-sm"
							onclick={() => (cancelConfirming = true)}
							disabled={canceling || Boolean(retryingStep)}
							title={$LL.admin_control_plane_cancel_operation()}
						>
							<i class="i-ph-x-circle" aria-hidden="true"></i>
							<span>{$LL.admin_control_plane_cancel_operation()}</span>
						</button>
					{/if}
				</div>
			{/if}

			{#if operation.availableActions.includes('restore_previous_settings')}
				<div class="operation-retry-action">
					<div>
						<strong>{$LL.admin_control_plane_restore_available()}</strong>
					</div>
					{#if restoreConfirming}
						<div class="operation-action-buttons">
							<button
								class="btn btn-ghost btn-sm"
								onclick={() => (restoreConfirming = false)}
								disabled={restoring}
							>
								<i class="i-ph-x" aria-hidden="true"></i>
								<span>{$LL.admin_control_plane_keep_current_settings()}</span>
							</button>
							<button
								class="btn btn-danger btn-sm"
								onclick={restorePreviousSettings}
								disabled={restoring}
							>
								<i class="i-ph-arrow-counter-clockwise" aria-hidden="true"></i>
								<span>{$LL.admin_control_plane_confirm_restore()}</span>
							</button>
						</div>
					{:else}
						<button
							class="btn btn-danger-outline btn-sm"
							onclick={() => (restoreConfirming = true)}
							disabled={restoring || canceling || Boolean(retryingStep)}
							title={$LL.admin_control_plane_restore_previous_settings()}
						>
							<i class="i-ph-arrow-counter-clockwise" aria-hidden="true"></i>
							<span>{$LL.admin_control_plane_restore_previous_settings()}</span>
						</button>
					{/if}
				</div>
			{/if}

			{#each operation.steps as step (step.stepKey)}
				{#if isRetryableStep(step)}
					<div class="operation-retry-action">
						<div>
							<strong>{$LL.admin_control_plane_blocked_step()}</strong>
							<span class="code-value">{step.stepKey}</span>
						</div>
						<button
							class="btn btn-secondary btn-sm"
							onclick={() => retryStep(step)}
							disabled={Boolean(retryingStep) || canceling || restoring}
							title={$LL.admin_control_plane_retry_step()}
						>
							<i class="i-ph-arrow-clockwise" aria-hidden="true"></i>
							<span>{$LL.admin_control_plane_retry_step()}</span>
						</button>
					</div>
				{/if}
			{/each}

			<h3>{$LL.admin_control_plane_steps()}</h3>
			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_control_plane_step()}</th>
						<th>{$LL.admin_control_plane_operation_status()}</th>
						<th>{$LL.admin_control_plane_attempts()}</th>
						<th>{$LL.admin_control_plane_started()}</th>
						<th>{$LL.admin_control_plane_completed()}</th>
						<th>{$LL.admin_control_plane_last_error()}</th>
					</tr>
				</thead>
				<tbody>
					{#each operation.steps as step (step.stepKey)}
						<tr>
							<td class="code-value">{step.stepKey}</td>
							<td><span class="badge badge-neutral">{operationStatusLabel(step.status)}</span></td>
							<td>{step.attemptCount}</td>
							<td>{step.startedAt ? formatDate(step.startedAt) : '-'}</td>
							<td>{step.completedAt ? formatDate(step.completedAt) : '-'}</td>
							<td class="code-value">{step.lastErrorCode ?? '-'}</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		{/if}
	</AdminSection>

	<AdminSection title={$LL.admin_control_plane_cleanup_title()} actions={cleanupSectionActions}>
		{#if cleanupError}
			<div class="alert alert-error" role="alert">{cleanupError}</div>
		{/if}
		{#if loading}
			<p class="text-muted">{$LL.admin_control_plane_cleanup_loading()}</p>
		{:else if cleanupCandidates.length === 0}
			<p class="text-muted">{$LL.admin_control_plane_cleanup_empty()}</p>
		{:else}
			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_control_plane_cleanup_shard()}</th>
						<th>{$LL.admin_control_plane_cleanup_role()}</th>
						<th>{$LL.admin_control_plane_cleanup_quarantine()}</th>
						<th>{$LL.admin_control_plane_cleanup_state()}</th>
						<th>{$LL.admin_control_plane_cleanup_bindings()}</th>
						<th>{$LL.admin_control_plane_last_error()}</th>
						<th class="text-right">{$LL.admin_control_plane_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each cleanupCandidates as candidate (candidate.shardId)}
						<tr>
							<td>
								<strong>{candidate.databaseName}</strong>
								<small class="finding-id">{candidate.shardId}</small>
							</td>
							<td>
								{candidate.dataRole}
								<small class="finding-id">{candidate.residencyPartition}</small>
							</td>
							<td>
								<span class="badge badge-neutral">{candidate.quarantineState}</span>
								{#if candidate.drainNotBefore}
									<small class="finding-id">{formatDate(candidate.drainNotBefore)}</small>
								{/if}
							</td>
							<td>
								<span
									class:badge-warning={candidate.cleanupState === 'blocked'}
									class="badge badge-neutral"
								>
									{candidate.cleanupState ?? '-'}
								</span>
								{#if !candidate.destructiveOperationsEnabled}
									<small class="gate-disabled">
										{$LL.admin_control_plane_cleanup_gate_disabled()}
									</small>
								{/if}
							</td>
							<td>{bindingProgress(candidate)}</td>
							<td class="code-value">{candidate.lastErrorCode ?? '-'}</td>
							<td>
								<div class="row-actions cleanup-actions">
									{#if candidate.availableActions.includes('quarantine')}
										<button
											class="btn btn-secondary btn-sm"
											onclick={() => quarantineShard(candidate)}
											disabled={Boolean(cleanupActingId)}
											title={$LL.admin_control_plane_cleanup_quarantine_action()}
										>
											<i class="i-ph-shield-warning" aria-hidden="true"></i>
											<span>{$LL.admin_control_plane_cleanup_quarantine_action()}</span>
										</button>
									{/if}
									{#if candidate.availableActions.includes('retry_quarantine')}
										<button
											class="btn btn-secondary btn-sm"
											onclick={() => retryShardQuarantine(candidate)}
											disabled={Boolean(cleanupActingId)}
											title={$LL.admin_control_plane_cleanup_retry_quarantine()}
										>
											<i class="i-ph-arrow-clockwise" aria-hidden="true"></i>
											<span>{$LL.admin_control_plane_cleanup_retry_quarantine()}</span>
										</button>
									{/if}
									{#if candidate.availableActions.includes('approve_cleanup')}
										<button
											class="btn btn-danger-outline btn-sm"
											onclick={() => openCleanupApproval(candidate)}
											disabled={Boolean(cleanupActingId) || !candidate.destructiveOperationsEnabled}
											title={candidate.destructiveOperationsEnabled
												? $LL.admin_control_plane_cleanup_approve()
												: $LL.admin_control_plane_cleanup_gate_disabled()}
										>
											<i class="i-ph-trash" aria-hidden="true"></i>
											<span>{$LL.admin_control_plane_cleanup_approve()}</span>
										</button>
									{/if}
									{#if candidate.availableActions.includes('retry_cleanup')}
										<button
											class="btn btn-danger-outline btn-sm"
											onclick={() => retryShardCleanup(candidate)}
											disabled={Boolean(cleanupActingId)}
											title={$LL.admin_control_plane_cleanup_retry()}
										>
											<i class="i-ph-arrow-clockwise" aria-hidden="true"></i>
											<span>{$LL.admin_control_plane_cleanup_retry()}</span>
										</button>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		{/if}

		{#if approvalCandidate}
			<form
				class="cleanup-approval"
				onsubmit={(event) => {
					event.preventDefault();
					void approveShardCleanup();
				}}
			>
				<h3>{$LL.admin_control_plane_cleanup_approval_title()}</h3>
				<div class="cleanup-form-grid">
					<label>
						<span>{$LL.admin_control_plane_cleanup_export_mode()}</span>
						<select class="form-select" bind:value={cleanupExportMode}>
							<option value="skipped">{$LL.admin_control_plane_cleanup_export_skipped()}</option>
							<option value="manual_verified">
								{$LL.admin_control_plane_cleanup_export_verified()}
							</option>
						</select>
					</label>
					{#if cleanupExportMode === 'manual_verified'}
						<label>
							<span>{$LL.admin_control_plane_cleanup_export_evidence()}</span>
							<input
								class="form-input"
								bind:value={cleanupExportEvidenceId}
								maxlength="128"
								autocomplete="off"
							/>
						</label>
					{/if}
					<label>
						<span>{$LL.admin_control_plane_cleanup_confirmation()}</span>
						<input
							class="form-input code-input"
							bind:value={cleanupConfirmation}
							placeholder="DELETE_RETIRED_TENANT_SHARD"
							maxlength="32"
							autocomplete="off"
						/>
					</label>
				</div>
				<label class="cleanup-checkbox">
					<input type="checkbox" bind:checked={cleanupDeleteDatabase} />
					<span>{$LL.admin_control_plane_cleanup_delete_database()}</span>
				</label>
				<div class="operation-action-buttons">
					<button class="btn btn-ghost" type="button" onclick={closeCleanupApproval}>
						<i class="i-ph-x" aria-hidden="true"></i>
						<span>{$LL.admin_control_plane_cleanup_cancel()}</span>
					</button>
					<button
						class="btn btn-danger"
						type="submit"
						disabled={Boolean(cleanupActingId) ||
							cleanupConfirmation !== 'DELETE_RETIRED_TENANT_SHARD' ||
							(cleanupExportMode === 'manual_verified' && !cleanupExportEvidenceId.trim())}
					>
						<i class="i-ph-trash" aria-hidden="true"></i>
						<span>{$LL.admin_control_plane_cleanup_confirm()}</span>
					</button>
				</div>
			</form>
		{/if}
	</AdminSection>

	<AdminSection title={$LL.admin_control_plane_findings()} actions={sectionActions}>
		{#if loading}
			<p class="text-muted">{$LL.admin_control_plane_loading()}</p>
		{:else if findings.length === 0}
			<p class="text-muted">{$LL.admin_control_plane_empty()}</p>
		{:else}
			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_control_plane_worker()}</th>
						<th>{$LL.admin_control_plane_status()}</th>
						<th>{$LL.admin_control_plane_notification()}</th>
						<th>{$LL.admin_control_plane_first_seen()}</th>
						<th>{$LL.admin_control_plane_last_seen()}</th>
						<th class="text-right">{$LL.admin_control_plane_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each findings as finding (finding.findingId)}
						<tr>
							<td>
								<strong>{finding.workerScriptName}</strong>
								<small class="finding-id">{finding.findingId}</small>
							</td>
							<td>
								<span
									class:badge-warning={finding.reviewState === 'unreviewed'}
									class="badge badge-neutral"
								>
									{reviewLabel(finding.reviewState)}
								</span>
							</td>
							<td>{notificationLabel(finding.notificationState)}</td>
							<td>{formatDate(finding.firstObservedAt)}</td>
							<td>{formatDate(finding.lastObservedAt)}</td>
							<td>
								<div class="row-actions">
									<button
										class="btn btn-secondary btn-sm"
										onclick={() => setDisposition(finding, 'reviewed')}
										disabled={reviewingId === finding.findingId ||
											finding.reviewState === 'reviewed'}
										title={$LL.admin_control_plane_review()}
									>
										<i class="i-ph-check-circle" aria-hidden="true"></i>
										<span>{$LL.admin_control_plane_review()}</span>
									</button>
									<button
										class="btn btn-ghost btn-sm"
										onclick={() => setDisposition(finding, 'dismissed')}
										disabled={reviewingId === finding.findingId ||
											finding.reviewState === 'dismissed'}
										title={$LL.admin_control_plane_dismiss()}
									>
										<i class="i-ph-eye-slash" aria-hidden="true"></i>
										<span>{$LL.admin_control_plane_dismiss()}</span>
									</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		{/if}
	</AdminSection>
</AdminPageShell>

<style>
	.alert {
		margin-bottom: 1rem;
		padding: 0.75rem 1rem;
		border: 1px solid color-mix(in srgb, var(--color-danger) 32%, var(--color-border));
		border-radius: var(--radius-control);
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
	}

	.text-muted,
	.finding-id {
		color: var(--color-text-muted);
	}

	.operation-search {
		display: grid;
		gap: 0.5rem;
		max-width: 720px;
		margin-bottom: 1rem;
	}

	.recovery-controls {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 1.25rem;
		margin-bottom: 1.25rem;
	}

	.recovery-controls form,
	.recovery-action {
		display: grid;
		align-content: start;
		gap: 0.75rem;
	}

	.recovery-controls label,
	.recovery-action label {
		display: grid;
		gap: 0.4rem;
		min-width: 0;
		font-size: 0.82rem;
		font-weight: 600;
	}

	.recovery-controls :global(.btn),
	.recovery-action :global(.btn) {
		justify-self: start;
	}

	.recovery-action {
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		align-items: end;
		margin: 0 0 1.25rem;
		padding: 1rem 0;
		border-block: 1px solid var(--color-border);
	}

	.recovery-summary {
		margin-top: 1rem;
	}

	.operation-search label,
	.authority-summary dt,
	.operation-summary dt {
		color: var(--color-text-muted);
		font-size: 0.78rem;
		font-weight: 600;
	}

	.operation-search-controls {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.5rem;
	}

	.operation-summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 1rem;
		margin: 0 0 1.25rem;
	}

	.authority-summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		gap: 1rem;
		margin: 0;
	}

	.authority-summary div {
		min-width: 0;
	}

	.authority-summary dd {
		margin: 0.25rem 0 0;
	}

	.badge-ready {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.operation-summary div {
		min-width: 0;
	}

	.operation-summary dd {
		margin: 0.25rem 0 0;
	}

	.operation-retry-action {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin: 0 0 1.25rem;
		padding: 0.75rem 0;
		border-block: 1px solid var(--color-border);
	}

	.operation-retry-action > div {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 0;
	}

	.operation-action-buttons {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	h3 {
		margin: 0 0 0.75rem;
		font-size: 1rem;
	}

	.code-value {
		max-width: 260px;
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: 0.78rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 520px) {
		.operation-search-controls {
			grid-template-columns: 1fr;
		}

		.operation-search-controls :global(.btn) {
			width: 100%;
		}

		.operation-retry-action {
			align-items: stretch;
			flex-direction: column;
		}

		.operation-retry-action :global(.btn) {
			width: 100%;
		}

		.operation-action-buttons {
			width: 100%;
		}
	}

	.finding-id {
		display: block;
		max-width: 280px;
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.badge-warning {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.row-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		min-width: 250px;
	}

	.row-actions :global(.btn) {
		white-space: nowrap;
	}

	.gate-disabled {
		display: block;
		margin-top: 0.35rem;
		color: var(--color-warning);
		font-size: 0.72rem;
	}

	.cleanup-actions {
		min-width: 160px;
	}

	.cleanup-approval {
		display: grid;
		gap: 1rem;
		margin-top: 1.25rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--color-border);
	}

	.cleanup-form-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 1rem;
	}

	.cleanup-form-grid label {
		display: grid;
		gap: 0.4rem;
		min-width: 0;
		font-size: 0.82rem;
		font-weight: 600;
	}

	.code-input {
		font-family: var(--font-mono);
	}

	.cleanup-checkbox {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
</style>
