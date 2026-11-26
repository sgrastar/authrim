/**
 * What the Log platform page concludes from the status: one verdict per stage of the flow
 * (delivery → archive → reading), the point up to which logs can be read, and how much of the
 * read budget the table uses. Pure functions, so the rules are tested apart from the page.
 */
import type { LogPlatformStatus } from '#lib/api/log-platform.js';

export type StageTone = 'ok' | 'warning' | 'danger' | 'none';

/** Why a stage is not `ok`; the page turns it into words. */
export type StageReason =
	| 'archive_unconfigured'
	| 'archive_unreachable'
	| 'delivery_stuck'
	| 'delivery_error'
	| 'files_over_limit'
	| 'compaction_stale'
	| 'compaction_never'
	| 'read_incomplete'
	| 'export_error';

export interface StageVerdict {
	tone: StageTone;
	reasons: StageReason[];
}

/** A record waiting longer than this is stuck. */
export const STUCK_AFTER_MS = 60 * 60 * 1000;
/** Compaction older than this means the table is growing unchecked. */
export const COMPACTION_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const okOr = (reasons: StageReason[], worst: StageTone): StageVerdict => ({
	tone: reasons.length === 0 ? 'ok' : worst,
	reasons
});

/** Delivery: records leave D1 and reach the archive without piling up. */
export function deliveryVerdict(status: LogPlatformStatus): StageVerdict {
	if (!status.archive.configured) return { tone: 'none', reasons: ['archive_unconfigured'] };
	const reasons: StageReason[] = [];
	const outbox = status.delivery.outbox;
	if (outbox) {
		if (
			outbox.oldest_pending_at !== null &&
			status.generated_at - outbox.oldest_pending_at >= STUCK_AFTER_MS
		)
			reasons.push('delivery_stuck');
		if (outbox.last_error_code) reasons.push('delivery_error');
	}
	if (status.delivery.export?.last_error_code) reasons.push('export_error');
	return okOr(reasons, reasons.includes('delivery_stuck') ? 'danger' : 'warning');
}

/** Archive: the table answers and stays readable (platform callers also see its size). */
export function archiveVerdict(status: LogPlatformStatus): StageVerdict {
	const archive = status.archive;
	if (!archive.configured) return { tone: 'danger', reasons: ['archive_unconfigured'] };
	if (archive.local_staging_only) return { tone: 'ok', reasons: [] };
	if (!archive.reachable) return { tone: 'danger', reasons: ['archive_unreachable'] };
	const reasons: StageReason[] = [];
	if (archive.table_size_hint?.data_files_over_limit) reasons.push('files_over_limit');
	if (archive.table) {
		if (archive.table.last_compaction_at === null) {
			if (archive.table.snapshot_count > 1) reasons.push('compaction_never');
		} else if (status.generated_at - archive.table.last_compaction_at >= COMPACTION_STALE_AFTER_MS)
			reasons.push('compaction_stale');
	}
	return okOr(reasons, reasons.includes('files_over_limit') ? 'danger' : 'warning');
}

/** Reading: the ordinary read path completed within its budget. */
export function readVerdict(status: LogPlatformStatus): StageVerdict {
	if (!status.archive.configured) return { tone: 'none', reasons: ['archive_unconfigured'] };
	return status.archive.read_probe.ok
		? { tone: 'ok', reasons: [] }
		: { tone: 'danger', reasons: ['read_incomplete'] };
}

/**
 * The newest moment whose logs can be read. A platform caller sees the table's last commit;
 * a tenant caller the last record of its own that was confirmed in the archive; in scheduled
 * mode it is the verified watermark for everyone. Null when nothing says.
 */
export function readableUntil(status: LogPlatformStatus): number | null {
	if (status.archive.mode === 'scheduled') {
		return status.delivery.export?.watermark?.updated_at ?? null;
	}
	return (
		status.archive.table?.current_snapshot?.committed_at ?? status.delivery.last_ingested_at ?? null
	);
}

/** Whole minutes between the status and the readable point; null when either is missing. */
export function readableLagMinutes(status: LogPlatformStatus): number | null {
	const until = readableUntil(status);
	if (until === null) return null;
	return Math.max(0, Math.floor((status.generated_at - until) / 60_000));
}

/** Data files as a share of the read limit, 0–100 (may exceed 100), or null without the hint. */
export function readBudgetPercent(status: LogPlatformStatus): number | null {
	const hint = status.archive.table_size_hint;
	const files = status.archive.table?.current_snapshot?.total_data_files;
	if (!hint || files === null || files === undefined || hint.max_files <= 0) return null;
	return Math.round((files / hint.max_files) * 100);
}

/** Hours a record has been waiting, for the stuck message. */
export function stuckHours(status: LogPlatformStatus): number {
	const oldest = status.delivery.outbox?.oldest_pending_at;
	if (!oldest) return 0;
	return Math.floor((status.generated_at - oldest) / STUCK_AFTER_MS);
}
