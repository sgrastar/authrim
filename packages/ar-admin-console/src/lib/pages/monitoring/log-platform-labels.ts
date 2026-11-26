import type { LogArchiveMode, LogReadConsistency } from '#lib/api/log-platform.js';
import type { MessageKey } from '#lib/i18n/messages/ja.js';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const MODES: Record<LogArchiveMode, MessageKey> = {
	pipeline: 'lplat.archive.mode.pipeline',
	scheduled: 'lplat.archive.mode.scheduled'
};

const CONSISTENCY: Record<LogReadConsistency, MessageKey> = {
	eventual: 'lplat.read.consistency.eventual',
	snapshot: 'lplat.read.consistency.snapshot',
	local_hot_only: 'lplat.read.consistency.local_hot_only'
};

export function modeLabel(mode: LogArchiveMode, t: Translate): string {
	return t(MODES[mode]);
}

/** An unknown consistency (a newer API) is shown as it is. */
export function consistencyLabel(consistency: LogReadConsistency, t: Translate): string {
	const key = CONSISTENCY[consistency];
	return key ? t(key) : consistency;
}
