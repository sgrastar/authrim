<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import {
		adminLoggingControlAPI,
		type AdminAuditCoverageStatus,
		type AdminLoggingCriticalPolicy,
		type AdminLoggingKeyRegistryItem,
		type AdminLoggingOverview,
		type AdminLoggingRewrapJob,
		type AdminLoggingSensitiveDetailPolicy,
		type AdminLoggingKeyImpact,
		type SensitiveDetailProbeResult,
		type DangerousLogCatalogRepairPlan,
		type LoggingMessageJob,
		type LoggingCatalogRepairJob,
		type LogCatalogRepairFinding
	} from '$lib/api/admin-logging-control';
	import DangerConfirmationModal from '$lib/components/admin/DangerConfirmationModal.svelte';
	import { LL } from '$i18n/i18n-svelte';

	type DangerConfirmationRequest = {
		title: string;
		resourceName: string;
		phrase: string;
		confirmLabel: string;
		resolve: (value: string | null) => void;
	};

	let overview = $state<AdminLoggingOverview | null>(null);
	let coverageItems = $state<AdminAuditCoverageStatus[]>([]);
	let repairFindings = $state<LogCatalogRepairFinding[]>([]);
	let catalogRepairJobs = $state<LoggingCatalogRepairJob[]>([]);
	let criticalPolicy = $state<AdminLoggingCriticalPolicy | null>(null);
	let sensitiveDetailPolicy = $state<AdminLoggingSensitiveDetailPolicy | null>(null);
	let keyRegistryItems = $state<AdminLoggingKeyRegistryItem[]>([]);
	let rewrapJobs = $state<AdminLoggingRewrapJob[]>([]);
	let messageJobs = $state<LoggingMessageJob[]>([]);
	let catalogRepairTenantKey = $state('');
	let catalogRepairLogType = $state('');
	let catalogRepairPlane = $state('');
	let sensitiveProbeCatalogId = $state('');
	let sensitiveProbeTenantId = $state('');
	let sensitiveProbeObjectClass = $state('');
	let sensitiveProbe = $state<SensitiveDetailProbeResult | null>(null);
	let sensitiveProbeLoading = $state(false);
	let keyImpact = $state<AdminLoggingKeyImpact | null>(null);
	let keyActionId = $state<string | null>(null);
	let rewrapJobActionId = $state<string | null>(null);
	let rewrapPriorityInputs = $state<Record<string, number>>({});
	let rewrapCreateLimit = $state(25);
	let loading = $state(true);
	let checkingCoverage = $state(false);
	let applyingRepairs = $state(false);
	let catalogRepairJobAction = $state(false);
	let dangerousRepairId = $state<string | null>(null);
	let dangerousRepairPlan = $state<DangerousLogCatalogRepairPlan | null>(null);
	let dangerConfirmation = $state<DangerConfirmationRequest | null>(null);
	let error = $state('');
	let windowHours = $state(24);
	const PERM_ADMIN_LOGGING_OVERVIEW_READ = 'admin:admin_logging:overview:read';
	const PERM_ADMIN_LOGGING_COVERAGE_READ = 'admin:admin_logging:coverage:read';
	const PERM_ADMIN_LOGGING_COVERAGE_UPDATE = 'admin:admin_logging:coverage:update';
	const PERM_ADMIN_LOGGING_REPAIR_READ = 'admin:admin_logging:repair:read';
	const PERM_ADMIN_LOGGING_REPAIR_RUN = 'admin:admin_logging:repair:run';
	const PERM_ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ =
		'admin:admin_logging:sensitive_detail_policy:read';
	const PERM_LOGGING_DELIVERY_EVENTS_READ = 'admin:logging:delivery_events:read';
	const PERM_LOGGING_SENSITIVE_DETAIL_EXPORT = 'admin:logging:sensitive_detail:export';
	const isPlatformAdmin = $derived(Boolean(adminAuth.user?.isPlatformAdmin));
	const canViewCoverage = $derived(
		isPlatformAdmin && hasAdminPermission(PERM_ADMIN_LOGGING_COVERAGE_READ)
	);
	const canCheckCoverage = $derived(
		isPlatformAdmin && hasAdminPermission(PERM_ADMIN_LOGGING_COVERAGE_UPDATE)
	);
	const canReadCatalogRepair = $derived(
		isPlatformAdmin && hasAdminPermission(PERM_ADMIN_LOGGING_REPAIR_READ)
	);
	const canViewCriticalPolicy = $derived(
		isPlatformAdmin && hasAdminPermission(PERM_ADMIN_LOGGING_OVERVIEW_READ)
	);
	const canRunCatalogRepair = $derived(
		isPlatformAdmin && hasAdminPermission(PERM_ADMIN_LOGGING_REPAIR_RUN)
	);
	const canViewSensitiveDetailPolicy = $derived(
		isPlatformAdmin && hasAdminPermission(PERM_ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ)
	);
	const canProbeSensitiveDetail = $derived(
		isPlatformAdmin && hasAdminPermission(PERM_LOGGING_SENSITIVE_DETAIL_EXPORT)
	);
	const canReadMessageJobs = $derived(hasAdminPermission(PERM_LOGGING_DELIVERY_EVENTS_READ));
	function hasAdminPermission(permission: string): boolean {
		const permissions = adminAuth.user?.permissions ?? [];
		if (permissions.includes('*') || permissions.includes(permission)) return true;
		const parts = permission.split(':');
		for (let i = parts.length - 1; i >= 0; i -= 1) {
			if (permissions.includes([...parts.slice(0, i), '*'].join(':'))) {
				return true;
			}
		}
		return false;
	}

	function requestDangerConfirmation(input: Omit<DangerConfirmationRequest, 'resolve'>) {
		return new Promise<string | null>((resolve) => {
			dangerConfirmation = { ...input, resolve };
		});
	}

	function cancelDangerConfirmation() {
		dangerConfirmation?.resolve(null);
		dangerConfirmation = null;
	}

	function confirmDangerConfirmation(value: string) {
		dangerConfirmation?.resolve(value);
		dangerConfirmation = null;
	}

	async function load() {
		loading = true;
		error = '';
		try {
			const from = Date.now() - windowHours * 60 * 60 * 1000;
			const [
				overviewResponse,
				coverageResponse,
				repairResponse,
				criticalResponse,
				sensitiveDetailResponse,
				keyRegistryResponse,
				rewrapJobsResponse,
				messageJobsResponse
			] = await Promise.all([
				adminLoggingControlAPI.getAdminLoggingOverview(from),
				canViewCoverage
					? adminLoggingControlAPI.listAdminAuditCoverage().catch(() => ({ items: [], total: 0 }))
					: Promise.resolve({ items: [], total: 0 }),
				canReadCatalogRepair
					? adminLoggingControlAPI
							.listCatalogRepairFindings({
								tenantKey: catalogRepairTenantKey.trim() || undefined,
								logType: catalogRepairLogType || undefined,
								plane: catalogRepairPlane || undefined
							})
							.catch(() => ({ items: [], total: 0 }))
					: Promise.resolve({ items: [], total: 0 }),
				canViewCriticalPolicy
					? adminLoggingControlAPI.getAdminLoggingCriticalPolicy().catch(() => ({ item: null }))
					: Promise.resolve({ item: null }),
				canViewSensitiveDetailPolicy
					? adminLoggingControlAPI
							.getAdminLoggingSensitiveDetailPolicy()
							.catch(() => ({ item: null }))
					: Promise.resolve({ item: null }),
				canViewSensitiveDetailPolicy
					? adminLoggingControlAPI.listAdminLoggingKeyRegistry().catch(() => ({
							items: [],
							total: 0
						}))
					: Promise.resolve({ items: [], total: 0 }),
				canReadCatalogRepair
					? adminLoggingControlAPI.listAdminLoggingRewrapJobs().catch(() => ({
							items: [],
							total: 0
						}))
					: Promise.resolve({ items: [], total: 0 }),
				canReadMessageJobs
					? adminLoggingControlAPI
							.listMessageJobs({
								timeStart: from,
								limit: 25
							})
							.catch(() => ({ items: [], total: 0 }))
					: Promise.resolve({ items: [], total: 0 })
			]);
			overview = overviewResponse.item;
			coverageItems = coverageResponse.items;
			repairFindings = repairResponse.items;
			catalogRepairJobs = canReadCatalogRepair
				? (
						await adminLoggingControlAPI
							.listCatalogRepairJobs({
								tenantKey: catalogRepairTenantKey.trim() || undefined,
								logType: catalogRepairLogType || undefined,
								plane: catalogRepairPlane || undefined,
								limit: 10
							})
							.catch(() => ({ items: [], total: 0 }))
					).items
				: [];
			criticalPolicy = criticalResponse.item;
			sensitiveDetailPolicy = sensitiveDetailResponse.item;
			keyRegistryItems = keyRegistryResponse.items;
			rewrapJobs = rewrapJobsResponse.items;
			rewrapPriorityInputs = Object.fromEntries(
				rewrapJobsResponse.items.map((job) => [job.id, job.priority])
			);
			messageJobs = messageJobsResponse.items;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_logging_load_failed();
			overview = null;
			coverageItems = [];
			repairFindings = [];
			catalogRepairJobs = [];
			criticalPolicy = null;
			sensitiveDetailPolicy = null;
			keyRegistryItems = [];
			rewrapJobs = [];
			rewrapPriorityInputs = {};
			messageJobs = [];
		} finally {
			loading = false;
		}
	}

	async function checkCoverage() {
		if (!canCheckCoverage) return;
		checkingCoverage = true;
		error = '';
		try {
			const response = await adminLoggingControlAPI.checkAdminAuditCoverage();
			if (overview) {
				overview = { ...overview, coverage: response.result.summary };
			}
			const coverageResponse = await adminLoggingControlAPI.listAdminAuditCoverage();
			coverageItems = coverageResponse.items;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_logging_check_coverage_failed();
		} finally {
			checkingCoverage = false;
		}
	}

	async function applySafeRepairs() {
		if (!canRunCatalogRepair) return;
		applyingRepairs = true;
		error = '';
		try {
			const filters = {
				tenantKey: catalogRepairTenantKey.trim() || undefined,
				logType: catalogRepairLogType || undefined,
				plane: catalogRepairPlane || undefined
			};
			await adminLoggingControlAPI.applySafeCatalogRepairs(100, filters);
			const repairResponse = await adminLoggingControlAPI.listCatalogRepairFindings(filters);
			repairFindings = repairResponse.items;
			await load();
		} catch (err) {
			error =
				err instanceof Error ? err.message : $LL.admin_admin_logging_apply_safe_repairs_failed();
		} finally {
			applyingRepairs = false;
		}
	}

	async function scanCatalogRepairJob() {
		if (!canReadCatalogRepair || catalogRepairJobAction) return;
		catalogRepairJobAction = true;
		error = '';
		try {
			const filters = {
				tenantKey: catalogRepairTenantKey.trim() || undefined,
				logType: catalogRepairLogType || undefined,
				plane: catalogRepairPlane || undefined
			};
			await adminLoggingControlAPI.scanCatalogRepairJob(filters);
			const jobs = await adminLoggingControlAPI.listCatalogRepairJobs({ ...filters, limit: 10 });
			catalogRepairJobs = jobs.items;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_logging_scan_repair_job_failed();
		} finally {
			catalogRepairJobAction = false;
		}
	}

	async function applySafeRepairJob() {
		if (!canRunCatalogRepair || catalogRepairJobAction) return;
		catalogRepairJobAction = true;
		error = '';
		try {
			const filters = {
				tenantKey: catalogRepairTenantKey.trim() || undefined,
				logType: catalogRepairLogType || undefined,
				plane: catalogRepairPlane || undefined
			};
			await adminLoggingControlAPI.applySafeCatalogRepairJob(100, filters);
			const jobs = await adminLoggingControlAPI.listCatalogRepairJobs({ ...filters, limit: 10 });
			catalogRepairJobs = jobs.items;
			const repairResponse = await adminLoggingControlAPI.listCatalogRepairFindings(filters);
			repairFindings = repairResponse.items;
		} catch (err) {
			error =
				err instanceof Error ? err.message : $LL.admin_admin_logging_apply_repair_job_failed();
		} finally {
			catalogRepairJobAction = false;
		}
	}

	async function applyDangerousDeleteObject(item: LogCatalogRepairFinding) {
		if (!canRunCatalogRepair || !item.objectCatalogId || dangerousRepairId) return;
		dangerousRepairId = item.objectCatalogId;
		error = '';
		try {
			const preview = await adminLoggingControlAPI.previewDangerousCatalogRepair({
				action: 'delete_object',
				object_catalog_id: item.objectCatalogId
			});
			dangerousRepairPlan = preview.item;
			const confirmation = await requestDangerConfirmation({
				title: $LL.admin_admin_logging_delete_catalog_object(),
				resourceName: preview.item.impact.objectKey ?? item.objectCatalogId,
				phrase: preview.item.confirmation,
				confirmLabel: $LL.admin_admin_logging_delete_object()
			});
			if (!confirmation) return;

			await adminLoggingControlAPI.applyDangerousCatalogRepair({
				action: 'delete_object',
				object_catalog_id: item.objectCatalogId,
				confirmation
			});
			dangerousRepairPlan = null;
			const repairResponse = await adminLoggingControlAPI.listCatalogRepairFindings({
				tenantKey: catalogRepairTenantKey.trim() || undefined,
				logType: catalogRepairLogType || undefined,
				plane: catalogRepairPlane || undefined
			});
			repairFindings = repairResponse.items;
			await load();
		} catch (err) {
			error =
				err instanceof Error ? err.message : $LL.admin_admin_logging_dangerous_repair_failed();
		} finally {
			dangerousRepairId = null;
		}
	}

	async function runSensitiveProbe() {
		if (!canProbeSensitiveDetail || !sensitiveProbeCatalogId.trim() || sensitiveProbeLoading)
			return;
		sensitiveProbeLoading = true;
		error = '';
		try {
			const response = await adminLoggingControlAPI.probeSensitiveDetail({
				catalogId: sensitiveProbeCatalogId.trim(),
				tenantId: sensitiveProbeTenantId.trim() || undefined,
				objectClass: sensitiveProbeObjectClass.trim() || undefined,
				readPayload: true
			});
			sensitiveProbe = response.item;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_logging_probe_failed();
		} finally {
			sensitiveProbeLoading = false;
		}
	}

	async function loadKeyImpact(item: AdminLoggingKeyRegistryItem) {
		if (keyActionId || !canViewSensitiveDetailPolicy) return;
		keyActionId = item.id;
		error = '';
		try {
			const response = await adminLoggingControlAPI.getAdminLoggingKeyImpact(item.id);
			keyImpact = response.item;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_logging_key_impact_failed();
		} finally {
			keyActionId = null;
		}
	}

	async function createRewrapJobs(item: AdminLoggingKeyRegistryItem) {
		if (keyActionId || !canRunCatalogRepair) return;
		keyActionId = item.id;
		error = '';
		try {
			await adminLoggingControlAPI.createAdminLoggingRewrapJobs({
				keyRegistryId: item.id,
				fromVersion: item.version ?? undefined,
				limit: rewrapCreateLimit
			});
			const [impactResponse, jobsResponse] = await Promise.all([
				adminLoggingControlAPI.getAdminLoggingKeyImpact(item.id),
				adminLoggingControlAPI.listAdminLoggingRewrapJobs()
			]);
			keyImpact = impactResponse.item;
			rewrapJobs = jobsResponse.items;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_logging_create_rewrap_failed();
		} finally {
			keyActionId = null;
		}
	}

	async function refreshRewrapJobs() {
		if (!canReadCatalogRepair) return;
		const jobsResponse = await adminLoggingControlAPI.listAdminLoggingRewrapJobs();
		rewrapJobs = jobsResponse.items;
		rewrapPriorityInputs = Object.fromEntries(
			jobsResponse.items.map((job) => [job.id, job.priority])
		);
	}

	function rewrapPriorityFor(job: AdminLoggingRewrapJob): number {
		return rewrapPriorityInputs[job.id] ?? job.priority;
	}

	async function retryRewrapJob(job: AdminLoggingRewrapJob) {
		if (rewrapJobActionId || !canRunCatalogRepair) return;
		rewrapJobActionId = job.id;
		error = '';
		try {
			await adminLoggingControlAPI.retryAdminLoggingRewrapJob(
				job.id,
				$LL.admin_admin_logging_manual_retry_reason()
			);
			await refreshRewrapJobs();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_logging_retry_rewrap_failed();
		} finally {
			rewrapJobActionId = null;
		}
	}

	async function cancelRewrapJob(job: AdminLoggingRewrapJob) {
		if (rewrapJobActionId || !canRunCatalogRepair) return;
		const confirmation = await requestDangerConfirmation({
			title: $LL.admin_admin_logging_cancel_rewrap_job(),
			resourceName: job.id,
			phrase: `CANCEL REWRAP ${job.id}`,
			confirmLabel: $LL.admin_admin_logging_cancel_job()
		});
		if (!confirmation) return;
		rewrapJobActionId = job.id;
		error = '';
		try {
			await adminLoggingControlAPI.cancelAdminLoggingRewrapJob(
				job.id,
				$LL.admin_admin_logging_manual_cancel_reason()
			);
			await refreshRewrapJobs();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_logging_cancel_rewrap_failed();
		} finally {
			rewrapJobActionId = null;
		}
	}

	async function updateRewrapJobPriority(job: AdminLoggingRewrapJob) {
		if (rewrapJobActionId || !canRunCatalogRepair) return;
		rewrapJobActionId = job.id;
		error = '';
		try {
			await adminLoggingControlAPI.updateAdminLoggingRewrapJobPriority(
				job.id,
				rewrapPriorityFor(job)
			);
			await refreshRewrapJobs();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_logging_update_priority_failed();
		} finally {
			rewrapJobActionId = null;
		}
	}

	onMount(load);

	function formatDate(timestamp: number | null | undefined): string {
		return timestamp ? new Date(timestamp).toLocaleString() : '-';
	}
