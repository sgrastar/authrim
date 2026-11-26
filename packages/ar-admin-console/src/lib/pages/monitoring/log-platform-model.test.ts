import { describe, expect, it } from 'vitest';
import { LOG_PLATFORM_NOW, sampleLogPlatformStatus } from '#lib/api/fake/log-platform-fake.js';
import {
	archiveVerdict,
	deliveryVerdict,
	readBudgetPercent,
	readVerdict,
	readableLagMinutes,
	readableUntil
} from './log-platform-model';

describe('log platform verdicts', () => {
	it('calls every stage ok on a healthy pipeline archive', () => {
		const status = sampleLogPlatformStatus('healthy');
		expect(deliveryVerdict(status)).toEqual({ tone: 'ok', reasons: [] });
		expect(archiveVerdict(status)).toEqual({ tone: 'ok', reasons: [] });
		expect(readVerdict(status)).toEqual({ tone: 'ok', reasons: [] });
		expect(readBudgetPercent(status)).toBe(9);
	});

	it('blames the archive and the read, not the delivery, when the table outgrew the limit', () => {
		const status = sampleLogPlatformStatus('over-limit');
		expect(deliveryVerdict(status).tone).toBe('ok');
		expect(archiveVerdict(status)).toEqual({
			tone: 'warning',
			reasons: ['files_over_limit', 'compaction_never']
		});
		expect(readVerdict(status)).toEqual({ tone: 'danger', reasons: ['read_incomplete'] });
		expect(readBudgetPercent(status)).toBe(463);
	});

	it('marks a backed-up delivery as danger and an unreachable archive as danger', () => {
		const status = sampleLogPlatformStatus('unreachable');
		expect(deliveryVerdict(status)).toEqual({
			tone: 'danger',
			reasons: ['delivery_stuck', 'delivery_error']
		});
		expect(archiveVerdict(status)).toEqual({ tone: 'danger', reasons: ['archive_unreachable'] });
	});

	it('has nothing to say about delivery or reading without an archive', () => {
		const status = sampleLogPlatformStatus('unconfigured');
		expect(deliveryVerdict(status).tone).toBe('none');
		expect(archiveVerdict(status)).toEqual({ tone: 'danger', reasons: ['archive_unconfigured'] });
		expect(readVerdict(status).tone).toBe('none');
		expect(readableUntil(status)).toBeNull();
		expect(readBudgetPercent(status)).toBeNull();
	});

	it('warns, not fails, when compaction is merely stale', () => {
		const status = sampleLogPlatformStatus('healthy');
		status.archive.table!.last_compaction_at = LOG_PLATFORM_NOW - 30 * 60 * 60 * 1000;
		expect(archiveVerdict(status)).toEqual({ tone: 'warning', reasons: ['compaction_stale'] });
	});
});

describe('readable point', () => {
	it('is the last commit for a platform caller and unknown to a tenant in pipeline mode', () => {
		const platform = sampleLogPlatformStatus('healthy');
		expect(readableUntil(platform)).toBe(platform.archive.table!.current_snapshot!.committed_at);
		expect(readableLagMinutes(platform)).toBe(4);
		const tenant = sampleLogPlatformStatus('tenant');
		expect(readableUntil(tenant)).toBeNull();
	});

	it('flags an outstanding export failure even after a later batch succeeded', () => {
		const status = sampleLogPlatformStatus('scheduled');
		status.delivery.export!.active_failure = {
			batch_id: 'b1',
			error_code: 'catalog_commit_conflict',
			updated_at: LOG_PLATFORM_NOW - 60_000
		};
		expect(deliveryVerdict(status)).toEqual({ tone: 'warning', reasons: ['export_error'] });
	});

	it('calls a scheduled exporter stalled when a batch sat unfinished for two intervals', () => {
		const status = sampleLogPlatformStatus('scheduled');
		status.delivery.export!.oldest_unfinished_at = LOG_PLATFORM_NOW - 25 * 60_000;
		expect(deliveryVerdict(status).tone).toBe('ok');
		status.delivery.export!.oldest_unfinished_at = LOG_PLATFORM_NOW - 61 * 60_000;
		expect(deliveryVerdict(status)).toEqual({ tone: 'danger', reasons: ['delivery_stuck'] });
	});

	it('calls the exporter stalled when eligible records were never selected into a batch', () => {
		const status = sampleLogPlatformStatus('scheduled');
		status.delivery.export!.oldest_unfinished_at = null;
		status.delivery.export!.oldest_eligible_since = LOG_PLATFORM_NOW - 2 * 60 * 60_000;
		expect(deliveryVerdict(status)).toEqual({ tone: 'danger', reasons: ['delivery_stuck'] });
	});

	it('is the verified watermark in scheduled mode', () => {
		const status = sampleLogPlatformStatus('scheduled');
		expect(readableUntil(status)).toBe(status.delivery.export!.watermark!.updated_at);
		expect(readableLagMinutes(status)).toBe(11);
	});
});
