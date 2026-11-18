import { fn } from 'storybook/test';
import type { SamlProviderKind } from '#lib/api/saml-providers.js';
import { inboundMappingFixture } from './inbound-mapping.fixture';

import {
	metadataCertificate,
	metadataXml,
	previewMetadataFixture
} from '#lib/api/fake/metadata-fixture.js';
export { metadataCertificate, metadataXml } from '#lib/api/fake/metadata-fixture.js';
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function metadataHttpFixture(kind: SamlProviderKind = 'saml_sp') {
	const incoming = inboundMappingFixture('idp', true);
	let version = 0;
	const protectedConfig = {
		identityMapping: { fieldMappingSetId: 'stored-set', fieldMappingVersionId: 'stored-version' },
		minimumAal: 'aal2',
		custom_extension: { preserved: true }
	};
	let row: {
		id: string;
		name: string;
		providerType: SamlProviderKind;
		enabled: boolean;
		updatedAt: string;
		config: Record<string, unknown>;
	} = {
		id: 'portal',
		name: 'Stored connection',
		providerType: kind,
		enabled: false,
		updatedAt: '2026-11-16T00:00:00.000Z',
		config: {
			...protectedConfig,
			entityId: 'urn:stored:connection',
			...(kind === 'saml_sp'
				? { acsUrl: 'https://stored.example.test/acs' }
				: { ssoUrl: 'https://stored.example.test/sso' }),
			certificate: metadataCertificate
		}
	};
	const writes: Record<string, unknown>[] = [];
	function parseInput(body: Record<string, unknown>) {
		const source = String(body.metadataXml ?? '');
		const parsedKind =
			source.includes('saml_idp') || String(body.metadataUrl).endsWith('/idp.xml')
				? 'saml_idp'
				: 'saml_sp';
		return {
			entityId: `urn:synthetic:${parsedKind}`,
			...(parsedKind === 'saml_sp'
				? { acsUrl: 'https://synthetic.example.test/acs' }
				: { ssoUrl: 'https://synthetic.example.test/sso' }),
			certificate: metadataCertificate,
			certificates: [metadataCertificate],
			metadataXml: source || metadataXml(parsedKind),
			...(body.metadataUrl ? { metadataUrl: body.metadataUrl } : {})
		};
	}
	const preview = fn(
		async (body: Record<string, unknown>): Promise<Response> => previewMetadataFixture(body)
	);
	const fetcher = fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
		const path = String(url);
		const body: unknown = init.body ? JSON.parse(String(init.body)) : {};
		if (!object(body)) throw new Error('Expected object request');
		if (
			kind === 'saml_idp' &&
			path.endsWith('/identity-mapping/inbound/idp/portal') &&
			(!init.method || init.method === 'GET')
		)
			return Response.json({
				...incoming.document,
				revision: `metadata-${row.updatedAt}`,
				providerUpdatedAt: row.updatedAt,
				enabled: row.enabled
			});
		if (path.endsWith('/saml-metadata/preview')) return preview(body);
		if (!path.includes('/saml-providers'))
			throw new Error(`Unexpected story HTTP request: ${path}`);
		if (!init.method || init.method === 'GET') return Response.json(row);
		if (init.method === 'PUT' && body.enabled === true && !row.enabled)
			return Response.json(
				{
					error: 'step_up_required',
					required_level: 'L2',
					step_up_id: 'story-activation-step-up',
					missing: ['passkey', 'second_factor']
				},
				{ status: 403 }
			);
		writes.push(body);
		if (path.endsWith('/import-metadata') || init.method === 'PUT') {
			if (body.expectedUpdatedAt !== row.updatedAt)
				return Response.json({ error: 'conflict' }, { status: 409 });
		}
		const config = object(body.config) ? body.config : {};
		row = {
			...row,
			name: typeof body.name === 'string' ? body.name : row.name,
			enabled: typeof body.enabled === 'boolean' ? body.enabled : row.enabled,
			updatedAt: new Date(Date.UTC(2026, 10, 17, 0, 0, ++version)).toISOString(),
			config: {
				...(init.method === 'POST' &&
				!path.endsWith('/import-metadata') &&
				!config.entityId &&
				!body.metadataXml &&
				!body.metadataUrl
					? {}
					: row.config),
				...config,
				...(body.metadataXml || body.metadataUrl ? parseInput(body) : {})
			}
		};
		if (path.endsWith('/import-metadata'))
			return Response.json({
				success: true,
				providerType: kind,
				config: row.config,
				enabled: false,
				updatedAt: row.updatedAt
			});
		return Response.json(row, { status: init.method === 'POST' ? 201 : 200 });
	});
	return { fetcher, preview, writes, current: () => row, protectedConfig };
}
