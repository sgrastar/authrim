import { describe, expect, it } from 'vitest';
import {
	clearAuditArchiveTemplate,
	createEmptyAuditProfileDraftJson,
	ensureAuditArchiveTemplate,
	formatAuditTargetSummary,
	getAuditTargetDetails,
	insertAuditSinkTemplate,
	parseAuditProfileEditorDraft,
	removeAuditSink,
	replaceAuditSinkTemplate,
	updateAuditArchiveField,
	updateAuditFailureMode,
	updateAuditPrimaryField,
	updateAuditPrimaryType,
	updateAuditRetentionBoolean,
	updateAuditRetentionNumber,
	updateAuditSinkField
} from '../runtime-profile-audit-editor';

describe('runtime-profile-audit-editor helpers', () => {
	it('creates a default audit profile draft with an archive target and one HTTP sink', () => {
		const parsed = parseAuditProfileEditorDraft(createEmptyAuditProfileDraftJson());

		expect(parsed.error).toBeUndefined();
		expect(parsed.profile?.archive).toEqual({
			type: 'r2',
			bucketRef: 'AUDIT_ARCHIVE',
			prefix: 'audit/'
		});
		expect(parsed.profile?.sinks).toHaveLength(1);
		expect(parsed.profile?.sinks[0]?.type).toBe('http');
	});

	it('adds HTTP and Logpush sink templates without discarding existing sinks', () => {
		const withHttp = insertAuditSinkTemplate(
			JSON.stringify({ label: 'Draft', primary: null, archive: null, sinks: [] }),
			'http'
		);
		const withLogpush = insertAuditSinkTemplate(withHttp, 'logpush');
		const parsed = parseAuditProfileEditorDraft(withLogpush);

		expect(parsed.profile?.sinks.map((sink) => sink.type)).toEqual(['http', 'logpush']);
		expect(parsed.profile?.sinks[1]).toMatchObject({
			type: 'logpush',
			destinationRef: 'LOGPUSH'
		});
	});

	it('ensures an archive template exists for archive-only or cleanup-enabled profiles', () => {
		const updated = ensureAuditArchiveTemplate(
			JSON.stringify({ label: 'Draft', primary: null, archive: null, sinks: [] })
		);
		const parsed = parseAuditProfileEditorDraft(updated);

		expect(parsed.profile?.archive).toEqual({
			type: 'r2',
			bucketRef: 'AUDIT_ARCHIVE',
			prefix: 'audit/'
		});
	});

	it('updates archive, sink, and failure mode fields through form helpers', () => {
		const withHttp = insertAuditSinkTemplate(
			JSON.stringify({ label: 'Draft', primary: null, archive: null, sinks: [] }),
			'http'
		);
		const withArchive = updateAuditArchiveField(
			ensureAuditArchiveTemplate(withHttp),
			'bucketRef',
			'AUDIT_ARCHIVE'
		);
		const withSinkUrlRef = updateAuditSinkField(withArchive, 0, 'urlRef', 'AUDIT_HTTP_URL');
		const withFailureMode = updateAuditFailureMode(
			withSinkUrlRef,
			'sinkFailureMode',
			'retry_until_ttl'
		);
		const parsed = parseAuditProfileEditorDraft(withFailureMode);

		expect(parsed.profile?.archive).toMatchObject({
			type: 'r2',
			bucketRef: 'AUDIT_ARCHIVE'
		});
		expect(parsed.profile?.sinks[0]).toMatchObject({
			type: 'http',
			urlRef: 'AUDIT_HTTP_URL'
		});
		expect(parsed.profile?.sinkFailureMode).toBe('retry_until_ttl');
	});

	it('updates primary target and retention fields through form helpers', () => {
		const draft = JSON.stringify({ label: 'Draft', primary: null, archive: null, sinks: [] });
		const withPrimary = updateAuditPrimaryField(
			updateAuditPrimaryType(draft, 'd1'),
			'bindingRef',
			'AUDIT_PRIMARY_D1'
		);
		const withRetentionDays = updateAuditRetentionNumber(
			updateAuditRetentionNumber(withPrimary, 'eventLogRetentionDays', '30'),
			'piiLogRetentionDays',
			'365'
		);
		const withArchiveBeforeDelete = updateAuditRetentionBoolean(
			withRetentionDays,
			'archiveBeforeDelete',
			true
		);
		const parsed = parseAuditProfileEditorDraft(withArchiveBeforeDelete);

		expect(parsed.profile?.primary).toMatchObject({
			type: 'd1',
			bindingRef: 'AUDIT_PRIMARY_D1'
		});
		expect(parsed.profile?.retention).toMatchObject({
			eventLogRetentionDays: 30,
			piiLogRetentionDays: 365,
			archiveBeforeDelete: true
		});
	});

	it('replaces sink templates, removes sinks, and clears archive targets', () => {
		const draft = JSON.stringify({ label: 'Draft', primary: null, archive: null, sinks: [] });
		const withHttp = insertAuditSinkTemplate(draft, 'http');
		const withLogpush = replaceAuditSinkTemplate(withHttp, 0, 'logpush');
		const withoutSinks = removeAuditSink(withLogpush, 0);
		const withoutArchive = clearAuditArchiveTemplate(ensureAuditArchiveTemplate(withoutSinks));
		const parsed = parseAuditProfileEditorDraft(withoutArchive);

		expect(parsed.profile?.sinks).toEqual([]);
		expect(parsed.profile?.archive).toBeNull();
	});

	it('returns a readable summary and details for common sink targets', () => {
		expect(
			formatAuditTargetSummary({
				type: 'http',
				urlRef: 'AUDIT_HTTP_URL',
				authTokenRef: 'AUDIT_HTTP_TOKEN',
				method: 'POST',
				format: 'json'
			})
		).toBe('HTTP · AUDIT_HTTP_URL');
		expect(
			getAuditTargetDetails({
				type: 'http',
				urlRef: 'AUDIT_HTTP_URL',
				authTokenRef: 'AUDIT_HTTP_TOKEN',
				method: 'POST',
				format: 'json',
				headers: {
					Authorization: 'Bearer example'
				}
			})
		).toEqual([
			'urlRef: AUDIT_HTTP_URL',
			'authTokenRef: AUDIT_HTTP_TOKEN',
			'method: POST',
			'format: json',
			'headers: 1'
		]);
	});

	it('returns a parse error for invalid profile JSON', () => {
		const parsed = parseAuditProfileEditorDraft('{not-json');

		expect(parsed.profile).toBeNull();
		expect(parsed.error).toBeTruthy();
	});
});
