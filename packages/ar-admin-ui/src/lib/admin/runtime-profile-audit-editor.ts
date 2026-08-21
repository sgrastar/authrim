import type { RuntimeProfileRecord } from '$lib/api/admin-runtime-profiles';

export type EditableAuditSinkType = 'http' | 'logpush';
export type EditableAuditFailureMode = 'archiveFailureMode' | 'sinkFailureMode';
export type EditableAuditPrimaryType = 'archive-only' | 'd1';
export type EditableAuditRetentionField =
	| 'eventLogRetentionDays'
	| 'piiLogRetentionDays'
	| 'minimumRetentionDays'
	| 'primaryDays'
	| 'archiveDays';

export interface AuditTargetDraft {
	type: string;
	[key: string]: unknown;
}

export interface AuditProfileDraft {
	label?: string;
	description?: string;
	primary: AuditTargetDraft | null;
	archive: AuditTargetDraft | null;
	sinks: AuditTargetDraft[];
	retention?: Record<string, unknown>;
	archiveFailureMode?: string;
	sinkFailureMode?: string;
}

export interface ParsedAuditProfileEditorDraft {
	profile: AuditProfileDraft | null;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAuditTarget(value: unknown): AuditTargetDraft | null {
	if (value === null) {
		return null;
	}
	if (!isRecord(value) || typeof value.type !== 'string') {
		return null;
	}
	return value as AuditTargetDraft;
}

function normalizeSinks(value: unknown): AuditTargetDraft[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(
		(entry): entry is AuditTargetDraft => isRecord(entry) && typeof entry.type === 'string'
	);
}

function normalizeDraft(value: Record<string, unknown>): AuditProfileDraft {
	return {
		...(typeof value.label === 'string' ? { label: value.label } : {}),
		...(typeof value.description === 'string' ? { description: value.description } : {}),
		primary: normalizeAuditTarget(value.primary),
		archive: normalizeAuditTarget(value.archive),
		sinks: normalizeSinks(value.sinks),
		...(isRecord(value.retention) ? { retention: value.retention } : {}),
		...(typeof value.archiveFailureMode === 'string'
			? { archiveFailureMode: value.archiveFailureMode }
			: {}),
		...(typeof value.sinkFailureMode === 'string' ? { sinkFailureMode: value.sinkFailureMode } : {})
	};
}

function stringifyDraft(value: Record<string, unknown>): string {
	return JSON.stringify(value, null, 2);
}

function updateAuditProfileJson(
	json: string,
	mutator: (raw: Record<string, unknown>) => void
): string {
	const parsed = parseAuditProfileEditorDraft(json);
	if (!parsed.profile) {
		return json;
	}

	const raw = JSON.parse(json) as Record<string, unknown>;
	mutator(raw);
	return stringifyDraft(raw);
}

function createAuditSinkTemplate(sinkType: EditableAuditSinkType): AuditTargetDraft {
	return sinkType === 'logpush'
		? {
				type: 'logpush',
				destinationRef: 'LOGPUSH',
				dataset: 'audit_logs'
			}
		: {
				type: 'http',
				url: 'https://example.com/audit',
				method: 'POST',
				format: 'json',
				headers: {
					'X-Authrim-Sink': 'enabled'
				}
			};
}

function createAuditPrimaryTarget(
	type: Exclude<EditableAuditPrimaryType, 'archive-only'>
): AuditTargetDraft {
	return {
		type,
		bindingRef: 'DB'
	};
}

function ensureRetentionRecord(raw: Record<string, unknown>): Record<string, unknown> {
	if (isRecord(raw.retention)) {
		return { ...raw.retention };
	}
	return {};
}

export function createEmptyAuditProfileDraftJson(): string {
	return stringifyDraft({
		label: 'New Audit Profile',
		primary: null,
		archive: {
			type: 'r2',
			bucketRef: 'AUDIT_ARCHIVE',
			prefix: 'audit/'
		},
		sinks: [
			{
				type: 'http',
				url: 'https://example.com/audit',
				headers: {
					'X-Authrim-Sink': 'enabled'
				}
			}
		],
		retention: {
			eventLogRetentionDays: 90,
			piiLogRetentionDays: 365,
			archiveBeforeDelete: false
		},
		archiveFailureMode: 'gate_cleanup',
		sinkFailureMode: 'best_effort'
	});
}

export function normalizeAuditProfileJson(profile: RuntimeProfileRecord): string {
	const { id: _id, kind: _kind, builtin: _builtin, ...editable } = profile;
	return stringifyDraft(editable);
}

export function parseAuditProfileEditorDraft(json: string): ParsedAuditProfileEditorDraft {
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!isRecord(parsed)) {
			return {
				profile: null,
				error: 'Profile JSON must be an object.'
			};
		}
		return { profile: normalizeDraft(parsed) };
	} catch (error) {
		return {
			profile: null,
			error: error instanceof Error ? error.message : 'Invalid JSON'
		};
	}
}

export function insertAuditSinkTemplate(json: string, sinkType: EditableAuditSinkType): string {
	return updateAuditProfileJson(json, (raw) => {
		const existingSinks = Array.isArray(raw.sinks) ? raw.sinks : [];
		raw.sinks = [...existingSinks, createAuditSinkTemplate(sinkType)];
	});
}

export function ensureAuditArchiveTemplate(json: string): string {
	return updateAuditProfileJson(json, (raw) => {
		raw.archive = {
			type: 'r2',
			bucketRef: 'AUDIT_ARCHIVE',
			prefix: 'audit/'
		};
	});
}

export function clearAuditArchiveTemplate(json: string): string {
	return updateAuditProfileJson(json, (raw) => {
		raw.archive = null;
	});
}

