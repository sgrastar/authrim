import {
	SAML_METADATA_MAX_BYTES,
	type SamlMetadataInput,
	type SamlMetadataPreview
} from '#lib/api/saml-providers.js';
import type { ImportForm } from './connection-model';

export interface MetadataPreviewDraft {
	file?: File;
	preview?: SamlMetadataPreview;
	pending: boolean;
	error: string;
}

export function metadataInput(form: ImportForm): SamlMetadataInput | undefined {
	if (form.importMode === 'manual') return undefined;
	const preview = form.metadata?.preview;
	if (
		!preview ||
		form.metadata?.pending ||
		(form.importMode === 'url' && preview.metadataUrl !== form.metadataUrl) ||
		(form.importMode === 'file' && !form.metadata?.file)
	)
		throw new Error('Preview the current metadata before saving.');
	return {
		metadataXml: preview.metadataXml,
		...(preview.metadataUrl ? { metadataUrl: preview.metadataUrl } : {})
	};
}

export function boundedMetadataXml(xml: string): void {
	if (
		new TextEncoder().encode(xml).byteLength > SAML_METADATA_MAX_BYTES ||
		new TextEncoder().encode(JSON.stringify({ metadataXml: xml })).byteLength >
			2 * 1024 * 1024 - 4096
	)
		throw new Error('Single-connection metadata exceeds the supported size limit.');
}
