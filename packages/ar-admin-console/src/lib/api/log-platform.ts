/**
 * Monitoring → Log platform: one read that says whether the log platform is healthy
 * (`GET /api/admin/admin-logging/platform-status`, `admin:admin_logging:overview:read`) and the
 * one safe action on it, the automatic repair of the chunk catalog
 * (`POST /api/admin/admin-logging/catalog-repairs/apply-safe`, `admin:admin_logging:repair:run`).
 *
 * The status never answers 503: a broken archive is what the page is for. Whether the ordinary
 * log read path works is inside it (`archive.read_probe`), with the reason when it does not.
 * The table's own statistics are shared by every tenant, so the API hands them only to a
 * platform caller; a tenant administrator gets `archive.table: null`.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { stepUpHeaders, withStepUp } from './admin-step-up';
import { errorFromResponse } from './api-error';

export type LogArchiveMode = 'pipeline' | 'scheduled';
export type LogReadConsistency = 'eventual' | 'snapshot' | 'local_hot_only';

export interface LogPlatformSnapshot {
	id: string;
	/** Epoch milliseconds. */
	committed_at: number;
	/** `append`, `replace` (a compaction), … or null when the snapshot has no summary. */
	operation: string | null;
	total_data_files: number | null;
	total_records: number | null;
}

export interface LogPlatformReadProbe {
	/** A 24-hour read of the admin audit log through the ordinary read path completed. */
	ok: boolean;
	/** The `log_query_incomplete` reason when it did not. */
	reason: string | null;
	has_archive: boolean;
	coverage: {
		consistency: LogReadConsistency;
		pending_deliveries: number | null;
		complete: boolean;
	} | null;
}

export interface LogPlatformArchive {
	configured: boolean;
	configuration_error: string | null;
	mode: LogArchiveMode | null;
	generation: string | null;
	activated_at: number | null;
	local_staging_only: boolean;
	reachable: boolean;
	reachability_error: string | null;
	/** Platform callers only. */
	table: {
		uuid: string;
		snapshot_count: number;
		current_snapshot: LogPlatformSnapshot | null;
		last_compaction_at: number | null;
	} | null;
	/** Platform callers only; a heuristic, `read_probe` is the real answer. */
	table_size_hint: { max_files: number; data_files_over_limit: boolean } | null;
	read_probe: LogPlatformReadProbe;
}

export interface LogPlatformDelivery {
	publications: { prepared: number; published: number; aborted: number };
	outbox: {
		pending: number;
		queued: number;
		oldest_pending_at: number | null;
		last_error_code: string | null;
	} | null;
	export: {
		last_state: string | null;
		last_error_code: string | null;
		updated_at: number | null;
		watermark: { snapshot_id: string; minimum_sequence_number: number; updated_at: number } | null;
	} | null;
}

export interface LogPlatformCoverage {
	covered: number;
	gap_detected: number;
	acknowledged: number;
	ignored: number;
	last_checked_at: number | null;
}

export interface LogPlatformChunkCatalog {
	scan_limit: number;
	sampled_repair_findings: number;
	sampled_sensitive_detail_findings: number;
	sensitive_detail_index: {
		store: string;
		indexed_objects: number | null;
		error: 'index_table_missing' | 'index_unavailable' | null;
	}[];
}

export interface LogPlatformLane {
	lane: string;
	status: string;
	total: number;
}

/** The status, as the Admin API returns it (`item` of the detail envelope). */
export interface LogPlatformStatus {
	generated_at: number;
	window_start_at: number;
	archive: LogPlatformArchive;
	delivery: LogPlatformDelivery;
	audit_coverage: LogPlatformCoverage;
	chunk_catalog: LogPlatformChunkCatalog;
	delivery_lanes: LogPlatformLane[];
}

/** What the safe repair did (`item` of the action envelope). */
export interface SafeRepairResult {
	checked_at: number;
	finding_count: number;
	applied_count: number;
	skipped_count: number;
}

export interface LogPlatformClient {
	status(signal?: AbortSignal): Promise<LogPlatformStatus>;
	/**
	 * Applies every finding the detector marks safe, scanning as many catalog rows as the status
	 * did (`scan_limit`) so the action reaches what the page showed; the server may ask for a
	 * step-up first.
	 */
	applySafeRepairs(scanLimit: number): Promise<SafeRepairResult>;
}

const BASE = `${API_BASE_URL}/api/admin/admin-logging`;

export const httpLogPlatform: LogPlatformClient = {
	async status(signal) {
		const response = await adminFetch(`${BASE}/platform-status`, { signal });
		if (!response.ok) throw await errorFromResponse(response);
		const body = (await response.json()) as { item: LogPlatformStatus };
		return body.item;
	},
	applySafeRepairs(scanLimit) {
		return withStepUp(async (receipt) => {
			const response = await adminFetch(`${BASE}/catalog-repairs/apply-safe`, {
				method: 'POST',
				headers: stepUpHeaders(receipt),
				body: JSON.stringify({ limit: scanLimit }),
				includeJsonContentType: true
			});
			if (!response.ok) throw await errorFromResponse(response);
			const body = (await response.json()) as { item: SafeRepairResult };
			return body.item;
		});
	}
};