export function updateAuditPrimaryType(json: string, type: EditableAuditPrimaryType): string {
	return updateAuditProfileJson(json, (raw) => {
		raw.primary = type === 'archive-only' ? null : createAuditPrimaryTarget(type);
	});
}

export function updateAuditPrimaryField(
	json: string,
	field: 'bindingRef' | 'connectionRef' | 'dataset',
	value: string
): string {
	return updateAuditProfileJson(json, (raw) => {
		const currentPrimary = isRecord(raw.primary)
			? { ...raw.primary }
			: createAuditPrimaryTarget('d1');
		if (value.trim()) {
			currentPrimary[field] = value.trim();
		} else {
			delete currentPrimary[field];
		}
		raw.primary = currentPrimary;
	});
}

export function updateAuditArchiveField(
	json: string,
	field: 'bucketRef' | 'prefix',
	value: string
): string {
	return updateAuditProfileJson(json, (raw) => {
		const currentArchive = isRecord(raw.archive) ? { ...raw.archive } : createR2ArchiveTemplate();
		if (value.trim()) {
			currentArchive[field] = value.trim();
		} else if (field === 'prefix') {
			delete currentArchive.prefix;
		} else {
			currentArchive[field] = '';
		}
		raw.archive = currentArchive;
	});
}

function createR2ArchiveTemplate(): Record<string, unknown> {
	return {
		type: 'r2',
		bucketRef: 'AUDIT_ARCHIVE',
		prefix: 'audit/'
	};
}

export function updateAuditFailureMode(
	json: string,
	field: EditableAuditFailureMode,
	value: string
): string {
	return updateAuditProfileJson(json, (raw) => {
		if (value.trim()) {
			raw[field] = value.trim();
		} else {
			delete raw[field];
		}
	});
}

export function updateAuditRetentionNumber(
	json: string,
	field: EditableAuditRetentionField,
	value: string
): string {
	return updateAuditProfileJson(json, (raw) => {
		const retention = ensureRetentionRecord(raw);
		if (!value.trim()) {
			delete retention[field];
		} else {
			const parsed = Number.parseInt(value, 10);
			if (Number.isFinite(parsed) && parsed > 0) {
				retention[field] = parsed;
			}
		}
		raw.retention = retention;
	});
}

export function updateAuditRetentionBoolean(
	json: string,
	field: 'archiveBeforeDelete',
	value: boolean
): string {
	return updateAuditProfileJson(json, (raw) => {
		const retention = ensureRetentionRecord(raw);
		retention[field] = value;
		raw.retention = retention;
	});
}

export function replaceAuditSinkTemplate(
	json: string,
	index: number,
	sinkType: EditableAuditSinkType
): string {
	return updateAuditProfileJson(json, (raw) => {
		const sinks = Array.isArray(raw.sinks) ? [...raw.sinks] : [];
		sinks[index] = createAuditSinkTemplate(sinkType);
		raw.sinks = sinks;
	});
}

export function updateAuditSinkField(
	json: string,
	index: number,
	field: string,
	value: string
): string {
	return updateAuditProfileJson(json, (raw) => {
		const sinks = Array.isArray(raw.sinks) ? [...raw.sinks] : [];
		const current = isRecord(sinks[index]) ? { ...sinks[index] } : createAuditSinkTemplate('http');
		if (value.trim()) {
			current[field] = value.trim();
		} else {
			delete current[field];
		}
		sinks[index] = current;
		raw.sinks = sinks;
	});
}

export function removeAuditSink(json: string, index: number): string {
	return updateAuditProfileJson(json, (raw) => {
		const sinks = Array.isArray(raw.sinks) ? [...raw.sinks] : [];
		sinks.splice(index, 1);
		raw.sinks = sinks;
	});
}

export function formatAuditTargetSummary(target: AuditTargetDraft | null): string {
	if (!target) {
		return 'Not configured';
	}

	switch (target.type) {
		case 'd1':
			return `D1 · ${String(target.bindingRef ?? 'binding missing')}`;
		case 'r2':
			return `R2 · ${String(target.bucketRef ?? 'bucket missing')}`;
		case 'postgres':
		case 'mysql':
			return `${target.type.toUpperCase()} · ${String(
				target.bindingRef ?? target.connectionRef ?? 'reference missing'
			)}`;
		case 'logpush':
			return `Logpush · ${String(target.destinationRef ?? 'destination missing')}`;
		case 'http':
			return `HTTP · ${String(target.url ?? target.urlRef ?? 'endpoint missing')}`;
		case 'firehose':
			return `Firehose · ${String(target.streamRef ?? 'stream missing')}`;
		default:
			return `${target.type} target`;
	}
}

export function getAuditTargetDetails(target: AuditTargetDraft | null): string[] {
	if (!target) {
		return [];
	}

	const details: string[] = [];
	if (typeof target.dataset === 'string') {
		details.push(`dataset: ${target.dataset}`);
	}
	if (typeof target.prefix === 'string') {
		details.push(`prefix: ${target.prefix}`);
	}
	if (typeof target.urlRef === 'string') {
		details.push(`urlRef: ${target.urlRef}`);
	}
	if (typeof target.authTokenRef === 'string') {
		details.push(`authTokenRef: ${target.authTokenRef}`);
	}
	if (typeof target.method === 'string') {
		details.push(`method: ${target.method}`);
	}
	if (typeof target.format === 'string') {
		details.push(`format: ${target.format}`);
	}
	if (isRecord(target.headers)) {
		details.push(`headers: ${Object.keys(target.headers).length}`);
	}
	return details;
}
