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
	const exp = status.delivery.export;
	if (exp) {
		if (exp.active_failure || exp.last_error_code) reasons.push('export_error');
		// Work that sat for two export intervals (at least an hour) means the exporter stopped,
		// with or without an error to show for it: an unfinished batch, or staged records that no
		// batch has selected because the exporter never ran again.
		const interval = (status.archive.export_interval_minutes ?? 60) * 60_000;
		const limit = Math.max(2 * interval, STUCK_AFTER_MS);
		const oldest = [exp.oldest_unfinished_at, exp.oldest_unselected_at]
			.filter((at): at is number => at !== null)
			.reduce<number | null>((min, at) => (min === null || at < min ? at : min), null);
		if (oldest !== null && status.generated_at - oldest >= limit) reasons.push('delivery_stuck');
	}
	return okOr(reasons, reasons.includes('delivery_stuck') ? 'danger' : 'warning');
}

/**
 * Archive: the table answers and stays readable. Its size against the read limit is advisory
 * (the reader prunes files before opening them), so it is attention, never failure; a failed
 * read shows up as such on the reading stage.
 */
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
	return okOr(reasons, 'warning');
}

/** Reading: the ordinary read path completed within its budget. */
export function readVerdict(status: LogPlatformStatus): StageVerdict {
	if (!status.archive.configured) return { tone: 'none', reasons: ['archive_unconfigured'] };
	return status.archive.read_probe.ok
		? { tone: 'ok', reasons: [] }
		: { tone: 'danger', reasons: ['read_incomplete'] };
}

/**
 * The time of the newest commit (platform caller) or of the last verified watermark (scheduled
 * mode). It says when the archive last moved, not that every older record is in: a record
 * still pending while another tenant commits is not covered by it. A tenant caller in pipeline
 * mode gets null, since the table's commits are not shown to it.
 */
export function readableUntil(status: LogPlatformStatus): number | null {
	if (status.archive.mode === 'scheduled') {
		return status.delivery.export?.watermark?.updated_at ?? null;
	}
	return status.archive.table?.current_snapshot?.committed_at ?? null;
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
