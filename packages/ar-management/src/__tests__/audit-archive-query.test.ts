import { describe, expect, it, vi } from 'vitest';
import { buildCanonicalAuditRecord, type AuditProfile, type EventLogEntry } from '@authrim/ar-lib-core';
import {
	getArchiveAuditEventById,
	getAuditArchiveQuerySupportForProfile,
	listArchiveAuditEvents,
} from '../audit-archive-query';

function createEventEntry(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
	return {
		id: 'evt-1',
		tenantId: 'tenant-1',
		eventType: 'user.login',
		eventCategory: 'user',
		result: 'success',
		severity: 'info',
		createdAt: 1_710_000_000_000,
		...overrides,
	};
}

function buildArchiveObject(entry: EventLogEntry) {
	return JSON.stringify(
		buildCanonicalAuditRecord(
			{ type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
			{
				type: 'event_log',
				tenantId: entry.tenantId,
				timestamp: entry.createdAt,
				entries: [entry],
				fanout: {
					auditProfileId: 'archive-only',
					archives: [],
					sinks: [],
				},
			},
			entry,
			'archive'
		)
	);
}

function createArchiveBucket(entries: EventLogEntry[]) {
	const objects = new Map(
		entries.map((entry) => [
			`audit/event/${entry.tenantId}/${new Date(entry.createdAt).toISOString().slice(0, 10)}/${entry.id}.json`,
			buildArchiveObject(entry),
		])
	);

	return {
		get: vi.fn(async (key: string) => {
			const body = objects.get(key);
			if (!body) {
				return null;
			}
			return {
				text: async () => body,
			};
		}),
		list: vi.fn(async (options?: { prefix?: string }) => ({
			objects: Array.from(objects.keys())
				.filter((key) => !options?.prefix || key.startsWith(options.prefix))
				.map((key) => ({ key })),
			truncated: false,
		})),
		put: vi.fn(),
		delete: vi.fn(),
		head: vi.fn(),
		createMultipartUpload: vi.fn(),
		resumeMultipartUpload: vi.fn(),
	} as unknown as R2Bucket;
}

describe('audit-archive-query', () => {
	it('uses R2 archive access for archive-only audit profiles', async () => {
		const older = createEventEntry({
			id: 'evt-older',
			createdAt: 1_709_000_000_000,
			clientId: 'client-1',
		});
		const newer = createEventEntry({
			id: 'evt-newer',
			createdAt: 1_710_000_000_000,
			eventType: 'client.updated',
			eventCategory: 'client',
			clientId: 'client-2',
			detailsJson: JSON.stringify({
				resourceType: 'client',
				resourceId: 'client-2',
			}),
		});
		const bucket = createArchiveBucket([older, newer]);
		const profile: AuditProfile = {
			id: 'archive-only',
			kind: 'audit',
			label: 'Archive Only',
			primary: null,
			archive: {
				type: 'r2',
				bucketRef: 'DIAGNOSTIC_LOGS',
				prefix: 'audit/',
			},
			sinks: [],
		};

		const support = getAuditArchiveQuerySupportForProfile(
			{
				DIAGNOSTIC_LOGS: bucket,
			} as unknown as import('@authrim/ar-lib-core').Env,
			profile
		);

		expect(support.supported).toBe(true);
		expect(support.status).toBe('supported');
		expect(support.context).toBeTruthy();

		const listed = await listArchiveAuditEvents(support.context!, {
			tenantId: 'tenant-1',
			page: 1,
			limit: 10,
			resourceType: 'client',
			resourceId: 'client-2',
		});

		expect(listed.total).toBe(1);
		expect(listed.entries[0]?.id).toBe('evt-newer');

		const detail = await getArchiveAuditEventById(support.context!, 'tenant-1', 'evt-newer');
		expect(detail?.eventType).toBe('client.updated');
	});

	it('marks archive-only profiles as pending when the R2 binding is missing', () => {
		const profile: AuditProfile = {
			id: 'archive-only',
			kind: 'audit',
			label: 'Archive Only',
			primary: null,
			archive: {
				type: 'r2',
				bucketRef: 'DIAGNOSTIC_LOGS',
				prefix: 'audit/',
			},
			sinks: [],
		};

		const support = getAuditArchiveQuerySupportForProfile({} as never, profile);

		expect(support.supported).toBe(false);
		expect(support.status).toBe('pending_runtime_support');
	});
});
