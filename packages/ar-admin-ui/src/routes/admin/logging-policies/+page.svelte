<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import {
		adminLoggingControlAPI,
		type LoggingDeliveryEvent,
		type LoggingDeliverySummaryItem,
		type LoggingDlqItem,
		type LoggingExportJob,
		type LoggingMessageJob,
		type LoggingMessageRepairFinding,
		type LoggingNotificationEvent,
		type LoggingPolicyDraft,
		type LoggingPoliciesOverview,
		type LoggingRuntimeResolution,
		type LoggingRuntimeTopology,
		type LoggingRuntimeVerification,
		type LoggingUsageSummary,
		type LoggingDlqBulkReplayPreview,
		type LoggingExportFormat,
		type TenantDatabaseRuntimeHealth,
		type TenantDatabaseProbeResult,
		type LoggingUsageAggregate,
		type LoggingQuotaPolicy,
		type LoggingQuotaEvaluation
	} from '$lib/api/admin-logging-control';
	import DangerConfirmationModal from '$lib/components/admin/DangerConfirmationModal.svelte';

	type DangerConfirmationRequest = {
		title: string;
		resourceName: string;
		phrase: string;
		confirmLabel: string;
		resolve: (value: string | null) => void;
	};

	let policies = $state<LoggingPoliciesOverview | null>(null);
	let deliverySummary = $state<LoggingDeliverySummaryItem[]>([]);
	let deliveryEvents = $state<LoggingDeliveryEvent[]>([]);
	let dlqItems = $state<LoggingDlqItem[]>([]);
	let notifications = $state<LoggingNotificationEvent[]>([]);
	let messageJobs = $state<LoggingMessageJob[]>([]);
	let selectedMessageJob = $state<LoggingMessageJob | null>(null);
	let messageRepairFindings = $state<LoggingMessageRepairFinding[]>([]);
	let loading = $state(true);
	let deliveryLoading = $state(false);
	let dlqLoading = $state(false);
	let messageJobsLoading = $state(false);
	let deliveryEventsLoaded = $state(false);
	let dlqItemsLoaded = $state(false);
	let messageJobsLoaded = $state(false);
	let dlqActionId = $state<string | null>(null);
	let notificationActionId = $state<string | null>(null);
	let messageJobActionId = $state<string | null>(null);
	let messageRepairActionId = $state<string | null>(null);
	let error = $state('');
	let tenantId = $state('');
	let statusFilter = $state('');
	let messageJobKindFilter = $state('');
	let messageJobStatusFilter = $state('');
	let messageJobSourceIdFilter = $state('');
	let deliveryCursor = $state<string | undefined>(undefined);
	let dlqCursor = $state<string | undefined>(undefined);
	let deliveryWindowPreset = $state('24h');
	let activeDeliveryWindowStart = $state(Date.now() - 24 * 60 * 60 * 1000);
	let activeDeliveryStatusFilter = $state('');
	let activeTenantIdFilter = $state('');
	let dlqPayloadPreview = $state<{ id: string; text: string; truncated: boolean } | null>(null);
	let exportTenantKey = $state('');
	let exportLogType = $state('');
	let exportPlane = $state('');
	let exportFormat = $state<LoggingExportFormat>('jsonl');
	let exportJob = $state<LoggingExportJob | null>(null);
	let exportArtifactPreview = $state('');
	let exportLoading = $state(false);
	let snapshotDraft = $state<LoggingPolicyDraft | null>(null);
	let snapshotActionLoading = $state(false);
	let runtimeLogType = $state('audit');
	let runtimePlane = $state('archive');
	let runtimeRegion = $state('');
	let runtimeResolution = $state<LoggingRuntimeResolution | null>(null);
	let runtimeTopology = $state<LoggingRuntimeTopology | null>(null);
	let runtimeVerification = $state<LoggingRuntimeVerification | null>(null);
	let runtimeVerifyScope = $state<'tenant' | 'platform'>('tenant');
	let tenantDbHealth = $state<TenantDatabaseRuntimeHealth | null>(null);
	let tenantDbProbe = $state<TenantDatabaseProbeResult | null>(null);
	let tenantDbHealthRole = $state('');
	let runtimeLoading = $state(false);
	let runtimeVerifyLoading = $state(false);
	let tenantDbHealthLoading = $state(false);
	let tenantDbProbeLoading = $state(false);
	let usageSummary = $state<LoggingUsageSummary | null>(null);
	let usageAggregates = $state<LoggingUsageAggregate[]>([]);
	let quotaPolicies = $state<LoggingQuotaPolicy[]>([]);
	let quotaEvaluations = $state<LoggingQuotaEvaluation[]>([]);
	let usageLoading = $state(false);
	let quotaLoading = $state(false);
	let bulkDlqPreview = $state<LoggingDlqBulkReplayPreview | null>(null);
	let bulkDlqLimit = $state(10);
	let bulkDlqLoading = $state(false);
	let dangerConfirmation = $state<DangerConfirmationRequest | null>(null);
	const PERM_LOGGING_PLATFORM_DEFAULTS_UPDATE = 'admin:logging:platform_defaults:update';
	const PERM_LOGGING_DELIVERY_EVENTS_READ = 'admin:logging:delivery_events:read';
	const PERM_LOGGING_DELIVERY_RETRY = 'admin:logging:delivery:retry';
	const PERM_LOGGING_EXPORT_CREATE = 'admin:logging:exports:create';
	const PERM_LOGGING_SENSITIVE_DETAIL_EXPORT = 'admin:logging:sensitive_detail:export';
	const PERM_LOGGING_DLQ_DELETE = 'admin:logging:dlq:delete';
	const PERM_LOGGING_DLQ_PURGE = 'admin:logging:dlq:purge';
	const PERM_LOGGING_SNAPSHOTS_PUBLISH = 'admin:logging:snapshots:publish';
	const PERM_ADMIN_LOGGING_REPAIR_READ = 'admin:admin_logging:repair:read';
	const PERM_ADMIN_LOGGING_REPAIR_RUN = 'admin:admin_logging:repair:run';
	const PERM_DATABASE_ROUTING_READ = 'admin:database_routing:read';
	const PERM_DATABASE_ROUTING_WRITE = 'admin:database_routing:write';
	const isPlatformAdmin = $derived(Boolean(adminAuth.user?.isPlatformAdmin));
	const canFilterByTenant = $derived(isPlatformAdmin);
	const canManagePlatformLogging = $derived(
		isPlatformAdmin && hasAdminPermission(PERM_LOGGING_PLATFORM_DEFAULTS_UPDATE)
	);
	const canReadDeliveryEvents = $derived(hasAdminPermission(PERM_LOGGING_DELIVERY_EVENTS_READ));
	const canRetryDelivery = $derived(hasAdminPermission(PERM_LOGGING_DELIVERY_RETRY));
	const canCreateExport = $derived(hasAdminPermission(PERM_LOGGING_EXPORT_CREATE));
	const canExportSensitiveDetail = $derived(
		hasAdminPermission(PERM_LOGGING_SENSITIVE_DETAIL_EXPORT)
	);
	const canDeleteDlq = $derived(hasAdminPermission(PERM_LOGGING_DLQ_DELETE));
	const canPurgeDlq = $derived(isPlatformAdmin && hasAdminPermission(PERM_LOGGING_DLQ_PURGE));
	const canPublishSnapshots = $derived(hasAdminPermission(PERM_LOGGING_SNAPSHOTS_PUBLISH));
	const canReadMessageRepair = $derived(hasAdminPermission(PERM_ADMIN_LOGGING_REPAIR_READ));
	const canRunMessageRepair = $derived(hasAdminPermission(PERM_ADMIN_LOGGING_REPAIR_RUN));
	const canReadDatabaseRouting = $derived(hasAdminPermission(PERM_DATABASE_ROUTING_READ));
	const canWriteDatabaseRouting = $derived(hasAdminPermission(PERM_DATABASE_ROUTING_WRITE));

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

	function getDeliveryWindowStart(): number {
		if (deliveryWindowPreset === '1h') return Date.now() - 60 * 60 * 1000;
		if (deliveryWindowPreset === '7d') return Date.now() - 7 * 24 * 60 * 60 * 1000;
		return Date.now() - 24 * 60 * 60 * 1000;
	}

	async function load() {
		loading = true;
		error = '';
		deliveryCursor = undefined;
		dlqCursor = undefined;
		activeDeliveryWindowStart = getDeliveryWindowStart();
		activeDeliveryStatusFilter = statusFilter;
		activeTenantIdFilter = canFilterByTenant ? tenantId.trim() : '';
		try {
			deliveryEventsLoaded = false;
			dlqItemsLoaded = false;
			messageJobsLoaded = false;
			deliveryEvents = [];
			dlqItems = [];
			messageJobs = [];
			selectedMessageJob = null;
			dlqPayloadPreview = null;
			const [policyResponse, summaryResponse, notificationResponse] = await Promise.all([
				adminLoggingControlAPI.getLoggingPolicies(
					canFilterByTenant ? tenantId.trim() || undefined : undefined
				),
				adminLoggingControlAPI.getDeliverySummary({
					tenantId: activeTenantIdFilter || undefined,
					status: activeDeliveryStatusFilter || undefined,
					timeStart: activeDeliveryWindowStart,
					limit: 100
				}),
				adminLoggingControlAPI.listNotifications({
					tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined,
					timeStart: activeDeliveryWindowStart,
					limit: 25
				})
			]);
			policies = policyResponse.item;
			deliverySummary = summaryResponse.item.items;
			notifications = notificationResponse.items;
			messageRepairFindings = [];
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load logging configuration';
			policies = null;
			deliverySummary = [];
			deliveryEvents = [];
			notifications = [];
			messageJobs = [];
			selectedMessageJob = null;
			messageRepairFindings = [];
			dlqItems = [];
			deliveryCursor = undefined;
			dlqCursor = undefined;
			deliveryEventsLoaded = false;
			dlqItemsLoaded = false;
			messageJobsLoaded = false;
		} finally {
			loading = false;
		}
	}

	async function loadMoreDeliveryEvents() {
		if (!deliveryCursor || deliveryLoading || !canReadDeliveryEvents) return;
		deliveryLoading = true;
		error = '';
		try {
			const response = await adminLoggingControlAPI.listDeliveryEvents({
				tenantId: activeTenantIdFilter || undefined,
				status: activeDeliveryStatusFilter || undefined,
				timeStart: activeDeliveryWindowStart,
				cursor: deliveryCursor,
				limit: 50
			});
			deliveryEvents = [...deliveryEvents, ...response.items];
			deliveryCursor = response.page?.next_cursor;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load delivery events';
		} finally {
			deliveryLoading = false;
		}
	}

	async function loadDeliveryEvents() {
		if (deliveryLoading || !canReadDeliveryEvents) return;
		deliveryLoading = true;
		error = '';
		try {
			const response = await adminLoggingControlAPI.listDeliveryEvents({
				tenantId: activeTenantIdFilter || undefined,
				status: activeDeliveryStatusFilter || undefined,
				timeStart: activeDeliveryWindowStart,
				limit: 50
			});
			deliveryEvents = response.items;
			deliveryCursor = response.page?.next_cursor;
			deliveryEventsLoaded = true;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load delivery events';
		} finally {
			deliveryLoading = false;
		}
	}

	async function loadMoreDlqItems() {
		if (!dlqCursor || dlqLoading || !canReadDeliveryEvents) return;
		dlqLoading = true;
		error = '';
		try {
			const response = await adminLoggingControlAPI.listDlqItems({
				tenantId: activeTenantIdFilter || undefined,
				status: 'open',
				timeStart: activeDeliveryWindowStart,
				cursor: dlqCursor,
				limit: 25
			});
			dlqItems = [...dlqItems, ...response.items];
			dlqCursor = response.page?.next_cursor;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load DLQ items';
		} finally {
			dlqLoading = false;
		}
	}

	async function loadDlqItems() {
		if (dlqLoading || !canReadDeliveryEvents) return;
		dlqLoading = true;
		error = '';
		dlqPayloadPreview = null;
		try {
			const response = await adminLoggingControlAPI.listDlqItems({
				tenantId: activeTenantIdFilter || undefined,
				status: 'open',
				timeStart: activeDeliveryWindowStart,
				limit: 25
			});
			dlqItems = response.items;
			dlqCursor = response.page?.next_cursor;
			dlqItemsLoaded = true;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load DLQ items';
		} finally {
			dlqLoading = false;
		}
	}

	async function runDlqAction(item: LoggingDlqItem, action: 'replay' | 'delete' | 'purge') {
		if (dlqActionId) return;
		if (action === 'replay' && !canRetryDelivery) return;
		if (action === 'delete' && !canDeleteDlq) return;
		if (action === 'purge' && !canPurgeDlq) return;
		const confirmation =
			action === 'purge'
				? await requestDangerConfirmation({
						title: 'Purge DLQ Item',
						resourceName: item.id,
						phrase: `PURGE DLQ ${item.id}`,
						confirmLabel: 'Purge'
					})
				: undefined;
		if (action === 'purge' && !confirmation) return;

		dlqActionId = item.id;
		error = '';
		try {
			const response =
				action === 'replay'
					? await adminLoggingControlAPI.replayDlqItem(item.id)
					: action === 'delete'
						? await adminLoggingControlAPI.deleteDlqItem(item.id)
						: await adminLoggingControlAPI.purgeDlqItem(item.id, confirmation ?? '');
			dlqItems = dlqItems.map((current) =>
				current.id === item.id
					? {
							...current,
							status: response.result.status,
							updated_at: response.result.updated_at
						}
					: current
			);
		} catch (err) {
			error = err instanceof Error ? err.message : `Failed to ${action} DLQ item`;
		} finally {
			dlqActionId = null;
		}
	}

	async function previewDlqPayload(item: LoggingDlqItem) {
		if (dlqActionId || !canReadDeliveryEvents) return;
		dlqActionId = item.id;
		error = '';
		try {
			const response = await adminLoggingControlAPI.getDlqItemPayload(item.id, 4096);
			dlqPayloadPreview = {
				id: item.id,
				text: response.item.payload.text_preview,
				truncated: response.item.payload.truncated
			};
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load DLQ payload';
		} finally {
			dlqActionId = null;
		}
	}

	async function resolveNotification(item: LoggingNotificationEvent) {
		if (notificationActionId) return;
		notificationActionId = item.id;
		error = '';
		try {
			const response = await adminLoggingControlAPI.resolveNotification(item.id);
			notifications = notifications.filter((current) => current.id !== response.result.id);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to resolve logging notification';
		} finally {
			notificationActionId = null;
		}
	}

	async function createExport() {
		if (
			exportLoading ||
			!canCreateExport ||
			(exportPlane === 'sensitive_detail' && !canExportSensitiveDetail)
		)
			return;
		exportLoading = true;
		error = '';
		exportArtifactPreview = '';
		try {
			const response = await adminLoggingControlAPI.createLoggingExport({
				format: exportFormat,
				tenant_key: canFilterByTenant ? exportTenantKey.trim() || undefined : undefined,
				tenant_id: canFilterByTenant ? tenantId.trim() || undefined : undefined,
				log_type: exportLogType || undefined,
				plane: exportPlane || undefined,
				time_start: activeDeliveryWindowStart,
				limit: 1000
			});
			exportJob = response.result;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create export';
		} finally {
			exportLoading = false;
		}
	}

	async function refreshExportStatus() {
		if (!exportJob || exportLoading) return;
		exportLoading = true;
		error = '';
		try {
			const response = await adminLoggingControlAPI.getLoggingExport(exportJob.id);
			exportJob = response.item;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to refresh export status';
		} finally {
			exportLoading = false;
		}
	}

	async function loadMessageJobs(sourceId?: string) {
		if (messageJobsLoading || !canReadDeliveryEvents) return;
		messageJobsLoading = true;
		error = '';
		try {
			const response = await adminLoggingControlAPI.listMessageJobs({
				tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined,
				tenantKey: canFilterByTenant ? exportTenantKey.trim() || undefined : undefined,
				kind: (messageJobKindFilter || undefined) as LoggingMessageJob['kind'] | undefined,
				status: messageJobStatusFilter || undefined,
				sourceId: sourceId || messageJobSourceIdFilter.trim() || undefined,
				timeStart: activeDeliveryWindowStart,
				limit: 25
			});
			messageJobs = response.items;
			selectedMessageJob = response.items[0] ?? null;
			messageJobsLoaded = true;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load message jobs';
		} finally {
			messageJobsLoading = false;
		}
	}

	async function loadCurrentExportMessageJobs() {
		if (!exportJob) return;
		await loadMessageJobs(exportJob.id);
	}

	async function cancelMessageJob(item: LoggingMessageJob) {
		if (messageJobActionId || !canCancelMessageJob(item)) return;
		const confirmation = await requestDangerConfirmation({
			title: 'Cancel Message Job',
			resourceName: item.id,
			phrase: `CANCEL MESSAGE JOB ${item.id}`,
			confirmLabel: 'Cancel job'
		});
		if (!confirmation) return;

		messageJobActionId = item.id;
		error = '';
		try {
			const response = await adminLoggingControlAPI.cancelMessageJob(item.id, confirmation);
			messageJobs = messageJobs.map((current) =>
				current.id === item.id ? response.result : current
			);
			if (selectedMessageJob?.id === item.id) {
				selectedMessageJob = response.result;
			}
			if (exportJob?.id === item.source_id) {
				await refreshExportStatus();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to cancel message job';
		} finally {
			messageJobActionId = null;
		}
	}

	async function previewExportArtifact() {
		if (
			!exportJob ||
			exportLoading ||
			exportJob.status !== 'completed' ||
			exportJob.format === 'zip'
		) {
			return;
		}
		exportLoading = true;
		error = '';
		try {
			const text = await adminLoggingControlAPI.getLoggingExportArtifact(exportJob.id);
			exportArtifactPreview = text.slice(0, 2000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load export artifact';
		} finally {
			exportLoading = false;
		}
	}

	async function downloadExportArtifact() {
		if (!exportJob || exportLoading || exportJob.status !== 'completed') return;
		exportLoading = true;
		error = '';
		try {
			const { blob, filename } = await adminLoggingControlAPI.downloadLoggingExportArtifact(
				exportJob.id
			);
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = filename;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to download export artifact';
		} finally {
			exportLoading = false;
		}
	}

	async function loadMessageRepairFindings() {
		if (messageRepairActionId || !canReadDeliveryEvents) return;
		messageRepairActionId = 'load';
		error = '';
		try {
			const response = await adminLoggingControlAPI.listMessageRepairFindings({
				tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined,
				tenantKey: canFilterByTenant ? exportTenantKey.trim() || undefined : undefined,
				status: 'open',
				limit: 25
			});
			messageRepairFindings = response.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load message repair findings';
		} finally {
			messageRepairActionId = null;
		}
	}

	async function applySafeMessageRepair(item: LoggingMessageRepairFinding) {
		if (messageRepairActionId || !canRunMessageRepair) return;
		messageRepairActionId = item.id;
		error = '';
		try {
			await adminLoggingControlAPI.applySafeMessageRepair(item.id);
			messageRepairFindings = messageRepairFindings.filter((current) => current.id !== item.id);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to apply safe message repair';
		} finally {
			messageRepairActionId = null;
		}
	}

	async function applyDangerousMessageRepair(item: LoggingMessageRepairFinding) {
		if (messageRepairActionId || !canReadMessageRepair || !canRunMessageRepair) return;
		messageRepairActionId = item.id;
		error = '';
		try {
			const preview = await adminLoggingControlAPI.previewDangerousMessageRepair(item.id);
			const confirmation = await requestDangerConfirmation({
				title: 'Apply Message Repair',
				resourceName: item.id,
				phrase: preview.item.confirmation,
				confirmLabel: 'Apply'
			});
			if (!confirmation) return;
			await adminLoggingControlAPI.applyDangerousMessageRepair(item.id, confirmation);
			messageRepairFindings = messageRepairFindings.filter((current) => current.id !== item.id);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to apply dangerous message repair';
		} finally {
			messageRepairActionId = null;
		}
	}

	async function createSnapshotDraft() {
		if (snapshotActionLoading || !canPublishSnapshots) return;
		snapshotActionLoading = true;
		error = '';
		snapshotDraft = null;
		try {
			const scopeType = canFilterByTenant && !tenantId.trim() ? 'platform' : 'tenant';
			const response = await adminLoggingControlAPI.createLoggingPolicyDraft({
				scope_type: scopeType,
				scope_id: scopeType === 'platform' ? 'global' : tenantId.trim() || undefined
			});
			snapshotDraft = response.item;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create snapshot draft';
		} finally {
			snapshotActionLoading = false;
		}
	}

	async function publishSnapshotDraft() {
		if (!snapshotDraft || snapshotActionLoading || !canPublishSnapshots) return;
		const confirmation = await requestDangerConfirmation({
			title: 'Publish Logging Policy',
			resourceName: snapshotDraft.id,
			phrase: snapshotDraft.confirmation,
			confirmLabel: 'Publish'
		});
		if (!confirmation) return;

		snapshotActionLoading = true;
		error = '';
		try {
			await adminLoggingControlAPI.publishLoggingPolicyDraft(snapshotDraft.id, {
				expected_version: snapshotDraft.version,
				confirmation
			});
			snapshotDraft = null;
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to publish snapshot draft';
		} finally {
			snapshotActionLoading = false;
		}
	}

	async function resolveRuntime() {
		if (runtimeLoading) return;
		runtimeLoading = true;
		error = '';
		try {
			const [resolutionResponse, topologyResponse] = await Promise.all([
				adminLoggingControlAPI.resolveRuntimeLogging({
					tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined,
					logType: runtimeLogType,
					plane: runtimePlane,
					region: runtimeRegion.trim() || undefined
				}),
				adminLoggingControlAPI.getRuntimeTopology({
					tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined
				})
			]);
			runtimeResolution = resolutionResponse.item;
			runtimeTopology = topologyResponse.item;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to resolve runtime logging';
		} finally {
			runtimeLoading = false;
		}
	}

	async function verifyRuntimeSnapshot() {
		if (runtimeVerifyLoading || !canPublishSnapshots) return;
		runtimeVerifyLoading = true;
		error = '';
		try {
			const response = await adminLoggingControlAPI.verifyRuntimeSnapshot({
				scopeType: runtimeVerifyScope,
				scopeId:
					runtimeVerifyScope === 'platform'
						? 'global'
						: canFilterByTenant
							? tenantId.trim() || undefined
							: undefined
			});
			runtimeVerification = response.item;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to verify runtime snapshot';
		} finally {
			runtimeVerifyLoading = false;
		}
	}

	async function loadTenantDbHealth() {
		if (tenantDbHealthLoading || !canReadDatabaseRouting) return;
		tenantDbHealthLoading = true;
		error = '';
		try {
			const response = await adminLoggingControlAPI.getTenantDatabaseRuntimeHealth({
				tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined,
				role: tenantDbHealthRole || undefined
			});
			tenantDbHealth = response.item;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load tenant database health';
		} finally {
			tenantDbHealthLoading = false;
		}
	}

	async function runTenantDbProbe() {
		if (tenantDbProbeLoading || !canWriteDatabaseRouting) return;
		tenantDbProbeLoading = true;
		error = '';
		try {
			const response = await adminLoggingControlAPI.runTenantDatabaseProbe({
				tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined,
				role: tenantDbHealthRole || undefined
			});
			tenantDbProbe = response.result;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to run tenant database probe';
		} finally {
			tenantDbProbeLoading = false;
		}
	}

	async function loadUsageSummary() {
		if (usageLoading) return;
		usageLoading = true;
		error = '';
		try {
			const [summaryResponse, aggregateResponse] = await Promise.all([
				adminLoggingControlAPI.getUsageSummary({
					tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined,
					tenantKey: canFilterByTenant ? exportTenantKey.trim() || undefined : undefined,
					timeStart: activeDeliveryWindowStart,
					limit: 100
				}),
				adminLoggingControlAPI.listUsageAggregates({
					tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined,
					tenantKey: canFilterByTenant ? exportTenantKey.trim() || undefined : undefined,
					timeStart: activeDeliveryWindowStart,
					windowKind: 'hour',
					limit: 50
				})
			]);
			usageSummary = summaryResponse.item;
			usageAggregates = aggregateResponse.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load usage summary';
		} finally {
			usageLoading = false;
		}
	}

	async function refreshUsageAggregates() {
		if (usageLoading || !canManagePlatformLogging) return;
		usageLoading = true;
		error = '';
		try {
			await adminLoggingControlAPI.refreshUsageAggregates({
				windowKind: 'hour',
				tenantKey: canFilterByTenant ? exportTenantKey.trim() || undefined : undefined,
				tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined
			});
			usageLoading = false;
			await loadUsageSummary();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to refresh usage aggregates';
		} finally {
			usageLoading = false;
		}
	}

	async function loadQuotaState() {
		if (quotaLoading) return;
		quotaLoading = true;
		error = '';
		try {
			const [policyResponse, evaluationResponse] = await Promise.all([
				adminLoggingControlAPI.listQuotaPolicies({ limit: 100 }),
				adminLoggingControlAPI.listQuotaEvaluations({
					tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined,
					limit: 25
				})
			]);
			quotaPolicies = policyResponse.items;
			quotaEvaluations = evaluationResponse.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load quota state';
		} finally {
			quotaLoading = false;
		}
	}

	async function evaluateQuota() {
		if (quotaLoading || !canManagePlatformLogging) return;
		quotaLoading = true;
		error = '';
		try {
			const response = await adminLoggingControlAPI.evaluateQuotaPolicies();
			quotaEvaluations = response.result.evaluations;
			const policyResponse = await adminLoggingControlAPI.listQuotaPolicies({ limit: 100 });
			quotaPolicies = policyResponse.items;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to evaluate quota policies';
		} finally {
			quotaLoading = false;
		}
	}

	async function previewBulkDlqReplay() {
		if (bulkDlqLoading) return;
		bulkDlqLoading = true;
		error = '';
		try {
			const response = await adminLoggingControlAPI.previewBulkDlqReplay({
				tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined,
				tenantKey: canFilterByTenant ? exportTenantKey.trim() || undefined : undefined,
				limit: bulkDlqLimit
			});
			bulkDlqPreview = response.item;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to preview bulk DLQ replay';
		} finally {
			bulkDlqLoading = false;
		}
	}

	async function applyBulkDlqReplay() {
		if (bulkDlqLoading || !bulkDlqPreview || bulkDlqPreview.item_count === 0 || !canRetryDelivery)
			return;
		const confirmation = await requestDangerConfirmation({
			title: 'Bulk Replay DLQ',
			resourceName: `${bulkDlqPreview.item_count} DLQ items`,
			phrase: `REPLAY ${bulkDlqPreview.item_count} DLQ`,
			confirmLabel: 'Replay'
		});
		if (!confirmation) return;

		bulkDlqLoading = true;
		error = '';
		try {
			await adminLoggingControlAPI.applyBulkDlqReplay({
				tenantId: canFilterByTenant ? tenantId.trim() || undefined : undefined,
				tenantKey: canFilterByTenant ? exportTenantKey.trim() || undefined : undefined,
				limit: bulkDlqLimit,
				reason: confirmation
			});
			bulkDlqPreview = null;
			await loadDlqItems();
			await loadMessageJobs();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to apply bulk DLQ replay';
		} finally {
			bulkDlqLoading = false;
		}
	}

	onMount(load);

	function formatDate(timestamp: number | null | undefined): string {
		return timestamp ? new Date(timestamp).toLocaleString() : '-';
	}

	function formatDateText(timestamp: string | null | undefined): string {
		return timestamp ? new Date(timestamp).toLocaleString() : '-';
	}

	function deliveryBatchCount(status: string): number {
		return deliverySummary.reduce(
			(total, item) => total + (item.status === status ? item.batch_count : 0),
			0
		);
	}

	function deliveryRecordCount(status: string): number {
		return deliverySummary.reduce(
			(total, item) => total + (item.status === status ? item.record_count : 0),
			0
		);
	}

	function messageJobIsCancellable(item: LoggingMessageJob): boolean {
		return ['queued', 'retrying', 'claimed', 'running'].includes(item.status);
	}

	function canCancelMessageJob(item: LoggingMessageJob): boolean {
		if (item.kind === 'retry_delivery') return canRetryDelivery;
		if (item.kind === 'export_build') return canCreateExport;
		return canRetryDelivery || canCreateExport;
	}

	function formatJsonPreview(value: Record<string, unknown> | null | undefined): string {
		if (!value) return '-';
		const text = JSON.stringify(value);
		return text.length > 160 ? `${text.slice(0, 160)}...` : text;
	}
</script>

<svelte:head>
	<title>Logging - Authrim</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">Logging</h1>
			<p class="page-description">
				Review log policy assignments, fallbacks, snapshots, and delivery events.
			</p>
		</div>
		<div class="page-actions">
			{#if canFilterByTenant}
				<input bind:value={tenantId} placeholder="tenant id" />
			{/if}
			<select bind:value={deliveryWindowPreset}>
				<option value="1h">Last hour</option>
				<option value="24h">Last 24 hours</option>
				<option value="7d">Last 7 days</option>
			</select>
			<select bind:value={statusFilter}>
				<option value="">Any status</option>
				<option value="queued">Queued</option>
				<option value="delivered">Delivered</option>
				<option value="failed">Failed</option>
				<option value="retrying">Retrying</option>
				<option value="dlq">DLQ</option>
			</select>
			<button class="btn btn-secondary" onclick={load} disabled={loading}>Refresh</button>
		</div>
	</div>

	{#if error}<div class="alert error">{error}</div>{/if}

	<div class="grid">
		<section class="panel">
			<div class="section-header">
				<h2>Assignments</h2>
				<span>{policies?.assignments.length ?? 0}</span>
			</div>
			{#if loading}
				<p class="muted">Loading...</p>
			{:else if !policies || policies.assignments.length === 0}
				<p class="muted">No assignments found.</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Log type</th>
								<th>Plane</th>
								<th>Managed by</th>
								<th>Destination</th>
								<th>Enabled</th>
							</tr>
						</thead>
						<tbody>
							{#each policies.assignments as item (item.id)}
								<tr>
									<td>{item.log_type}</td>
									<td>{item.plane}</td>
									<td>{item.managed_by}</td>
									<td>{item.destination_name ?? item.destination_id}</td>
									<td>{item.enabled ? 'Enabled' : 'Disabled'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<section class="panel">
			<div class="section-header">
				<h2>Fallbacks</h2>
				<span>{policies?.fallbacks.length ?? 0}</span>
			</div>
			{#if !policies || policies.fallbacks.length === 0}
				<p class="muted">No fallback policies found.</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Scope</th>
								<th>Log type</th>
								<th>Mode</th>
								<th>Fallback</th>
							</tr>
						</thead>
						<tbody>
							{#each policies.fallbacks as item (item.id)}
								<tr>
									<td>{item.scope_type}</td>
									<td>{item.log_type}</td>
									<td>{item.failure_mode}</td>
									<td>{item.fallback_destination_id ?? '-'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	</div>

	<section class="panel">
		<div class="section-header">
			<h2>Policy Snapshots</h2>
			<div class="section-actions">
				<span>{policies?.snapshots.length ?? 0}</span>
				<button
					class="btn btn-secondary"
					onclick={createSnapshotDraft}
					disabled={snapshotActionLoading || loading || !canPublishSnapshots}
				>
					{snapshotActionLoading ? 'Working...' : 'Create draft'}
				</button>
			</div>
		</div>
		{#if snapshotDraft}
			<div class="snapshot-draft">
				<div>
					<strong>{snapshotDraft.id}</strong>
					<span>v{snapshotDraft.version}</span>
					<span>compared to v{snapshotDraft.diff.compared_to_version ?? '-'}</span>
				</div>
				<div class="diff-grid">
					<span>A +{snapshotDraft.diff.assignment_added}</span>
					<span>A ~{snapshotDraft.diff.assignment_changed}</span>
					<span>A -{snapshotDraft.diff.assignment_removed}</span>
					<span>F +{snapshotDraft.diff.fallback_added}</span>
					<span>F ~{snapshotDraft.diff.fallback_changed}</span>
					<span>F -{snapshotDraft.diff.fallback_removed}</span>
					<span>D +{snapshotDraft.diff.destination_added}</span>
					<span>D ~{snapshotDraft.diff.destination_changed}</span>
					<span>D -{snapshotDraft.diff.destination_removed}</span>
				</div>
				<button
					class="btn btn-danger"
					onclick={publishSnapshotDraft}
					disabled={snapshotActionLoading || !canPublishSnapshots}
				>
					Publish
				</button>
			</div>
		{/if}
		{#if !policies || policies.snapshots.length === 0}
			<p class="muted">No snapshots found.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Scope</th>
							<th>Version</th>
							<th>Status</th>
							<th>Published</th>
						</tr>
					</thead>
					<tbody>
						{#each policies.snapshots as item (item.id)}
							<tr>
								<td>{item.scope_type}</td>
								<td>{item.version}</td>
								<td>{item.status}</td>
								<td>{formatDate(item.published_at)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="panel">
		<div class="section-header">
			<h2>Runtime Resolver</h2>
			<span>{runtimeResolution?.target_status.target_type ?? '-'}</span>
		</div>
		<div class="export-controls">
			<select bind:value={runtimeLogType}>
				<option value="audit">audit</option>
				<option value="admin_audit">admin_audit</option>
				<option value="security">security</option>
				<option value="diagnostic">diagnostic</option>
				<option value="webhook">webhook</option>
				<option value="job">job</option>
			</select>
			<select bind:value={runtimePlane}>
				<option value="primary">primary</option>
				<option value="archive">archive</option>
				<option value="external_sink">external_sink</option>
				<option value="sensitive_detail" disabled={!canExportSensitiveDetail}
					>sensitive_detail</option
				>
				<option value="diagnostic_detail">diagnostic_detail</option>
				<option value="delivery_event">delivery_event</option>
			</select>
			<input bind:value={runtimeRegion} placeholder="region" />
			<button class="btn btn-secondary" onclick={resolveRuntime} disabled={runtimeLoading}>
				{runtimeLoading ? 'Checking...' : 'Resolve'}
			</button>
			<select bind:value={runtimeVerifyScope} disabled={!canFilterByTenant}>
				<option value="tenant">tenant snapshot</option>
				<option value="platform">platform snapshot</option>
			</select>
			<button
				class="btn btn-secondary"
				onclick={verifyRuntimeSnapshot}
				disabled={runtimeVerifyLoading || !canPublishSnapshots}
			>
				{runtimeVerifyLoading ? 'Verifying...' : 'Verify snapshot'}
			</button>
			<select bind:value={tenantDbHealthRole}>
				<option value="">all DB roles</option>
				<option value="tenant_core">tenant_core</option>
				<option value="tenant_pii">tenant_pii</option>
				<option value="tenant_audit">tenant_audit</option>
				<option value="tenant_custom">tenant_custom</option>
			</select>
			<button
				class="btn btn-secondary"
				onclick={loadTenantDbHealth}
				disabled={tenantDbHealthLoading || !canReadDatabaseRouting}
			>
				{tenantDbHealthLoading ? 'Checking...' : 'Check tenant DB'}
			</button>
			<button
				class="btn btn-secondary"
				onclick={runTenantDbProbe}
				disabled={tenantDbProbeLoading || !canWriteDatabaseRouting}
			>
				{tenantDbProbeLoading ? 'Probing...' : 'Write-read probe'}
			</button>
		</div>
		{#if runtimeResolution}
			<div class="detail-grid">
				<span>resolved: {runtimeResolution.resolved ? 'yes' : 'no'}</span>
				<span>target: {runtimeResolution.target_status.target_type ?? '-'}</span>
				<span>binding: {runtimeResolution.target_status.binding_ref ?? '-'}</span>
				<span
					>configured:
					{runtimeResolution.target_status.binding_configured ? 'yes' : 'no'}</span
				>
			</div>
		{/if}
		{#if runtimeTopology}
			<div class="detail-grid topology-grid">
				{#each Object.entries(runtimeTopology.bindings) as [name, configured] (name)}
					<span>{name}: {configured ? 'yes' : 'no'}</span>
				{/each}
			</div>
		{/if}
		{#if runtimeVerification}
			<div class="detail-grid topology-grid">
				<span>pointer: {runtimeVerification.pointer_status}</span>
				<span>object: {runtimeVerification.object_status}</span>
				<span>snapshot: {runtimeVerification.snapshot_status}</span>
				<span>scope: {runtimeVerification.scope_type}:{runtimeVerification.scope_id}</span>
				{#each Object.entries(runtimeVerification.checks) as [name, passed] (name)}
					<span>{name}: {passed ? 'yes' : 'no'}</span>
				{/each}
			</div>
			<pre class="summary-preview">{JSON.stringify(
					{
						pointer_key: runtimeVerification.pointer_key,
						pointer: runtimeVerification.pointer,
						snapshot: runtimeVerification.snapshot,
						database_latest: runtimeVerification.database_latest
					},
					null,
					2
				)}</pre>
		{/if}
		{#if tenantDbHealth}
			<div class="detail-grid topology-grid">
				<span>tenant: {tenantDbHealth.tenant_id}</span>
				<span>healthy: {tenantDbHealth.summary.healthy ?? 0}</span>
				<span>degraded: {tenantDbHealth.summary.degraded ?? 0}</span>
				<span>failed: {tenantDbHealth.summary.failed ?? 0}</span>
				<span>missing binding: {tenantDbHealth.summary.missing_binding ?? 0}</span>
			</div>
			<div class="table-wrap compact-table">
				<table>
					<thead>
						<tr>
							<th>Role</th>
							<th>State</th>
							<th>Pointer</th>
							<th>Registry</th>
							<th>Provider</th>
							<th>Binding</th>
							<th>Schema</th>
						</tr>
					</thead>
					<tbody>
						{#each tenantDbHealth.items as item (`${item.tenant_id}:${item.role}:${item.shard_group}:${item.generation}`)}
							<tr>
								<td>{item.role}</td>
								<td>{item.health_state}</td>
								<td>{item.pointer_status}</td>
								<td>{item.registry_status}</td>
								<td>{item.provider ?? '-'}</td>
								<td
									>{item.binding_ref ?? item.connection_ref ?? '-'} / {item.binding_configured
										? 'yes'
										: 'no'}</td
								>
								<td>{item.schema_version ?? '-'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
		{#if tenantDbProbe}
			<div class="detail-grid topology-grid">
				<span>probe: {tenantDbProbe.status}</span>
				<span>role: {tenantDbProbe.role}</span>
				<span>latency: {tenantDbProbe.latency_ms}ms</span>
				<span>binding: {tenantDbProbe.binding_ref ?? tenantDbProbe.connection_ref ?? '-'}</span>
				<span>error: {tenantDbProbe.error_class ?? '-'}</span>
			</div>
		{/if}
	</section>

	<section class="panel">
		<div class="section-header">
			<h2>Usage Summary</h2>
			<span>{usageSummary ? usageSummary.catalog.length + usageSummary.delivery.length : 0}</span>
		</div>
		<div class="panel-actions">
			<button class="btn btn-secondary" onclick={loadUsageSummary} disabled={usageLoading}>
				{usageLoading ? 'Loading...' : 'Load usage'}
			</button>
			{#if canManagePlatformLogging}
				<button class="btn btn-secondary" onclick={refreshUsageAggregates} disabled={usageLoading}>
					Refresh aggregates
				</button>
			{/if}
		</div>
		{#if !usageSummary}
			<p class="muted">Usage summary is loaded on demand.</p>
		{:else}
			<div class="health-strip">
				<div>
					<span>Catalog groups</span>
					<strong>{usageSummary.catalog.length}</strong>
				</div>
				<div>
					<span>Delivery groups</span>
					<strong>{usageSummary.delivery.length}</strong>
				</div>
				<div>
					<span>DLQ groups</span>
					<strong>{usageSummary.dlq.length}</strong>
				</div>
				<div>
					<span>Sensitive classes</span>
					<strong>{usageSummary.sensitive_detail.length}</strong>
				</div>
			</div>
			<pre class="summary-preview">{formatJsonPreview({
					catalog: usageSummary.catalog.slice(0, 5),
					delivery: usageSummary.delivery.slice(0, 5),
					dlq: usageSummary.dlq.slice(0, 5),
					sensitive_detail: usageSummary.sensitive_detail.slice(0, 5),
					aggregates: usageAggregates.slice(0, 8)
				})}</pre>
		{/if}
	</section>

	<section class="panel">
		<div class="section-header">
			<h2>Quota</h2>
			<span>{quotaPolicies.length}</span>
		</div>
		<div class="panel-actions">
			<button class="btn btn-secondary" onclick={loadQuotaState} disabled={quotaLoading}>
				{quotaLoading ? 'Loading...' : 'Load quota'}
			</button>
			{#if canManagePlatformLogging}
				<button class="btn btn-secondary" onclick={evaluateQuota} disabled={quotaLoading}>
					Evaluate quota
				</button>
			{/if}
		</div>
		{#if quotaPolicies.length === 0 && quotaEvaluations.length === 0}
			<p class="muted">Quota policy and evaluation state is loaded on demand.</p>
		{:else}
			<div class="table-wrap compact-table">
				<table>
					<thead>
						<tr>
							<th>Scope</th>
							<th>Metric</th>
							<th>Window</th>
							<th>Soft</th>
							<th>Hard</th>
							<th>Mode</th>
						</tr>
					</thead>
					<tbody>
						{#each quotaPolicies as policy (policy.id)}
							<tr>
								<td>{policy.scope_type}:{policy.scope_id}</td>
								<td>{policy.metric_name}</td>
								<td>{policy.window_kind}</td>
								<td>{policy.soft_limit ?? '-'}</td>
								<td>{policy.hard_limit ?? '-'}</td>
								<td>{policy.enforcement_mode}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<pre class="summary-preview">{formatJsonPreview({
					evaluations: quotaEvaluations.slice(0, 10)
				})}</pre>
		{/if}
	</section>

	<section class="panel">
		<div class="section-header">
			<h2>Delivery Summary</h2>
			<span>{deliverySummary.length}</span>
		</div>
		<div class="health-strip">
			<div>
				<span>Delivered</span>
				<strong>{deliveryBatchCount('delivered')}</strong>
				<small>{deliveryRecordCount('delivered')} records</small>
			</div>
			<div>
				<span>Queued</span>
				<strong>{deliveryBatchCount('queued')}</strong>
				<small>{deliveryRecordCount('queued')} records</small>
			</div>
			<div>
				<span>Retrying</span>
				<strong>{deliveryBatchCount('retrying')}</strong>
				<small>{deliveryRecordCount('retrying')} records</small>
			</div>
			<div>
				<span>Failed / DLQ</span>
				<strong>{deliveryBatchCount('failed') + deliveryBatchCount('dlq')}</strong>
				<small>{deliveryRecordCount('failed') + deliveryRecordCount('dlq')} records</small>
			</div>
		</div>
		{#if deliverySummary.length === 0}
			<p class="muted">No aggregate delivery activity found.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Lane</th>
							<th>Status</th>
							<th>Log type</th>
							<th>Batches</th>
							<th>Records</th>
						</tr>
					</thead>
					<tbody>
						{#each deliverySummary as item (`${item.lane}:${item.status}:${item.log_type}:${item.plane}`)}
							<tr>
								<td>{item.lane}</td>
								<td>{item.status}</td>
								<td>{item.log_type}</td>
								<td>{item.batch_count}</td>
								<td>{item.record_count}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="panel">
		<div class="section-header">
			<h2>Exports</h2>
			<span>{exportJob?.status ?? '-'}</span>
		</div>
		<div class="export-controls">
			{#if canFilterByTenant}
				<input bind:value={exportTenantKey} placeholder="tenant key" />
			{/if}
			<select bind:value={exportLogType}>
				<option value="">Any log type</option>
				<option value="audit">audit</option>
				<option value="admin_audit">admin_audit</option>
				<option value="security">security</option>
				<option value="diagnostic">diagnostic</option>
				<option value="webhook">webhook</option>
				<option value="job">job</option>
			</select>
			<select bind:value={exportPlane}>
				<option value="">Any plane</option>
				<option value="primary">primary</option>
				<option value="archive">archive</option>
				<option value="external_sink">external_sink</option>
				<option value="sensitive_detail">sensitive_detail</option>
				<option value="diagnostic_detail">diagnostic_detail</option>
				<option value="delivery_event">delivery_event</option>
			</select>
			<select bind:value={exportFormat}>
				<option value="jsonl">JSONL</option>
				<option value="csv">CSV</option>
				<option value="zip">B-format ZIP</option>
			</select>
			<button
				class="btn btn-secondary"
				onclick={createExport}
				disabled={exportLoading ||
					!canCreateExport ||
					(exportPlane === 'sensitive_detail' && !canExportSensitiveDetail)}
			>
				{exportLoading ? 'Working...' : 'Create export'}
			</button>
		</div>
		{#if exportJob}
			<div class="export-result">
				<div>
					<strong>{exportJob.id}</strong>
					<span>{exportJob.status}</span>
					<span>{exportJob.record_count ?? 0} records</span>
					<span>{exportJob.byte_count ?? 0} bytes</span>
					{#if exportJob.message_job_id}
						<span>{exportJob.message_job_id}</span>
					{/if}
					{#if exportJob.queue_binding}
						<span>{exportJob.queue_binding}</span>
					{/if}
				</div>
				<button class="btn btn-secondary" onclick={refreshExportStatus} disabled={exportLoading}>
					Refresh status
				</button>
				<button
					class="btn btn-secondary"
					onclick={previewExportArtifact}
					disabled={exportLoading || exportJob.status !== 'completed' || exportJob.format === 'zip'}
				>
					Preview artifact
				</button>
				<button
					class="btn btn-secondary"
					onclick={downloadExportArtifact}
					disabled={exportLoading || exportJob.status !== 'completed'}
				>
					Download artifact
				</button>
			</div>
			{#if exportArtifactPreview}
				<pre class="artifact-preview">{exportArtifactPreview}</pre>
			{/if}
		{/if}
	</section>

	<section class="panel">
		<div class="section-header">
			<h2>Message Jobs</h2>
			<span>{messageJobs.length}</span>
		</div>
		<div class="message-job-controls">
			<select bind:value={messageJobKindFilter}>
				<option value="">Any kind</option>
				<option value="retry_delivery">retry_delivery</option>
				<option value="export_build">export_build</option>
			</select>
			<select bind:value={messageJobStatusFilter}>
				<option value="">Any status</option>
				<option value="queued">queued</option>
				<option value="running">running</option>
				<option value="retrying">retrying</option>
				<option value="completed">completed</option>
				<option value="failed">failed</option>
				<option value="dlq">dlq</option>
				<option value="cancelled">cancelled</option>
				<option value="blocked">blocked</option>
			</select>
			<input bind:value={messageJobSourceIdFilter} placeholder="source id" />
			<button
				class="btn btn-secondary"
				onclick={() => loadMessageJobs()}
				disabled={messageJobsLoading || !canReadDeliveryEvents}
			>
				{messageJobsLoading ? 'Loading...' : 'Load jobs'}
			</button>
			{#if exportJob}
				<button
					class="btn btn-secondary"
					onclick={loadCurrentExportMessageJobs}
					disabled={messageJobsLoading || !canReadDeliveryEvents}
				>
					Load export jobs
				</button>
			{/if}
		</div>
		{#if !messageJobsLoaded}
			<p class="muted">Message jobs are loaded on demand.</p>
		{:else if messageJobs.length === 0}
			<p class="muted">No message jobs found.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Created</th>
							<th>Kind</th>
							<th>Status</th>
							<th>Lane</th>
							<th>Source</th>
							<th>Attempts</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each messageJobs as item (item.id)}
							<tr>
								<td>{formatDate(item.created_at)}</td>
								<td>{item.kind}</td>
								<td>{item.status}</td>
								<td>{item.lane}</td>
								<td>{item.source_type}:{item.source_id}</td>
								<td>{item.attempt_count}/{item.max_attempts}</td>
								<td>
									<div class="row-actions">
										<button class="btn btn-secondary" onclick={() => (selectedMessageJob = item)}>
											Details
										</button>
										{#if messageJobIsCancellable(item)}
											<button
												class="btn btn-danger"
												onclick={() => cancelMessageJob(item)}
												disabled={messageJobActionId === item.id || !canCancelMessageJob(item)}
											>
												Cancel
											</button>
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if selectedMessageJob}
				<div class="message-job-detail">
					<div>
						<strong>{selectedMessageJob.id}</strong>
						<span>{selectedMessageJob.kind}</span>
						<span>{selectedMessageJob.status}</span>
						<span>depth {selectedMessageJob.depth}</span>
					</div>
					<div class="detail-grid">
						<span>root: {selectedMessageJob.root_job_id ?? '-'}</span>
						<span>parent: {selectedMessageJob.parent_job_id ?? '-'}</span>
						<span
							>payload: {selectedMessageJob.payload_type} v{selectedMessageJob.payload_schema_version}</span
						>
						<span>topology: {selectedMessageJob.topology_type ?? '-'}</span>
						<span>not before: {formatDate(selectedMessageJob.not_before)}</span>
						<span>expires: {formatDate(selectedMessageJob.expires_at)}</span>
					</div>
					{#if selectedMessageJob.last_error || selectedMessageJob.blocked_reason}
						<p class="muted">
							{selectedMessageJob.last_error ?? selectedMessageJob.blocked_reason}
						</p>
					{/if}
					<pre class="summary-preview">{formatJsonPreview(
							selectedMessageJob.redacted_summary
						)}</pre>
				</div>
			{/if}
		{/if}
	</section>

	<section class="panel">
		<div class="section-header">
			<h2>Message Repairs</h2>
			<span>{messageRepairFindings.length}</span>
		</div>
		<div class="panel-actions">
			<button
				class="btn btn-secondary"
				onclick={loadMessageRepairFindings}
				disabled={messageRepairActionId === 'load' || !canReadDeliveryEvents}
			>
				{messageRepairActionId === 'load' ? 'Loading...' : 'Load findings'}
			</button>
		</div>
		{#if messageRepairFindings.length === 0}
			<p class="muted">No open message repair findings loaded.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Detected</th>
							<th>Severity</th>
							<th>Type</th>
							<th>Job</th>
							<th>Status</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each messageRepairFindings as item (item.id)}
							<tr>
								<td>{formatDate(item.detected_at)}</td>
								<td>{item.severity}</td>
								<td>{item.finding_type}</td>
								<td>{item.message_job_id ?? '-'}</td>
								<td>{item.status}</td>
								<td>
									<div class="row-actions">
										{#if item.safe_action}
											<button
												class="btn btn-secondary"
												onclick={() => applySafeMessageRepair(item)}
												disabled={messageRepairActionId === item.id || !canRunMessageRepair}
											>
												Safe repair
											</button>
										{/if}
										{#if item.dangerous_action}
											<button
												class="btn btn-danger"
												onclick={() => applyDangerousMessageRepair(item)}
												disabled={messageRepairActionId === item.id ||
													!canReadMessageRepair ||
													!canRunMessageRepair}
											>
												Dangerous
											</button>
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="panel">
		<div class="section-header">
			<h2>Delivery Events</h2>
			<span>{deliveryEvents.length}</span>
		</div>
		{#if !deliveryEventsLoaded}
			<button
				class="btn btn-secondary"
				onclick={loadDeliveryEvents}
				disabled={deliveryLoading || !canReadDeliveryEvents}
			>
				{deliveryLoading ? 'Loading...' : 'Load delivery events'}
			</button>
		{:else if deliveryEvents.length === 0}
			<p class="muted">No delivery events found.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Created</th>
							<th>Lane</th>
							<th>Log type</th>
							<th>Status</th>
							<th>Attempts</th>
						</tr>
					</thead>
					<tbody>
						{#each deliveryEvents as item (item.id)}
							<tr>
								<td>{formatDate(item.created_at)}</td>
								<td>{item.lane}</td>
								<td>{item.log_type}</td>
								<td>{item.status}</td>
								<td>{item.attempt_count}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if deliveryCursor}
				<div class="pagination-actions">
					<button
						class="btn btn-secondary"
						onclick={loadMoreDeliveryEvents}
						disabled={deliveryLoading}
					>
						{deliveryLoading ? 'Loading...' : 'Load more'}
					</button>
				</div>
			{/if}
		{/if}
	</section>

	<section class="panel">
		<div class="section-header">
			<h2>Operational Alerts</h2>
			<span>{notifications.length}</span>
		</div>
		{#if notifications.length === 0}
			<p class="muted">No unresolved logging alerts found.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Created</th>
							<th>Severity</th>
							<th>Category</th>
							<th>Event</th>
							<th>Status</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each notifications as item (item.id)}
							<tr>
								<td>{formatDateText(item.created_at)}</td>
								<td>{item.severity}</td>
								<td>{item.category}</td>
								<td>{item.event_type}</td>
								<td>{item.status}</td>
								<td>
									<button
										class="btn btn-secondary"
										onclick={() => resolveNotification(item)}
										disabled={notificationActionId === item.id}
									>
										{notificationActionId === item.id ? 'Resolving...' : 'Resolve'}
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="panel">
		<div class="section-header">
			<h2>DLQ Items</h2>
			<span>{dlqItems.length}</span>
		</div>
		<div class="message-job-controls">
			<input type="number" min="1" max="50" bind:value={bulkDlqLimit} />
			<button
				class="btn btn-secondary"
				onclick={previewBulkDlqReplay}
				disabled={bulkDlqLoading || !canReadDeliveryEvents}
			>
				{bulkDlqLoading ? 'Working...' : 'Preview bulk replay'}
			</button>
			<button
				class="btn btn-danger"
				onclick={applyBulkDlqReplay}
				disabled={bulkDlqLoading ||
					!bulkDlqPreview ||
					bulkDlqPreview.item_count === 0 ||
					!canRetryDelivery}
			>
				Apply bulk replay
			</button>
			{#if bulkDlqPreview}
				<span>{bulkDlqPreview.item_count} items selected</span>
			{/if}
		</div>
		{#if !dlqItemsLoaded}
			<button
				class="btn btn-secondary"
				onclick={loadDlqItems}
				disabled={dlqLoading || !canReadDeliveryEvents}
			>
				{dlqLoading ? 'Loading...' : 'Load DLQ items'}
			</button>
		{:else if dlqItems.length === 0}
			<p class="muted">No open DLQ items found.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Created</th>
							<th>Lane</th>
							<th>Payload</th>
							<th>Status</th>
							<th>Attempts</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each dlqItems as item (item.id)}
							<tr>
								<td>{formatDate(item.created_at)}</td>
								<td>{item.lane}</td>
								<td>{item.payload_type}</td>
								<td>{item.status}</td>
								<td>{item.attempt_count}</td>
								<td>
									<div class="row-actions">
										<button
											class="btn btn-secondary"
											onclick={() => previewDlqPayload(item)}
											disabled={dlqActionId === item.id || !canReadDeliveryEvents}
										>
											Preview
										</button>
										<button
											class="btn btn-secondary"
											onclick={() => runDlqAction(item, 'replay')}
											disabled={dlqActionId === item.id ||
												item.status !== 'open' ||
												!canRetryDelivery}
										>
											Replay
										</button>
										<button
											class="btn btn-secondary"
											onclick={() => runDlqAction(item, 'delete')}
											disabled={dlqActionId === item.id || item.status !== 'open' || !canDeleteDlq}
										>
											Delete
										</button>
										{#if canPurgeDlq}
											<button
												class="btn btn-danger"
												onclick={() => runDlqAction(item, 'purge')}
												disabled={dlqActionId === item.id || item.status !== 'open' || !canPurgeDlq}
											>
												Purge
											</button>
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if dlqCursor}
				<div class="pagination-actions">
					<button class="btn btn-secondary" onclick={loadMoreDlqItems} disabled={dlqLoading}>
						{dlqLoading ? 'Loading...' : 'Load more'}
					</button>
				</div>
			{/if}
			{#if dlqPayloadPreview}
				<div class="payload-preview-header">
					<strong>{dlqPayloadPreview.id}</strong>
					<span>{dlqPayloadPreview.truncated ? 'truncated preview' : 'full preview'}</span>
				</div>
				<pre class="artifact-preview">{dlqPayloadPreview.text}</pre>
			{/if}
		{/if}
	</section>
</div>

<DangerConfirmationModal
	open={Boolean(dangerConfirmation)}
	title={dangerConfirmation?.title ?? ''}
	resourceName={dangerConfirmation?.resourceName ?? ''}
	phrase={dangerConfirmation?.phrase ?? ''}
	confirmLabel={dangerConfirmation?.confirmLabel ?? 'Confirm'}
	onConfirm={confirmDangerConfirmation}
	onCancel={cancelDangerConfirmation}
/>

<style>
	.admin-page {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.page-header {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: flex-start;
	}

	.page-title {
		margin: 0 0 0.25rem;
		font-size: 1.5rem;
	}

	.page-description,
	.muted {
		color: var(--text-secondary);
		margin: 0;
		font-size: 0.875rem;
	}

	.page-actions {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		flex-shrink: 0;
	}

	.page-actions input,
	.page-actions select {
		min-height: 2.25rem;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 1rem;
	}

	.panel {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 1.25rem;
		background: var(--bg-card);
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.section-header h2 {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.section-actions,
	.snapshot-draft,
	.diff-grid,
	.message-job-detail > div:first-child {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.snapshot-draft {
		justify-content: space-between;
		flex-wrap: wrap;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.75rem;
		margin-bottom: 0.75rem;
		background: var(--bg-subtle);
	}

	.snapshot-draft > div:first-child {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
	}

	.diff-grid {
		flex-wrap: wrap;
	}

	.diff-grid span {
		font-variant-numeric: tabular-nums;
		font-size: 0.8125rem;
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 2px 6px;
	}

	.message-job-detail {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.75rem;
		margin-top: 0.75rem;
		background: var(--bg-subtle);
	}

	.message-job-detail > div:first-child {
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}

	.detail-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 0.5rem;
		color: var(--text-secondary);
		font-size: 0.8125rem;
	}

	.topology-grid span {
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.25rem 0.5rem;
	}

	.health-strip {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.health-strip div {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.75rem;
		background: var(--bg-card);
	}

	.health-strip span,
	.health-strip small {
		display: block;
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.health-strip strong {
		display: block;
		margin: 0.25rem 0;
		font-size: 1.25rem;
	}

	.panel-actions {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}

	.table-wrap {
		overflow-x: auto;
	}

	.compact-table th,
	.compact-table td {
		padding: 0.5rem 0.75rem;
		font-size: 0.8125rem;
	}

	.pagination-actions {
		display: flex;
		justify-content: flex-end;
		padding-top: 0.75rem;
	}

	.row-actions {
		display: flex;
		gap: 0.375rem;
		align-items: center;
		flex-wrap: wrap;
	}

	.export-controls,
	.export-result,
	.message-job-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 0.625rem;
		align-items: center;
	}

	.export-controls,
	.message-job-controls {
		margin-bottom: 0.75rem;
		padding: 0.75rem;
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}

	.export-controls input,
	.export-controls select,
	.message-job-controls input,
	.message-job-controls select {
		min-height: 2rem;
		font-size: 0.875rem;
	}

	.export-result {
		justify-content: space-between;
		margin-bottom: 0.75rem;
	}

	.export-result div {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
	}

	.artifact-preview {
		margin: 0.75rem 0 0;
		max-height: 18rem;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.75rem;
		background: #0f172a;
		color: #e2e8f0;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		white-space: pre-wrap;
	}

	.summary-preview {
		margin: 0.75rem 0 0;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.75rem;
		background: var(--bg-subtle);
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		white-space: pre-wrap;
	}

	.payload-preview-header {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
		margin-top: 0.75rem;
	}

	.row-actions .btn {
		min-height: 1.875rem;
		padding: 0 0.5rem;
		font-size: 0.8125rem;
	}

	.btn-danger {
		border: 1px solid rgba(239, 68, 68, 0.3);
		background: rgba(239, 68, 68, 0.08);
		color: #991b1b;
	}

	.btn-danger:hover:not(:disabled) {
		background: rgba(239, 68, 68, 0.14);
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	td {
		text-align: left;
		padding: 0.75rem;
		border-bottom: 1px solid var(--border);
	}

	th {
		color: var(--text-secondary);
		font-size: 0.75rem;
		text-transform: uppercase;
		font-weight: 600;
	}

	.alert.error {
		margin-bottom: 1rem;
		padding: 0.75rem 1rem;
		border-radius: var(--radius-sm);
		background: rgba(239, 68, 68, 0.08);
		color: #991b1b;
		border: 1px solid rgba(239, 68, 68, 0.2);
	}
</style>
