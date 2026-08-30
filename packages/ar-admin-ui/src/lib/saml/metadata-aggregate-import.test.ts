import { describe, expect, it } from 'vitest';
import { isMetadataUrlPreviewCurrent } from './metadata-aggregate-import';

describe('aggregate metadata import state', () => {
	it('does not re-import the same URL after an aggregate preview has loaded', () => {
		expect(
			isMetadataUrlPreviewCurrent({
				requestedUrl: 'https://metadata.example.test/aggregate.xml',
				lastImportedUrl: 'https://metadata.example.test/aggregate.xml',
				hasProviderPreview: false,
				hasAggregatePreview: true
			})
		).toBe(true);
	});

	it('imports a changed URL even when another aggregate preview is displayed', () => {
		expect(
			isMetadataUrlPreviewCurrent({
				requestedUrl: 'https://metadata.example.test/new.xml',
				lastImportedUrl: 'https://metadata.example.test/old.xml',
				hasProviderPreview: false,
				hasAggregatePreview: true
			})
		).toBe(false);
	});
});
