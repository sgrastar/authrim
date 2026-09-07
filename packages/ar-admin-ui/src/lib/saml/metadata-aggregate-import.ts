export type SAMLMetadataAggregateImportMode = 'selected_entities' | 'trust_profile';

export function isMetadataUrlPreviewCurrent(options: {
	requestedUrl: string;
	lastImportedUrl: string;
	hasProviderPreview: boolean;
	hasAggregatePreview: boolean;
}): boolean {
	return (
		options.requestedUrl === options.lastImportedUrl &&
		(options.hasProviderPreview || options.hasAggregatePreview)
	);
}
