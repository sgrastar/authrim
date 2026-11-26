/**
 * In-memory log platform status for Storybook, tests and the console dev mock. It answers the
 * Admin API's wire format (`item` of `GET /api/admin/admin-logging/platform-status`) in a few
 * recognisable shapes: a healthy pipeline archive, the table that outgrew the read limit (the
 * 2026-11-25 demo incident: compaction never ran), an unconfigured and an unreachable archive, a
 * scheduled-mode archive, and the tenant view without the shared table statistics.
 */
import { ApiError } from '../api-error';
import type { LogPlatformClient, LogPlatformStatus, SafeRepairResult } from '../log-platform';

/** The "now" of the sample data. */
export const LOG_PLATFORM_NOW = Date.UTC(2026, 10, 26, 9, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type LogPlatformScenario =
	| 'healthy'
	| 'over-limit'
	| 'unconfigured'
	| 'unreachable'
	| 'scheduled'
	| 'tenant';

export interface FakeLogPlatformOptions {
	scenario?: LogPlatformScenario;
	/** Milliseconds each call takes. */
	delay?: number;
	/** The status call fails with this HTTP status. */
	fail?: 403 | 500;
	/** The status never answers (to show loading). */
	hang?: boolean;
	/** The safe repair fails. */
	repairFails?: boolean;
	/** How many findings the safe repair reports as applied; defaults to the sampled count. */
	repairApplied?: number;
}

const healthyTable = {
	uuid: '4eb1cd44-3610-4b17-81eb-035776e79fa2',
	snapshot_count: 665,
	current_snapshot: {
		id: '8532431906541772489',
		committed_at: LOG_PLATFORM_NOW - 4 * 60_000,
		operation: 'append',
		total_data_files: 12,
		total_records: 1_732
	},
	last_compaction_at: LOG_PLATFORM_NOW - 22 * HOUR
};

function base(): LogPlatformStatus {
	return {
		generated_at: LOG_PLATFORM_NOW,
		window_start_at: LOG_PLATFORM_NOW - DAY,
		archive: {
			configured: true,
			configuration_error: null,
			mode: 'pipeline',
			generation: 'gen-20261101-a7f3',
			activated_at: Date.UTC(2026, 10, 1, 0, 0, 0),
			local_staging_only: false,
			export_interval_minutes: null,
			reachable: true,
			reachability_error: null,
			table: healthyTable,
			table_size_hint: { max_files: 128, data_files_over_limit: false },
			read_probe: {
				ok: true,
				reason: null,
				has_archive: true,
				coverage: { consistency: 'eventual', pending_deliveries: 0, complete: false }
			}
		},
		delivery: {
			recent: { prepared: 2, published: 1_730, aborted: 0, ingested: 1_728 },
			last_ingested_at: LOG_PLATFORM_NOW - 4 * 60_000,
			oldest_prepared_at: LOG_PLATFORM_NOW - 40_000,
			outbox: {
				pending: 2,
				queued: 0,
				oldest_pending_at: LOG_PLATFORM_NOW - 90_000,
				last_error_code: null
			},
			export: null
		},
		audit_coverage: {
			covered: 41,
			gap_detected: 0,
			acknowledged: 2,
			ignored: 1,
			last_checked_at: LOG_PLATFORM_NOW - 3 * DAY
		},
		chunk_catalog: {
			scan_limit: 200,
			sampled_repair_findings: 0,
			sampled_sensitive_detail_findings: 0,
			sensitive_detail_index: [
				{ store: 'DB_ADMIN', indexed_objects: 17, error: null },
				{ store: 'DB', indexed_objects: null, error: 'index_table_missing' }
			]
		},
		delivery_lanes: [
			{ lane: 'critical', status: 'delivered', total: 96 },
			{ lane: 'default', status: 'delivered', total: 1_410 },
			{ lane: 'default', status: 'retrying', total: 3 },
			{ lane: 'bulk', status: 'delivered', total: 220 },
			{ lane: 'bulk', status: 'failed', total: 1 }
		]
	};
}

/** The status of one scenario. */
export function sampleLogPlatformStatus(
	scenario: LogPlatformScenario = 'healthy'
): LogPlatformStatus {
	const status = base();
	switch (scenario) {
		case 'healthy':
			return status;
		case 'over-limit':
			status.archive.table = {
				...healthyTable,
				snapshot_count: 657,
				current_snapshot: {
					...healthyTable.current_snapshot!,
					total_data_files: 592,
					total_records: 1_732
				},
				last_compaction_at: null
			};
			status.archive.table_size_hint = { max_files: 128, data_files_over_limit: true };
			status.archive.read_probe = {
				ok: false,
				reason: 'archive_file_read_budget_exceeded',
				has_archive: false,
				coverage: null
			};
			status.chunk_catalog.sampled_repair_findings = 3;
			status.chunk_catalog.sampled_sensitive_detail_findings = 2;
			return status;
		case 'unconfigured':
			status.archive = {
				configured: false,
				configuration_error: 'log_iceberg_configuration_required',
				mode: null,
				generation: null,
				activated_at: null,
				local_staging_only: false,
				export_interval_minutes: null,
				reachable: false,
				reachability_error: null,
				table: null,
				table_size_hint: null,
				read_probe: {
					ok: false,
					reason: 'log_iceberg_configuration_required',
					has_archive: false,
					coverage: null
				}
			};
			status.delivery = {
				recent: { prepared: 0, published: 0, aborted: 0, ingested: 0 },
				last_ingested_at: null,
				oldest_prepared_at: null,
				outbox: null,
				export: null
			};
			status.delivery_lanes = [];
			return status;
		case 'unreachable':
			status.archive.reachable = false;
			status.archive.reachability_error = 'iceberg_catalog_http_503';
			status.archive.table = null;
			status.archive.table_size_hint = null;
			status.archive.read_probe = {
				ok: false,
				reason: 'archive_catalog_unavailable',
				has_archive: false,
				coverage: null
			};
			status.delivery.recent = { prepared: 1, published: 1_730, aborted: 0, ingested: 1_675 };
			status.delivery.last_ingested_at = LOG_PLATFORM_NOW - 3 * HOUR - 5 * 60_000;
			status.delivery.outbox = {
				pending: 48,
				queued: 6,
				oldest_pending_at: LOG_PLATFORM_NOW - 3 * HOUR,
				last_error_code: 'stream_timeout'
			};
			return status;
		case 'scheduled':
			status.archive.mode = 'scheduled';
			status.archive.export_interval_minutes = 15;
			status.archive.read_probe.coverage = {
				consistency: 'snapshot',
				pending_deliveries: 0,
				complete: true
			};
			status.delivery.outbox = null;
			status.delivery.recent.ingested = 0;
			status.delivery.last_ingested_at = null;
			status.delivery.export = {
				last_state: 'verified',
				last_error_code: null,
				updated_at: LOG_PLATFORM_NOW - 11 * 60_000,
				active_failure: null,
				oldest_unfinished_at: null,
				oldest_eligible_since: null,
				watermark: {
					snapshot_id: '8532431906541772489',
					minimum_sequence_number: 1_204,
					updated_at: LOG_PLATFORM_NOW - 11 * 60_000
				}
			};
			return status;
		case 'tenant':
			status.archive.table = null;
			status.archive.table_size_hint = null;
			status.delivery.recent = { prepared: 0, published: 212, aborted: 0, ingested: 212 };
			status.delivery.oldest_prepared_at = null;
			status.delivery.last_ingested_at = LOG_PLATFORM_NOW - 9 * 60_000;
			status.delivery.outbox = {
				pending: 0,
				queued: 0,
				oldest_pending_at: null,
				last_error_code: null
			};
			status.chunk_catalog.sensitive_detail_index = [
				{ store: 'DB_ADMIN', indexed_objects: 3, error: null }
			];
			status.delivery_lanes = [
				{ lane: 'critical', status: 'delivered', total: 8 },
				{ lane: 'default', status: 'delivered', total: 190 }
			];
			return status;
	}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFakeLogPlatform(options: FakeLogPlatformOptions = {}): LogPlatformClient {
	const scenario = options.scenario ?? 'healthy';
	let status = sampleLogPlatformStatus(scenario);
	return {
		async status() {
			if (options.delay) await wait(options.delay);
			if (options.hang) await new Promise(() => {});
			if (options.fail) {
				throw new ApiError(
					options.fail,
					options.fail === 403 ? 'forbidden' : 'server_error',
					'Could not read the status'
				);
			}
			return structuredClone(status);
		},
		async applySafeRepairs(scanLimit): Promise<SafeRepairResult> {
			if (options.delay) await wait(options.delay);
			if (options.repairFails) throw new ApiError(500, 'server_error', 'Repair failed');
			// The real detector looks at `scanLimit` rows; the sample has fewer findings than that.
			const findings = Math.min(status.chunk_catalog.sampled_repair_findings, scanLimit);
			const applied = Math.min(options.repairApplied ?? findings, findings);
			status = structuredClone(status);
			status.chunk_catalog.sampled_repair_findings = findings - applied;
			status.chunk_catalog.sampled_sensitive_detail_findings = Math.min(
				status.chunk_catalog.sampled_sensitive_detail_findings,
				findings - applied
			);
			return {
				checked_at: LOG_PLATFORM_NOW,
				finding_count: findings,
				applied_count: applied,
				skipped_count: findings - applied
			};
		}
	};
}
