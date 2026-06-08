import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function readRoute(relativePath: string): string {
	const path = fileURLToPath(new URL(`../../../routes/${relativePath}`, import.meta.url));
	return readFileSync(path, 'utf8');
}

function readApi(relativePath: string): string {
	const path = fileURLToPath(new URL(`../../api/${relativePath}`, import.meta.url));
	return readFileSync(path, 'utf8');
}

describe('logging/storage admin UI smoke checks', () => {
	it('keeps the canonical storage, logging, and admin logging routes present', () => {
		expect(readRoute('admin/storage-destinations/+page.svelte')).toContain(
			'adminLoggingControlAPI'
		);
		expect(readRoute('admin/logging-policies/+page.svelte')).toContain('getLoggingPolicies');
		expect(readRoute('admin/admin-logging/+page.svelte')).toContain('getAdminLoggingOverview');
	});

	it('keeps dangerous logging operations behind the shared confirmation modal', () => {
		const loggingPolicies = readRoute('admin/logging-policies/+page.svelte');
		const storageDestinations = readRoute('admin/storage-destinations/+page.svelte');
		const adminLogging = readRoute('admin/admin-logging/+page.svelte');
		const dangerModal = readFileSync(
			fileURLToPath(
				new URL('../../components/admin/DangerConfirmationModal.svelte', import.meta.url)
			),
			'utf8'
		);

		expect(loggingPolicies).toContain('DangerConfirmationModal');
		expect(loggingPolicies).toContain('purgeDlqItem');
		expect(storageDestinations).toContain('DangerConfirmationModal');
		expect(storageDestinations).toContain('disableDestination');
		expect(adminLogging).toContain('DangerConfirmationModal');
		expect(dangerModal).toContain('value.trim() !== phrase');
		expect(dangerModal).toContain('confirmation === phrase');
	});

	it('shows storage destination usage and retention details without route aliases', () => {
		const storageDestinations = readRoute('admin/storage-destinations/+page.svelte');

		expect(storageDestinations).toContain('getDestination');
		expect(storageDestinations).toContain('retention_days');
		expect(storageDestinations).toContain('admin_storage_destinations_allowed_log_types');
		expect(storageDestinations).toContain('admin_storage_destinations_allowed_planes');
		expect(storageDestinations).toContain('admin_storage_destinations_capabilities');
		expect(storageDestinations).toContain('detail-drawer');
		expect(storageDestinations).toContain('admin_storage_destinations_create_platform');
		expect(storageDestinations).toContain("scope_type: 'platform'");
		expect(storageDestinations).toContain('previewDestinationDiff');
	});

	it('uses canonical DLQ list and replay API routes', () => {
		const loggingControlApi = readApi('admin-logging-control.ts');

		expect(loggingControlApi).toContain('/api/admin/logging-policies/dlq`');
		expect(loggingControlApi).toContain(
			'/api/admin/logging-policies/dlq/${encodeURIComponent(id)}/replay'
		);
	});

	it('keeps logging operations visible without loading detail-heavy panels up front', () => {
		const loggingPolicies = readRoute('admin/logging-policies/+page.svelte');
		const loggingControlApi = readApi('admin-logging-control.ts');

		expect(loggingPolicies).toContain('getDeliverySummary');
		expect(loggingPolicies).toContain('loadDeliveryEvents');
		expect(loggingPolicies).toContain('loadDlqItems');
		expect(loggingPolicies).toContain('createLoggingExport');
		expect(loggingPolicies).toContain('refreshExportStatus');
		expect(loggingPolicies).toContain("exportJob.status !== 'completed'");
		expect(loggingPolicies).toContain('loadMessageJobs');
		expect(loggingPolicies).toContain('cancelMessageJob');
		expect(loggingPolicies).toContain('resolveNotification');
		expect(loggingPolicies).toContain('verifyRuntimeSnapshot');
		expect(loggingPolicies).toContain('loadTenantDbHealth');
		expect(loggingPolicies).toContain('runTenantDbProbe');
		expect(loggingPolicies).toContain('refreshUsageAggregates');
		expect(loggingPolicies).toContain('evaluateQuota');
		expect(loggingPolicies).toContain('health-strip');
		expect(loggingControlApi).toContain('/api/admin/logging-policies/delivery-summary');
		expect(loggingControlApi).toContain('/api/admin/logging-policies/delivery-events');
		expect(loggingControlApi).toContain('/api/admin/logging-policies/exports');
		expect(loggingControlApi).toContain('/api/admin/logging-policies/message-jobs');
		expect(loggingControlApi).toContain('/api/admin/logging-policies/notifications');
		expect(loggingControlApi).toContain('/api/admin/logging-policies/runtime/verify');
		expect(loggingControlApi).toContain('/api/admin/logging-policies/runtime/tenant-db-health');
		expect(loggingControlApi).toContain('/api/admin/logging-policies/runtime/tenant-db-probe');
		expect(loggingControlApi).toContain('/api/admin/logging-policies/usage-aggregates');
		expect(loggingControlApi).toContain('/api/admin/logging-policies/quota-policies');
	});

	it('keeps the Notification Center wired to the cross-domain notification API', () => {
		const notificationCenter = readRoute('admin/notifications/+page.svelte');
		const loggingControlApi = readApi('admin-logging-control.ts');

		expect(notificationCenter).toContain('admin_notifications_title');
		expect(notificationCenter).toContain('listNotificationCenter');
		expect(notificationCenter).toContain('resolveNotificationCenterEvent');
		expect(notificationCenter).toContain('runNotificationDelivery');
		expect(notificationCenter).toContain('deliverNotificationCenterEvent');
		expect(loggingControlApi).toContain('/api/admin/notifications');
		expect(loggingControlApi).toContain(
			'/api/admin/notifications/${encodeURIComponent(id)}/resolve'
		);
		expect(loggingControlApi).toContain('/api/admin/notifications/delivery-routes');
		expect(loggingControlApi).toContain('/api/admin/notifications/delivery/run');
	});

	it('keeps admin logging coverage, critical policy, sensitive detail, key, and repair panels wired', () => {
		const adminLogging = readRoute('admin/admin-logging/+page.svelte');
		const loggingControlApi = readApi('admin-logging-control.ts');

		expect(adminLogging).toContain('checkCoverage');
		expect(adminLogging).toContain('applySafeRepairs');
		expect(adminLogging).toContain('scanCatalogRepairJob');
		expect(adminLogging).toContain('applySafeRepairJob');
		expect(adminLogging).toContain('applyDangerousDeleteObject');
		expect(adminLogging).toContain('criticalPolicy');
		expect(adminLogging).toContain('sensitiveDetailPolicy');
		expect(adminLogging).toContain('keyRegistryItems');
		expect(adminLogging).toContain('rewrapJobs');
		expect(adminLogging).toContain('retryRewrapJob');
		expect(adminLogging).toContain('cancelRewrapJob');
		expect(adminLogging).toContain('updateRewrapJobPriority');
		expect(adminLogging).toContain('messageJobs');
		expect(loggingControlApi).toContain('/api/admin/admin-logging/coverage/check');
		expect(loggingControlApi).toContain('/api/admin/admin-logging/critical-policy');
		expect(loggingControlApi).toContain('/api/admin/admin-logging/sensitive-detail-policy');
		expect(loggingControlApi).toContain('/api/admin/admin-logging/key-registry');
		expect(loggingControlApi).toContain('/api/admin/admin-logging/rewrap-jobs');
		expect(loggingControlApi).toContain('/retry');
		expect(loggingControlApi).toContain('/cancel');
		expect(loggingControlApi).toContain('/priority');
		expect(loggingControlApi).toContain('/api/admin/logging-policies/message-jobs');
		expect(loggingControlApi).toContain('/api/admin/admin-logging/catalog-repairs');
		expect(loggingControlApi).toContain('/api/admin/admin-logging/catalog-repair-jobs');
	});
});
