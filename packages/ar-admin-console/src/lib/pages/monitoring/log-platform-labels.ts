import type { LogArchiveMode, LogReadConsistency } from '#lib/api/log-platform.js';
import type { MessageKey } from '#lib/i18n/messages/ja.js';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;
type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const LANES: Record<string, MessageKey> = {
	critical: 'lplat.lane.critical',
	default: 'lplat.lane.default',
	bulk: 'lplat.lane.bulk'
};

const STATUSES: Record<string, MessageKey> = {
	queued: 'lplat.status.queued',
	delivered: 'lplat.status.delivered',
	retrying: 'lplat.status.retrying',
	failed: 'lplat.status.failed',
	dlq: 'lplat.status.dlq'
};

const STATUS_TONE: Record<string, Tone> = {
	queued: 'info',
	delivered: 'success',
	retrying: 'warning',
	failed: 'danger',
	dlq: 'danger'
};

const MODES: Record<LogArchiveMode, MessageKey> = {
	pipeline: 'lplat.archive.mode.pipeline',
	scheduled: 'lplat.archive.mode.scheduled'
};

const CONSISTENCY: Record<LogReadConsistency, MessageKey> = {
	eventual: 'lplat.probe.consistency.eventual',
	snapshot: 'lplat.probe.consistency.snapshot',
	local_hot_only: 'lplat.probe.consistency.local_hot_only'
};

/** A delivery lane's name; an unknown lane is shown as it is. */
export function laneLabel(lane: string, t: Translate): string {
	const key = LANES[lane];
	return key ? t(key) : lane;
}

/** A delivery outcome's name; an unknown one is shown as it is. */
export function statusLabel(status: string, t: Translate): string {
	const key = STATUSES[status];
	return key ? t(key) : status;
}

export function laneStatusTone(status: string): Tone {
	return STATUS_TONE[status] ?? 'neutral';
}

export function modeLabel(mode: LogArchiveMode, t: Translate): string {
	return t(MODES[mode]);
}

export function consistencyLabel(consistency: LogReadConsistency, t: Translate): string {
	const key = CONSISTENCY[consistency];
	return key ? t(key) : consistency;
}
