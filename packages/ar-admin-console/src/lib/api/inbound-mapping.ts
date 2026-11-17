import type { FieldCatalogEntry } from '@authrim/ar-lib-field-mapping/contract';
import type { MappingSetContent, MappingSetRule } from './mapping-set';
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import { StepUpCancelledError, stepUpHeaders, withStepUp } from './admin-step-up';
import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';

export interface InboundMappingDocument {
	revision: string;
	protocol: 'oidc' | 'saml';
	role: 'rp' | 'sp';
	configured: boolean;
	editable: boolean;
	legacyMappingPresent: boolean;
	sources: FieldCatalogEntry[];
	targets: FieldCatalogEntry[];
	content: MappingSetContent;
	providerUpdatedAt: string;
	enabled: boolean;
}
export interface InboundMappingDraft {
	revision: string;
	sources: Pick<FieldCatalogEntry, 'namespace' | 'path' | 'cardinality'>[];
	rules: MappingSetRule[];
}
export interface InboundMappingPreview {
	profile: Record<string, string>;
	customClaims: Record<string, string>;
}
export interface InboundMappingClient {
	get(kind: 'op' | 'idp', id: string): Promise<InboundMappingDocument>;
	save(
		kind: 'op' | 'idp',
		id: string,
		draft: InboundMappingDraft,
		key: string
	): Promise<InboundMappingDocument>;
	preview(
		kind: 'op' | 'idp',
		id: string,
		draft: InboundMappingDraft,
		sample: unknown
	): Promise<InboundMappingPreview>;
}
const path = (kind: 'op' | 'idp', id: string) =>
	`${API_BASE_URL}/api/admin/identity-mapping/inbound/${kind}/${encodeURIComponent(id)}`;
async function document(response: Response): Promise<InboundMappingDocument> {
	if (!response.ok) throw await errorFromResponse(response);
	const body: InboundMappingDocument = await response.json();
	if (
		typeof body.revision !== 'string' ||
		!Array.isArray(body.sources) ||
		!Array.isArray(body.targets) ||
		!Array.isArray(body.content?.rules) ||
		!['oidc', 'saml'].includes(body.protocol)
	)
		throw new Error('Invalid incoming mapping response');
	return body;
}
export const httpInboundMapping: InboundMappingClient = {
	async get(kind, id) {
		return document(await adminFetch(path(kind, id)));
	},
	async save(kind, id, draft, key) {
		const body = JSON.stringify(draft);
		const tenant = tenantScope.tenantId;
		return withStepUp(async (receipt) => {
			if (tenantScope.tenantId !== tenant) throw new StepUpCancelledError();
			return document(
				await adminFetch(path(kind, id), {
					method: 'PUT',
					includeJsonContentType: true,
					body,
					headers: { ...stepUpHeaders(receipt), 'Idempotency-Key': key }
				})
			);
		});
	},
	async preview(kind, id, draft, sample) {
		const response = await adminFetch(`${path(kind, id)}/preview`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify({ ...draft, sample })
		});
		if (!response.ok) throw await errorFromResponse(response);
		return response.json();
	}
};