</script>

<svelte:head>
	<title>{$LL.admin_admin_logging_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_admin_logging_title()}</h1>
			<p class="page-description">
				{$LL.admin_admin_logging_description()}
			</p>
		</div>
		<div class="page-actions">
			<select bind:value={windowHours} onchange={load}>
				<option value={1}>{$LL.admin_admin_logging_window_1h()}</option>
				<option value={6}>{$LL.admin_admin_logging_window_6h()}</option>
				<option value={24}>{$LL.admin_admin_logging_window_24h()}</option>
				<option value={72}>{$LL.admin_admin_logging_window_72h()}</option>
			</select>
			<button class="btn btn-secondary" onclick={load} disabled={loading}>
				{$LL.admin_admin_logging_refresh()}
			</button>
		</div>
	</div>

	{#if error}<div class="alert error">{error}</div>{/if}

	{#if loading}
		<p class="muted">{$LL.admin_admin_logging_loading()}</p>
	{:else if !overview}
		<p class="muted">{$LL.admin_admin_logging_empty()}</p>
	{:else}
		<div class="stats">
			<div class="stat">
				<span>{$LL.admin_admin_logging_audit_events()}</span>
				<strong>{overview.audit.total ?? 0}</strong>
			</div>
			<div class="stat">
				<span>{$LL.admin_admin_logging_failures()}</span>
				<strong>{overview.audit.failures ?? 0}</strong>
			</div>
			<div class="stat">
				<span>{$LL.admin_admin_logging_critical()}</span>
				<strong>{overview.audit.critical ?? 0}</strong>
			</div>
			<div class="stat">
				<span>{$LL.admin_admin_logging_window_start()}</span>
				<strong>{formatDate(overview.window_start_at)}</strong>
			</div>
			<div class="stat">
				<span>{$LL.admin_admin_logging_audit_coverage()}</span>
				<strong>{overview.coverage.covered}</strong>
			</div>
			<div class="stat">
				<span>{$LL.admin_admin_logging_coverage_gaps()}</span>
				<strong>{overview.coverage.gap_detected}</strong>
			</div>
			<div class="stat">
				<span>{$LL.admin_admin_logging_critical_destinations()}</span>
				<strong>{overview.critical_protection.critical_destination_count}</strong>
			</div>
			<div class="stat">
				<span>{$LL.admin_admin_logging_sensitive_classes()}</span>
				<strong>{overview.sensitive_detail.indexed_object_class_count}</strong>
			</div>
		</div>

		<section class="panel">
			<div class="section-header">
				<h2>{$LL.admin_admin_logging_audit_coverage_section()}</h2>
				{#if canCheckCoverage}
					<button class="btn btn-secondary" onclick={checkCoverage} disabled={checkingCoverage}>
						{checkingCoverage
							? $LL.admin_admin_logging_checking()
							: $LL.admin_admin_logging_check()}
					</button>
				{/if}
			</div>
			{#if coverageItems.length === 0}
				<p class="muted">
					{canViewCoverage
						? $LL.admin_admin_logging_no_coverage()
						: $LL.admin_admin_logging_coverage_permission()}
				</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>{$LL.admin_admin_logging_operation()}</th>
								<th>{$LL.admin_admin_logging_surface()}</th>
								<th>{$LL.admin_admin_logging_criticality()}</th>
								<th>{$LL.admin_admin_logging_status()}</th>
							</tr>
						</thead>
						<tbody>
							{#each coverageItems as item (item.operation_id)}
								<tr>
									<td>{item.operation_id}</td>
									<td>{item.surface}</td>
									<td>{item.criticality}</td>
									<td>{item.status}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		{#if canReadCatalogRepair}
			<section class="panel">
				<div class="section-header">
					<h2>{$LL.admin_admin_logging_catalog_repairs()}</h2>
					<div class="inline-actions">
						<span>{repairFindings.length}</span>
						<button
							class="btn btn-secondary"
							onclick={applySafeRepairs}
							disabled={applyingRepairs || repairFindings.length === 0 || !canRunCatalogRepair}
						>
							{applyingRepairs
								? $LL.admin_admin_logging_applying()
								: $LL.admin_admin_logging_apply_safe()}
						</button>
						<button
							class="btn btn-secondary"
							onclick={scanCatalogRepairJob}
							disabled={catalogRepairJobAction}
						>
							{$LL.admin_admin_logging_job_scan()}
						</button>
						<button
							class="btn btn-secondary"
							onclick={applySafeRepairJob}
							disabled={catalogRepairJobAction || !canRunCatalogRepair}
						>
							{$LL.admin_admin_logging_job_apply()}
						</button>
					</div>
				</div>
				<div class="repair-controls">
					<input
						bind:value={catalogRepairTenantKey}
						placeholder={$LL.admin_admin_logging_tenant_key_placeholder()}
					/>
					<select bind:value={catalogRepairLogType}>
						<option value="">{$LL.admin_admin_logging_any_log_type()}</option>
						<option value="audit">audit</option>
						<option value="admin_audit">admin_audit</option>
						<option value="security">security</option>
						<option value="diagnostic">diagnostic</option>
						<option value="webhook">webhook</option>
						<option value="job">job</option>
					</select>
					<select bind:value={catalogRepairPlane}>
						<option value="">{$LL.admin_admin_logging_any_plane()}</option>
						<option value="primary">primary</option>
						<option value="archive">archive</option>
						<option value="external_sink">external_sink</option>
						<option value="sensitive_detail">sensitive_detail</option>
						<option value="diagnostic_detail">diagnostic_detail</option>
						<option value="delivery_event">delivery_event</option>
					</select>
					<button class="btn btn-secondary" onclick={load} disabled={loading}>
						{$LL.admin_admin_logging_scan()}
					</button>
				</div>
				{#if repairFindings.length === 0}
					<p class="muted">{$LL.admin_admin_logging_no_catalog_findings()}</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>{$LL.admin_admin_logging_action()}</th>
									<th>{$LL.admin_admin_logging_log_type()}</th>
									<th>{$LL.admin_admin_logging_plane()}</th>
									<th>{$LL.admin_admin_logging_object()}</th>
									<th>{$LL.admin_admin_logging_reason()}</th>
									<th>{$LL.admin_admin_logging_actions()}</th>
								</tr>
							</thead>
							<tbody>
								{#each repairFindings as item (`${item.type}:${item.action}:${item.objectCatalogId ?? item.shard ?? item.bucketStartAt ?? item.reason}`)}
									<tr>
										<td>{item.action}</td>
										<td>{item.logType}</td>
										<td>{item.plane}</td>
										<td>{item.objectCatalogId ?? item.shard ?? '-'}</td>
										<td>{item.reason}</td>
										<td>
											{#if item.objectCatalogId}
												<button
													class="btn btn-danger"
													onclick={() => applyDangerousDeleteObject(item)}
													disabled={Boolean(dangerousRepairId) || !canRunCatalogRepair}
												>
													{$LL.admin_admin_logging_delete_object()}
												</button>
											{:else}
												-
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if dangerousRepairPlan}
						<div class="danger-preview">
							<strong>{dangerousRepairPlan.action}</strong>
							<span>
								{$LL.admin_admin_logging_records({
									count: dangerousRepairPlan.impact.affectedRecordCount
								})}
							</span>
						</div>
					{/if}
				{/if}
				{#if catalogRepairJobs.length > 0}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>{$LL.admin_admin_logging_job()}</th>
									<th>{$LL.admin_admin_logging_status()}</th>
									<th>{$LL.admin_admin_logging_progress()}</th>
									<th>{$LL.admin_admin_logging_artifact()}</th>
								</tr>
							</thead>
							<tbody>
								{#each catalogRepairJobs as job (job.id)}
									<tr>
										<td>{job.job_kind}</td>
										<td>{job.status}</td>
										<td>{job.progress_current}/{job.progress_total ?? '-'}</td>
										<td>{job.preview_artifact_ref ?? '-'}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
		{/if}

		{#if canViewCriticalPolicy}
			<section class="panel">
				<div class="section-header">
					<h2>{$LL.admin_admin_logging_critical_protection()}</h2>
					<span>{criticalPolicy?.summary.critical_assignment_count ?? 0}</span>
				</div>
				{#if !criticalPolicy || criticalPolicy.destinations.length === 0}
					<p class="muted">{$LL.admin_admin_logging_no_critical_destinations()}</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>{$LL.admin_admin_logging_destination()}</th>
									<th>{$LL.admin_admin_logging_provider()}</th>
									<th>{$LL.admin_admin_logging_health()}</th>
									<th>{$LL.admin_admin_logging_fallback()}</th>
								</tr>
							</thead>
							<tbody>
								{#each criticalPolicy.destinations as item (item.id)}
									<tr>
										<td>{item.display_name || item.name}</td>
										<td>{item.provider}</td>
										<td>{item.health_status}</td>
										<td>
											{item.default_fallback_eligible
												? $LL.admin_admin_logging_yes()
												: $LL.admin_admin_logging_no()}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
		{/if}

		{#if canViewSensitiveDetailPolicy}
			<section class="panel">
				<div class="section-header">
					<h2>{$LL.admin_admin_logging_sensitive_detail()}</h2>
					<span>{sensitiveDetailPolicy?.summary.assignment_count ?? 0}</span>
				</div>
				{#if !sensitiveDetailPolicy}
					<p class="muted">{$LL.admin_admin_logging_no_sensitive_policy()}</p>
				{:else}
					<div class="stats compact">
						<div class="stat">
							<span>{$LL.admin_admin_logging_chunked()}</span>
							<strong>
								{sensitiveDetailPolicy.summary.chunked
									? $LL.admin_admin_logging_yes()
									: $LL.admin_admin_logging_no()}
							</strong>
						</div>
						<div class="stat">
							<span>{$LL.admin_admin_logging_encrypted()}</span>
							<strong>
								{sensitiveDetailPolicy.summary.encrypted
									? $LL.admin_admin_logging_yes()
									: $LL.admin_admin_logging_no()}
							</strong>
						</div>
						<div class="stat">
							<span>{$LL.admin_admin_logging_stale_keys()}</span>
							<strong>{sensitiveDetailPolicy.summary.stale_key_count}</strong>
						</div>
					</div>
					{#if sensitiveDetailPolicy.index_summary.length === 0}
						<p class="muted">{$LL.admin_admin_logging_no_sensitive_index()}</p>
					{:else}
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th>{$LL.admin_admin_logging_class()}</th>
										<th>{$LL.admin_admin_logging_records_label()}</th>
										<th>{$LL.admin_admin_logging_last_record()}</th>
									</tr>
								</thead>
								<tbody>
									{#each sensitiveDetailPolicy.index_summary as item (item.object_class)}
										<tr>
											<td>{item.object_class}</td>
											<td>{item.total}</td>
											<td>{formatDate(item.last_created_at)}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
					<div class="probe-box">
						<div class="repair-controls">
							<input
								bind:value={sensitiveProbeCatalogId}
								placeholder={$LL.admin_admin_logging_catalog_id_placeholder()}
							/>
							<input
								bind:value={sensitiveProbeTenantId}
								placeholder={$LL.admin_admin_logging_tenant_id_placeholder()}
							/>
							<input
								bind:value={sensitiveProbeObjectClass}
								placeholder={$LL.admin_admin_logging_object_class_placeholder()}
							/>
							<button
								class="btn btn-secondary"
								onclick={runSensitiveProbe}
								disabled={sensitiveProbeLoading ||
									!sensitiveProbeCatalogId.trim() ||
									!canProbeSensitiveDetail}
							>
								{sensitiveProbeLoading
									? $LL.admin_admin_logging_probing()
									: $LL.admin_admin_logging_probe()}
							</button>
						</div>
						{#if sensitiveProbe}
							<div class="detail-grid">
								<span>{$LL.admin_admin_logging_probe_status()} {sensitiveProbe.read_status}</span>
								<span>{$LL.admin_admin_logging_probe_class()} {sensitiveProbe.object_class}</span>
								<span>
									{$LL.admin_admin_logging_probe_key_version()}
									{sensitiveProbe.key_version}
								</span>
								<span>
									{$LL.admin_admin_logging_probe_adapter()}
									{sensitiveProbe.adapter_binding}
								</span>
								<span>{$LL.admin_admin_logging_probe_line()} {sensitiveProbe.line_number}</span>
								<span
									>{$LL.admin_admin_logging_probe_bytes()} {sensitiveProbe.byte_length ?? '-'}</span
								>
							</div>
						{/if}
					</div>
				{/if}
			</section>
		{/if}

		{#if canViewSensitiveDetailPolicy}
			<section class="panel">
				<div class="section-header">
					<h2>{$LL.admin_admin_logging_key_registry()}</h2>
					<div class="inline-actions">
						<input type="number" min="1" max="100" bind:value={rewrapCreateLimit} />
						<span>{keyRegistryItems.length}</span>
					</div>
				</div>
				{#if keyRegistryItems.length === 0}
					<p class="muted">{$LL.admin_admin_logging_no_key_registry()}</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>{$LL.admin_admin_logging_scope()}</th>
									<th>{$LL.admin_admin_logging_active()}</th>
									<th>{$LL.admin_admin_logging_version()}</th>
									<th>{$LL.admin_admin_logging_status()}</th>
									<th>{$LL.admin_admin_logging_usage()}</th>
									<th>{$LL.admin_admin_logging_stale()}</th>
									<th>{$LL.admin_admin_logging_actions()}</th>
								</tr>
							</thead>
							<tbody>
								{#each keyRegistryItems as item (item.id)}
									<tr>
										<td>{item.log_type}:{item.plane}</td>
										<td>{item.active_version}</td>
										<td>{item.version ?? '-'}</td>
										<td>{item.version_status ?? item.registry_status}</td>
										<td>{item.usage_count}</td>
										<td>{item.stale_count}</td>
										<td>
											<div class="row-actions">
												<button
													class="btn btn-secondary"
													onclick={() => loadKeyImpact(item)}
													disabled={keyActionId === item.id}
												>
													{$LL.admin_admin_logging_impact()}
												</button>
												<button
													class="btn btn-secondary"
													onclick={() => createRewrapJobs(item)}
													disabled={keyActionId === item.id ||
														item.version === null ||
														!canRunCatalogRepair}
												>
													{$LL.admin_admin_logging_queue_rewrap()}
												</button>
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if keyImpact}
						<pre class="summary-preview">{JSON.stringify(
								{
									registry: keyImpact.registry,
									versions: keyImpact.versions,
									rewrap_jobs: keyImpact.rewrap_jobs
								},
								null,
								2
							)}</pre>
					{/if}
				{/if}
			</section>
		{/if}

		{#if canReadMessageJobs}
			<section class="panel">
				<div class="section-header">
					<h2>{$LL.admin_admin_logging_message_jobs()}</h2>
					<span>{messageJobs.length}</span>
				</div>
				{#if messageJobs.length === 0}
					<p class="muted">{$LL.admin_admin_logging_no_message_jobs()}</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>{$LL.admin_admin_logging_created()}</th>
									<th>{$LL.admin_admin_logging_kind()}</th>
									<th>{$LL.admin_admin_logging_status()}</th>
									<th>{$LL.admin_admin_logging_lane()}</th>
									<th>{$LL.admin_admin_logging_source()}</th>
									<th>{$LL.admin_admin_logging_error()}</th>
								</tr>
							</thead>
							<tbody>
								{#each messageJobs as job (job.id)}
									<tr>
										<td>{formatDate(job.created_at)}</td>
										<td>{job.kind}</td>
										<td>{job.status}</td>
										<td>{job.lane}</td>
										<td>{job.source_type}:{job.source_id}</td>
										<td>{job.last_error ?? job.blocked_reason ?? '-'}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
		{/if}

		{#if canReadCatalogRepair}
			<section class="panel">
				<div class="section-header">
					<h2>{$LL.admin_admin_logging_rewrap_jobs()}</h2>
					<span>{rewrapJobs.length}</span>
				</div>
				{#if rewrapJobs.length === 0}
					<p class="muted">{$LL.admin_admin_logging_no_rewrap_jobs()}</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>{$LL.admin_admin_logging_status()}</th>
									<th>{$LL.admin_admin_logging_scope()}</th>
									<th>{$LL.admin_admin_logging_version()}</th>
									<th>{$LL.admin_admin_logging_priority()}</th>
									<th>{$LL.admin_admin_logging_object()}</th>
									<th>{$LL.admin_admin_logging_created()}</th>
									<th>{$LL.admin_admin_logging_actions()}</th>
								</tr>
							</thead>
							<tbody>
								{#each rewrapJobs as job (job.id)}
									<tr>
										<td>{job.status}</td>
										<td>{job.log_type ?? '-'}:{job.plane ?? '-'}</td>
										<td>{job.from_version} -> {job.to_version}</td>
										<td>
											<div class="priority-control">
												<input
													type="number"
													min="0"
													max="1000"
													value={rewrapPriorityFor(job)}
													disabled={job.status !== 'queued' || rewrapJobActionId === job.id}
													oninput={(event) =>
														(rewrapPriorityInputs = {
															...rewrapPriorityInputs,
															[job.id]: Number((event.currentTarget as HTMLInputElement).value)
														})}
												/>
												<button
													class="btn btn-secondary btn-small"
													onclick={() => updateRewrapJobPriority(job)}
													disabled={job.status !== 'queued' ||
														rewrapJobActionId === job.id ||
														rewrapPriorityFor(job) === job.priority ||
														!canRunCatalogRepair}
												>
													{$LL.admin_admin_logging_set()}
												</button>
											</div>
										</td>
										<td>{job.object_catalog_id ?? '-'}</td>
										<td>{formatDate(job.created_at)}</td>
										<td>
											<div class="row-actions">
												<button
													class="btn btn-secondary btn-small"
													onclick={() => retryRewrapJob(job)}
													disabled={!['failed', 'skipped'].includes(job.status) ||
														rewrapJobActionId === job.id ||
														!canRunCatalogRepair}
												>
													{$LL.admin_admin_logging_retry()}
												</button>
												<button
													class="btn btn-danger btn-small"
													onclick={() => cancelRewrapJob(job)}
													disabled={!['queued', 'running', 'failed'].includes(job.status) ||
														rewrapJobActionId === job.id ||
														!canRunCatalogRepair}
												>
													{$LL.admin_admin_logging_cancel()}
												</button>
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
		{/if}

		<section class="panel">
			<div class="section-header">
				<h2>{$LL.admin_admin_logging_recent_critical_changes()}</h2>
				<span>{overview.recent_changes.length}</span>
			</div>
			{#if overview.recent_changes.length === 0}
				<p class="muted">{$LL.admin_admin_logging_no_recent_critical_changes()}</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>{$LL.admin_admin_logging_action()}</th>
								<th>{$LL.admin_admin_logging_resource()}</th>
								<th>{$LL.admin_admin_logging_severity()}</th>
								<th>{$LL.admin_admin_logging_actor()}</th>
								<th>{$LL.admin_admin_logging_time()}</th>
							</tr>
						</thead>
						<tbody>
							{#each overview.recent_changes as item (item.audit_id)}
								<tr>
									<td>{item.action}</td>
									<td>{item.resource_type ?? '-'}:{item.resource_id ?? '-'}</td>
									<td>{item.severity}</td>
									<td>{item.actor_id ?? '-'}</td>
									<td>{formatDate(item.created_at)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<section class="panel">
			<div class="section-header">
				<h2>{$LL.admin_admin_logging_archive_chunks()}</h2>
				<span>{overview.archive.length}</span>
			</div>
			{#if overview.archive.length === 0}
				<p class="muted">{$LL.admin_admin_logging_no_archive_chunks()}</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>{$LL.admin_admin_logging_log_type()}</th>
								<th>{$LL.admin_admin_logging_plane()}</th>
								<th>{$LL.admin_admin_logging_status()}</th>
								<th>{$LL.admin_admin_logging_chunks()}</th>
								<th>{$LL.admin_admin_logging_records_label()}</th>
							</tr>
						</thead>
						<tbody>
							{#each overview.archive as item (`${item.log_type}:${item.plane}:${item.status}`)}
								<tr>
									<td>{item.log_type}</td>
									<td>{item.plane}</td>
									<td>{item.status}</td>
									<td>{item.chunks ?? 0}</td>
									<td>{item.records ?? 0}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<section class="panel">
			<div class="section-header">
				<h2>{$LL.admin_admin_logging_delivery_health()}</h2>
				<span>{overview.delivery.length}</span>
			</div>
			{#if overview.delivery.length === 0}
				<p class="muted">{$LL.admin_admin_logging_no_delivery_events()}</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>{$LL.admin_admin_logging_lane()}</th>
								<th>{$LL.admin_admin_logging_status()}</th>
								<th>{$LL.admin_admin_logging_total()}</th>
							</tr>
						</thead>
						<tbody>
							{#each overview.delivery as item (`${item.lane}:${item.status}`)}
								<tr>
									<td>{item.lane}</td>
									<td>{item.status}</td>
									<td>{item.total}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/if}
</div>

<DangerConfirmationModal
	open={Boolean(dangerConfirmation)}
	title={dangerConfirmation?.title ?? ''}
	resourceName={dangerConfirmation?.resourceName ?? ''}
	phrase={dangerConfirmation?.phrase ?? ''}
	confirmLabel={dangerConfirmation?.confirmLabel ?? $LL.admin_admin_logging_confirm()}
	onConfirm={confirmDangerConfirmation}
	onCancel={cancelDangerConfirmation}
/>

<style>
	.admin-page {
		padding: 2rem;
	}

	.page-header {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: flex-start;
		margin-bottom: 1.5rem;
	}

	.page-title {
		margin: 0;
		font-size: 1.875rem;
	}

	.page-description,
	.muted {
		color: var(--color-text-secondary, #64748b);
	}

	.page-actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.stats.compact {
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
	}

	.stat,
	.panel {
		border: 1px solid var(--color-border, #e2e8f0);
		border-radius: 8px;
		background: var(--color-surface, #fff);
	}

	.stat {
		padding: 1rem;
	}

	.stat span {
		display: block;
		color: var(--color-text-secondary, #64748b);
		font-size: 0.875rem;
	}

	.stat strong {
		display: block;
		margin-top: 0.375rem;
		font-size: 1.25rem;
	}

	.panel {
		margin-bottom: 1rem;
		padding: 1rem;
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.section-header h2 {
		margin: 0;
		font-size: 1rem;
	}

	.inline-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.repair-controls,
	.row-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}

	.priority-control {
		display: grid;
		grid-template-columns: 80px auto;
		gap: 0.5rem;
		align-items: center;
	}

	.priority-control input {
		min-height: 2rem;
	}

	.repair-controls {
		margin-bottom: 0.75rem;
	}

	.repair-controls input,
	.repair-controls select {
		min-height: 2.25rem;
	}

	.probe-box {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border, #e2e8f0);
	}

	.detail-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.5rem;
		color: var(--color-text-secondary, #64748b);
	}

	.table-wrap {
		overflow-x: auto;
	}

	.danger-preview {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		margin-top: 0.75rem;
		color: #991b1b;
	}

	.summary-preview {
		margin: 0.75rem 0 0;
		overflow: auto;
		border: 1px solid var(--color-border, #e2e8f0);
		border-radius: 6px;
		padding: 0.75rem;
		background: #f8fafc;
		color: #334155;
		font-size: 0.8125rem;
		white-space: pre-wrap;
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	td {
		text-align: left;
		padding: 0.75rem;
		border-top: 1px solid var(--color-border, #e2e8f0);
	}

	.alert.error {
		margin-bottom: 1rem;
		padding: 0.75rem;
		border-radius: 8px;
		background: #fef2f2;
		color: #991b1b;
	}
</style>
