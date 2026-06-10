import type { RequestEvent } from '@sveltejs/kit';

const DEV_ADMIN_MOCK_FLAG = 'AUTHRIM_ADMIN_UI_DEV_MOCK';
const DEV_ADMIN_MOCK_SENTINEL = '__AUTHRIM_ADMIN_UI_DEV_MOCK_SENTINEL__';
const TENANT_ID = 'dev-tenant';
const NOW = 1780704000000;

type EnvLike = Record<string, unknown> | undefined;

interface DevClient {
	client_id: string;
	client_name: string;
	description?: string | null;
	client_secret?: string;
	grant_types: string[];
	response_types: string[];
	redirect_uris: string[];
	token_endpoint_auth_method: string;
	browser_public_client_mode?: 'strict' | 'cookie_fallback' | null;
	browser_refresh_token_policy?: 'disabled' | 'dpop_bound' | null;
	scope?: string;
	contacts?: string[];
	logo_uri?: string | null;
	client_uri?: string | null;
	policy_uri?: string | null;
	tos_uri?: string | null;
	is_trusted?: boolean;
	skip_consent?: boolean;
	allow_claims_without_scope?: boolean;
	claims_parameter_policy?: Record<string, string> | null;
	identity_mapping?: Record<string, unknown> | null;
	attribute_release_consent?: { enabled: boolean; mode: string } | null;
	asc_enabled?: boolean;
	asc_protected_request_required?: boolean;
	asc_sao_enabled?: boolean;
	asc_transformed_claims_enabled?: boolean;
	asc_allowed_transformed_claims?: string[] | null;
	login_ui_url?: string | null;
	id_token_signed_response_alg?: string;
	require_pkce?: boolean;
	token_exchange_allowed?: boolean;
	allowed_subject_token_clients?: string[];
	allowed_token_exchange_resources?: string[];
	delegation_mode?: 'none' | 'delegation' | 'impersonation';
	client_credentials_allowed?: boolean;
	allowed_scopes?: string[];
	default_scope?: string | null;
	default_audience?: string | null;
	access_token_ttl?: number;
	refresh_token_ttl?: number;
	web_origin_registry?: Record<string, unknown>;
	created_at: number;
	updated_at: number;
}

interface DevSamlProvider {
	id: string;
	name: string;
	providerType: 'saml_idp' | 'saml_sp';
	config: Record<string, unknown>;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

interface DevSettings {
	category: string;
	version: string;
	values: Record<string, unknown>;
	sources: Record<string, 'default' | 'kv' | 'env'>;
}

const fieldMappingSets = [
	{
		id: 'field-mapping-gakunin-basic',
		tenantId: TENANT_ID,
		fieldMappingKey: 'gakunin-basic',
		displayName: 'GakuNin basic profile',
		description: 'Dev mock field mapping set for SAML attributes and OIDC claims.',
		lifecycleState: 'active'
	},
	{
		id: 'field-mapping-researcher-oidc',
		tenantId: TENANT_ID,
		fieldMappingKey: 'researcher-oidc',
		displayName: 'Researcher OIDC claims',
		description: 'Dev mock field mapping set for OIDC claim release testing.',
		lifecycleState: 'draft'
	}
];

const fieldMappingVersions = [
	{
		id: 'field-mapping-version-gakunin-basic-v1',
		tenantId: TENANT_ID,
		fieldMappingSetId: 'field-mapping-gakunin-basic',
		versionLabel: 'v1',
		lifecycleState: 'active',
		publishedAt: NOW,
		createdAt: NOW,
		updatedAt: NOW,
		directions: { source: true, destination: true },
		sourceProfileIds: ['source-profile-gakunin-saml'],
		destinationProfileIds: ['destination-profile-oidc-core', 'destination-profile-saml-sp'],
		rules: [
			{
				id: 'rule-email',
				ruleKey: 'email',
				ruleKind: 'field',
				action: 'map',
				priority: 10,
				metadata: {},
				edges: [
					{
						id: 'edge-email',
						sourceRef: {
							side: 'source',
							namespace: 'saml.attribute',
							path: 'urn:oid:0.9.2342.19200300.100.1.3'
						},
						targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
						edgeKind: 'direct',
						displayOrder: 0
					}
				],
				transforms: []
			}
		],
		latestSnapshot: {
			id: 'snapshot-gakunin-basic-v1',
			catalogVersionId: 'catalog-version-core-v1',
			lifecycleState: 'active',
			compiledAt: NOW
		}
	}
];

const catalogEntries = [
	{
		id: 'catalog-entry-email',
		stableFieldId: 'profile.email',
		namespace: 'authrim.profile',
		path: 'email',
		targetTaxonomy: 'person',
		valueType: 'string',
		cardinality: 'single',
		classification: 'contact',
		aliases: [
			{ namespace: 'oidc.claim', path: 'email' },
			{ namespace: 'saml.attribute', path: 'urn:oid:0.9.2342.19200300.100.1.3' }
		],
		uiGroupKey: 'contact',
		uiGroupLabel: 'Contact',
		uiGroupOrder: 10,
		uiFieldOrder: 10,
		nullable: false,
		required: true
	},
	{
		id: 'catalog-entry-display-name',
		stableFieldId: 'profile.display_name',
		namespace: 'authrim.profile',
		path: 'displayName',
		targetTaxonomy: 'person',
		valueType: 'string',
		cardinality: 'single',
		classification: 'profile',
		aliases: [
			{ namespace: 'oidc.claim', path: 'name' },
			{ namespace: 'saml.attribute', path: 'urn:oid:2.5.4.3' }
		],
		uiGroupKey: 'profile',
		uiGroupLabel: 'Profile',
		uiGroupOrder: 20,
		uiFieldOrder: 10,
		nullable: true,
		required: false
	}
];

const clients = new Map<string, DevClient>([
	[
		'dev-oidc-client',
		{
			client_id: 'dev-oidc-client',
			client_name: 'Dev OIDC Client',
			description: 'Local Admin UI mock client',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			redirect_uris: ['http://localhost:5173/callback'],
			token_endpoint_auth_method: 'none',
			browser_public_client_mode: 'strict',
			browser_refresh_token_policy: 'dpop_bound',
			scope: 'openid profile email',
			identity_mapping: {
				fieldMappingSetId: 'field-mapping-gakunin-basic',
				destinationNamespace: 'oidc.claim'
			},
			attribute_release_consent: null,
			asc_enabled: true,
			asc_protected_request_required: true,
			asc_sao_enabled: true,
			asc_transformed_claims_enabled: true,
			asc_allowed_transformed_claims: ['age_over_18', 'email_domain'],
			require_pkce: true,
			created_at: NOW,
			updated_at: NOW
		}
	]
]);

const samlProviders = new Map<string, DevSamlProvider>([
	[
		'dev-saml-sp',
		{
			id: 'dev-saml-sp',
			name: 'Dev GakuNin SP',
			providerType: 'saml_sp',
			enabled: true,
			createdAt: new Date(NOW).toISOString(),
			updatedAt: new Date(NOW).toISOString(),
			config: {
				description: 'Local Admin UI mock SAML SP',
				providerName: 'Dev GakuNin SP',
				entityId: 'https://sp.example.edu/shibboleth',
				acsUrl: 'https://sp.example.edu/Shibboleth.sso/SAML2/POST',
				nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
				allowedBindings: ['post', 'redirect'],
				signAssertions: true,
				signResponses: true,
				samlProfile: 'gakunin',
				authnRequestSignaturePolicy: 'optional',
				logoutRequestSignaturePolicy: 'required',
				attributePresetId: 'gakunin-basic',
				identityMapping: {
					fieldMappingSetId: 'field-mapping-gakunin-basic',
					destinationNamespace: 'saml.attribute'
				}
			}
		}
	]
]);

const settings = new Map<string, DevSettings>([
	[
		`${TENANT_ID}:tenant`,
		{
			category: 'tenant',
			version: 'dev-1',
			values: { 'tenant.allowed_origins': 'http://localhost:5173,http://127.0.0.1:5173' },
			sources: { 'tenant.allowed_origins': 'kv' }
		}
	],
	[
		`${TENANT_ID}:client:dev-oidc-client`,
		{
			category: 'client',
			version: 'dev-1',
			values: {
				'client.pkce_required': true,
				'client.par_required': false,
				'client.dpop_required': false,
				'client.login_ui_url': ''
			},
			sources: {
				'client.pkce_required': 'kv',
				'client.par_required': 'default',
				'client.dpop_required': 'default',
				'client.login_ui_url': 'default'
			}
		}
	]
]);

function isLoopbackHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function envFlag(platformEnv: EnvLike): boolean {
	const importMetaEnv = import.meta.env as Record<string, string | undefined>;
	const candidates = [
		platformEnv?.[DEV_ADMIN_MOCK_FLAG],
		importMetaEnv[DEV_ADMIN_MOCK_FLAG],
		typeof process !== 'undefined' ? process.env?.[DEV_ADMIN_MOCK_FLAG] : undefined
	];
	return candidates.some((candidate) => String(candidate || '').toLowerCase() === 'true');
}

export function isDevAdminMockEnabled(event: RequestEvent, platformEnv: EnvLike): boolean {
	return (
		Boolean(import.meta.env.DEV) &&
		!(typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') &&
		isLoopbackHost(event.url.hostname) &&
		envFlag(platformEnv)
	);
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			'X-Authrim-Dev-Mock': 'admin-ui',
			'X-Authrim-Dev-Mock-Sentinel': DEV_ADMIN_MOCK_SENTINEL
		}
	});
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	try {
		const value = await request.json();
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function nextVersion(current: string): string {
	const number = Number(current.replace(/^dev-/, ''));
	return `dev-${Number.isFinite(number) ? number + 1 : 1}`;
}

function settingKey(tenantId: string, category: string, clientId?: string): string {
	return clientId ? `${tenantId}:${category}:${clientId}` : `${tenantId}:${category}`;
}

function getTenantId(event: RequestEvent): string {
	return event.request.headers.get('x-tenant-id') || TENANT_ID;
}

function getSettings(tenantId: string, category: string, clientId?: string): DevSettings {
	const key = settingKey(tenantId, category, clientId);
	const existing = settings.get(key);
	if (existing) return existing;
	const created = {
		category,
		version: 'dev-1',
		values: {},
		sources: {}
	};
	settings.set(key, created);
	return created;
}

function listClients() {
	return {
		clients: [...clients.values()],
		pagination: {
			page: 1,
			limit: 50,
			total: clients.size,
			totalPages: 1,
			hasNext: false,
			hasPrev: false
		}
	};
}

function createClientId(name: unknown): string {
	const base = String(name || 'dev-client')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	const candidate = base || 'dev-client';
	if (!clients.has(candidate)) return candidate;
	return `${candidate}-${clients.size + 1}`;
}

function mergeClient(client: DevClient, patch: Record<string, unknown>): DevClient {
	return {
		...client,
		...patch,
		client_id: client.client_id,
		created_at: client.created_at,
		updated_at: Date.now()
	};
}

function sampleProtocolSchemas() {
	return [
		{
			id: 'schema-oidc-core',
			tenantId: TENANT_ID,
			protocol: 'oidc',
			schemaKey: 'oidc-core',
			displayName: 'OIDC Core Claims',
			versionLabel: 'v1',
			schemaVersion: '1.0',
			lifecycleState: 'active',
			schema: {
				fields: [
					{ key: 'email', label: 'email', namespace: 'oidc.claim', valueType: 'string' },
					{ key: 'name', label: 'name', namespace: 'oidc.claim', valueType: 'string' }
				]
			}
		},
		{
			id: 'schema-saml-gakunin',
			tenantId: TENANT_ID,
			protocol: 'saml',
			schemaKey: 'saml-gakunin',
			displayName: 'SAML GakuNin Attributes',
			versionLabel: 'v1',
			schemaVersion: '1.0',
			lifecycleState: 'active',
			schema: {
				fields: [
					{
						key: 'urn:oid:0.9.2342.19200300.100.1.3',
						label: 'mail',
						namespace: 'saml.attribute',
						valueType: 'string'
					},
					{
						key: 'urn:oid:2.5.4.3',
						label: 'cn',
						namespace: 'saml.attribute',
						valueType: 'string'
					}
				]
			}
		}
	];
}

function sampleDestinationProfiles() {
	return [
		{
			id: 'destination-profile-oidc-core',
			tenantId: TENANT_ID,
			destinationType: 'oidc',
			profileKey: 'oidc-core',
			displayName: 'OIDC Core Claims',
			ownerScopeType: 'tenant',
			ownerScopeId: TENANT_ID,
			lifecycleState: 'active',
			activeVersionId: 'destination-profile-version-oidc-core',
			version: {
				id: 'destination-profile-version-oidc-core',
				versionLabel: 'v1',
				lifecycleState: 'active',
				schema: { fields: ['email', 'name'] }
			}
		},
		{
			id: 'destination-profile-saml-sp',
			tenantId: TENANT_ID,
			destinationType: 'saml',
			profileKey: 'saml-sp-gakunin',
			displayName: 'SAML SP GakuNin Attribute Release',
			ownerScopeType: 'tenant',
			ownerScopeId: TENANT_ID,
			lifecycleState: 'active',
			activeVersionId: 'destination-profile-version-saml-sp',
			version: {
				id: 'destination-profile-version-saml-sp',
				versionLabel: 'v1',
				lifecycleState: 'active',
				schema: { fields: ['urn:oid:0.9.2342.19200300.100.1.3', 'urn:oid:2.5.4.3'] }
			}
		}
	];
}

function handleIdentityMapping(event: RequestEvent, segments: string[]): Response | null {
	const method = event.request.method;
	if (segments[0] === 'field-mapping-sets' && method === 'GET' && segments.length === 1) {
		return json({ fieldMappingSets });
	}
	if (segments[0] === 'field-mapping-sets' && method === 'POST' && segments.length === 1) {
		return json({
			result: {
				id: `field-mapping-dev-${fieldMappingSets.length + 1}`,
				tenantId: TENANT_ID,
				fieldMappingKey: 'dev-created-field-mapping',
				displayName: 'Dev created field mapping set',
				lifecycleState: 'draft'
			}
		});
	}
	if (segments[0] === 'field-mapping-sets' && segments[2] === 'versions' && method === 'GET') {
		return json({
			fieldMappingVersions: fieldMappingVersions.filter(
				(version) => version.fieldMappingSetId === segments[1]
			)
		});
	}
	if (segments[0] === 'field-mapping-sets' && segments[2] === 'versions' && method === 'POST') {
		return json({
			result: {
				id: `field-mapping-version-dev-${Date.now()}`,
				tenantId: TENANT_ID,
				fieldMappingSetId: segments[1],
				lifecycleState: 'draft'
			}
		});
	}
	if (segments[0] === 'field-mapping-sets' && method === 'DELETE') {
		return json({ success: true });
	}
	if (segments[0] === 'field-mapping-sets' && method === 'POST') {
		return json({ success: true, snapshotId: 'snapshot-gakunin-basic-v1' });
	}
	if (segments[0] === 'catalogs') {
		return json({
			catalogs: [
				{
					id: 'catalog-core',
					tenantId: TENANT_ID,
					catalogKey: 'authrim-core',
					displayName: 'Authrim Core Profile',
					versionId: 'catalog-version-core-v1',
					versionLabel: 'v1',
					lifecycleState: 'active',
					bundleHash: 'dev',
					entries: catalogEntries
				}
			]
		});
	}
	if (segments[0] === 'protocol-schemas') return json({ protocolSchemas: sampleProtocolSchemas() });
	if (segments[0] === 'external-schemas') return json({ externalSchemas: [] });
	if (segments[0] === 'source-profiles') {
		if (segments[1] === 'csv' && segments[2] === 'parse') {
			return json({
				result: {
					parseDraftId: 'parse-draft-dev',
					tenantId: TENANT_ID,
					sourceType: 'csv',
					schemaHash: 'dev',
					schema: { sourceType: 'csv', columns: [] },
					parserOptions: {},
					warningSummary: {},
					expiresAt: Date.now() + 3600000
				}
			});
		}
		return json({
			sourceProfiles: [
				{
					id: 'source-profile-gakunin-saml',
					tenantId: TENANT_ID,
					sourceType: 'csv',
					profileKey: 'gakunin-saml',
					displayName: 'GakuNin SAML Source',
					lifecycleState: 'active',
					activeVersionId: 'source-profile-version-gakunin-saml',
					version: {
						id: 'source-profile-version-gakunin-saml',
						versionLabel: 'v1',
						lifecycleState: 'active',
						schema: { sourceType: 'csv', columns: [] }
					}
				}
			]
		});
	}
	if (segments[0] === 'destination-profiles') {
		return json({ destinationProfiles: sampleDestinationProfiles() });
	}
	if (segments[0] === 'attribute-groups') return json({ attributeGroups: [] });
	if (segments[0] === 'attribute-fields') return json({ attributeFields: [] });
	if (segments[0] === 'templates') return json({ templates: [] });
	if (segments[0] === 'federation-trust-sources') {
		if (segments.length > 2 && segments[2] === 'metadata-documents') {
			return json({ federationMetadataDocuments: [] });
		}
		return json({ federationTrustSources: [] });
	}
	if (segments[0] === 'review-tasks') return json({ reviewTasks: [] });
	if (segments[0] === 'schema-readiness') {
		return json({
			rows: [],
			summary: { total: 0, pass: 0, attention: 0, blocked: 0, deferred: 0 }
		});
	}
	return null;
}

async function handleClients(event: RequestEvent, segments: string[]): Promise<Response | null> {
	const method = event.request.method;
	if (segments.length === 1 && method === 'GET') return json(listClients());
	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const id = createClientId(input.client_name);
		const client: DevClient = {
			client_id: id,
			client_name: String(input.client_name || id),
			description: typeof input.description === 'string' ? input.description : null,
			grant_types: Array.isArray(input.grant_types) ? input.grant_types.map(String) : [],
			response_types: Array.isArray(input.response_types)
				? input.response_types.map(String)
				: ['code'],
			redirect_uris: Array.isArray(input.redirect_uris) ? input.redirect_uris.map(String) : [],
			token_endpoint_auth_method: String(input.token_endpoint_auth_method || 'none'),
			scope: typeof input.scope === 'string' ? input.scope : 'openid profile email',
			identity_mapping:
				input.identity_mapping && typeof input.identity_mapping === 'object'
					? (input.identity_mapping as Record<string, unknown>)
					: null,
			created_at: Date.now(),
			updated_at: Date.now(),
			...input
		} as DevClient;
		clients.set(id, client);
		return json({ client }, 201);
	}

	const clientId = segments[1];
	const client = clients.get(clientId);
	if (!client)
		return json({ error: 'not_found', error_description: 'Dev mock client not found' }, 404);
	if (segments.length === 2 && method === 'GET') return json({ client });
	if (segments.length === 2 && method === 'PUT') {
		const input = await readJson(event.request);
		const updated = mergeClient(client, input);
		clients.set(clientId, updated);
		return json({ client: updated });
	}
	if (segments.length === 2 && method === 'DELETE') {
		clients.delete(clientId);
		return json({ success: true });
	}
	if (segments[2] === 'usage') {
		return json({
			tokens_issued_24h: 0,
			tokens_issued_7d: 0,
			tokens_issued_30d: 0,
			active_sessions: 0,
			last_token_issued_at: null
		});
	}
	if (segments[2] === 'regenerate-secret' && method === 'POST') {
		return json({ client_secret: 'dev_mock_secret' });
	}
	if (segments[2] === 'apply-preset' && method === 'POST') {
		return json(mergeClient(client, { updated_at: Date.now() }));
	}
	if (segments[2] === 'cache-mode') return json({ enabled: false, mode: 'default' });
	if (segments[2] === 'consent-overrides') return json({ overrides: [] });
	return null;
}

async function handleSamlProviders(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] === 'saml-settings') {
		return json({
			tenantId: TENANT_ID,
			entityIdStyle: 'role_url',
			interactiveLoginUrlPolicy: 'tenant_host',
			certificateSubject: {
				countryName: 'JP',
				stateOrProvinceName: 'Tokyo',
				localityName: 'Shinagawa',
				organizationName: 'Authrim',
				organizationalUnitName: 'Security',
				commonName: 'localhost'
			},
			certificateSubjectAlternativeNames: {
				includeGeneratedDnsNames: true,
				dnsNames: ['localhost']
			},
			metadata: {
				signingMode: 'enabled',
				signingEnabled: true,
				validUntilEnabled: true,
				idpValidUntil: new Date(NOW + 86400000).toISOString(),
				spValidUntil: new Date(NOW + 86400000).toISOString(),
				validityDays: 7,
				cacheDuration: 'PT1H'
			},
			generated: {
				issuerUrl: 'http://localhost:8787',
				idpEntityId: 'http://localhost:8787/saml/idp/metadata',
				spEntityId: 'http://localhost:8787/saml/sp/metadata',
				idpMetadataUrl: 'http://localhost:8787/saml/idp/metadata',
				spMetadataUrl: 'http://localhost:8787/saml/sp/metadata'
			},
			localSigning: {
				certificateSubject: {
					countryName: 'JP',
					stateOrProvinceName: 'Tokyo',
					localityName: 'Shinagawa',
					organizationName: 'Authrim',
					organizationalUnitName: 'Security',
					commonName: 'localhost'
				},
				certificateSubjectAlternativeNames: {
					includeGeneratedDnsNames: true,
					dnsNames: ['localhost']
				},
				idpSigningKeyPolicy: {},
				spSigningKeyPolicy: {}
			}
		});
	}
	if (segments[0] === 'saml-attribute-presets') {
		return json({
			presets: [
				{
					id: 'gakunin-basic',
					version: 'v1',
					profile: 'gakunin',
					label: 'GakuNin basic',
					description: 'Dev mock GakuNin attribute preset',
					stability: 'stable',
					applicationMode: 'replace',
					appliesTo: 'sp_attribute_release',
					attributeReleasePolicy: { attributes: [] }
				}
			]
		});
	}
	if (segments[0] === 'saml-metadata') {
		return json({ kind: 'single', providerType: 'saml_sp', config: {} });
	}
	if (segments[0] !== 'saml-providers') return null;
	if (segments.length === 1 && method === 'GET')
		return json({ providers: [...samlProviders.values()] });
	if (segments.length === 1 && method === 'POST') {
		const input = await readJson(event.request);
		const id = `dev-saml-${samlProviders.size + 1}`;
		const provider: DevSamlProvider = {
			id,
			name: String(input.name || id),
			providerType: input.providerType === 'saml_idp' ? 'saml_idp' : 'saml_sp',
			config:
				input.config && typeof input.config === 'object'
					? (input.config as Record<string, unknown>)
					: {},
			enabled: input.enabled !== false,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};
		samlProviders.set(id, provider);
		return json(provider, 201);
	}

	const providerId = segments[1];
	const provider = samlProviders.get(providerId);
	if (!provider) {
		return json({ error: 'not_found', error_description: 'Dev mock SAML provider not found' }, 404);
	}
	if (segments.length === 2 && method === 'GET') return json(provider);
	if (segments.length === 2 && method === 'PUT') {
		const input = await readJson(event.request);
		const updated = {
			...provider,
			name: typeof input.name === 'string' ? input.name : provider.name,
			enabled: typeof input.enabled === 'boolean' ? input.enabled : provider.enabled,
			config:
				input.config && typeof input.config === 'object'
					? (input.config as Record<string, unknown>)
					: provider.config,
			updatedAt: new Date().toISOString()
		};
		samlProviders.set(providerId, updated);
		return json(updated);
	}
	if (segments.length === 2 && method === 'DELETE') {
		samlProviders.delete(providerId);
		return json({ success: true });
	}
	if (segments.length > 2 && method === 'POST') return json(provider);
	return null;
}

async function handleSettings(event: RequestEvent, segments: string[]): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] === 'settings') {
		if (segments[1] === 'meta') {
			return json({ categories: [{ category: 'tenant', label: 'Tenant', settingsCount: 1 }] });
		}
		return null;
	}

	if (segments[0] === 'platform' && segments[1] === 'settings') {
		return json(getSettings(TENANT_ID, segments[2] || 'platform'));
	}

	if (segments[0] !== 'tenants') return null;
	if (segments.length === 1 && method === 'GET') {
		return json({
			tenants: [
				{
					id: TENANT_ID,
					tenant_code: 'dev',
					name: 'Dev Tenant',
					description: 'Local Admin UI mock tenant',
					lifecycle_state: 'active',
					is_default: true,
					created_at: NOW,
					updated_at: NOW
				}
			],
			total: 1,
			tenant_d1_pool: { enabled: false },
			single_tenant_mode: false,
			single_tenant_reason: null
		});
	}
	if (segments[2] === 'clients') return json(listClients());
	if (segments[2] === 'settings') {
		const tenantId = segments[1] || getTenantId(event);
		const category = segments[3] || 'tenant';
		const current = getSettings(tenantId, category);
		if (method === 'GET') return json(current);
		if (method === 'PATCH') {
			const input = await readJson(event.request);
			const set =
				input.set && typeof input.set === 'object' && !Array.isArray(input.set)
					? (input.set as Record<string, unknown>)
					: {};
			const clear = Array.isArray(input.clear) ? input.clear.map(String) : [];
			for (const [key, value] of Object.entries(set)) {
				if (value !== undefined) {
					current.values[key] = value;
					current.sources[key] = 'kv';
				}
			}
			for (const key of clear) {
				delete current.values[key];
				delete current.sources[key];
			}
			current.version = nextVersion(current.version);
			return json({
				applied: Object.keys(set),
				cleared: clear,
				disabled: [],
				rejected: {},
				version: current.version
			});
		}
	}
	return null;
}

async function handleScopedClientSettings(
	event: RequestEvent,
	segments: string[]
): Promise<Response | null> {
	const method = event.request.method;
	if (segments[0] !== 'clients' || segments[2] !== 'settings') return null;
	const clientId = segments[1];
	const category = segments[3] || 'client';
	const current = getSettings(getTenantId(event), category, clientId);
	if (method === 'GET') return json(current);
	if (method === 'PATCH') {
		const input = await readJson(event.request);
		const set =
			input.set && typeof input.set === 'object' && !Array.isArray(input.set)
				? (input.set as Record<string, unknown>)
				: {};
		for (const [key, value] of Object.entries(set)) {
			if (value !== undefined) {
				current.values[key] = value;
				current.sources[key] = 'kv';
			}
		}
		current.version = nextVersion(current.version);
		return json({
			applied: Object.keys(set),
			cleared: [],
			disabled: [],
			rejected: {},
			version: current.version
		});
	}
	return null;
}

export async function handleDevAdminMock(
	event: RequestEvent,
	platformEnv: EnvLike
): Promise<Response | null> {
	if (!isDevAdminMockEnabled(event, platformEnv)) return null;
	if (event.url.pathname !== '/api/admin' && !event.url.pathname.startsWith('/api/admin/')) {
		return null;
	}

	const segments = event.url.pathname
		.replace(/^\/api\/admin\/?/, '')
		.split('/')
		.filter(Boolean)
		.map(decodeURIComponent);

	if (segments.length === 0) return json({ ok: true, mode: 'dev-admin-mock' });
	if (segments[0] === 'me' && segments[1] === 'session') {
		return json({
			active: true,
			user_id: 'dev-admin',
			tenant_id: TENANT_ID,
			email: 'dev-admin@localhost',
			name: 'Dev Admin',
			roles: ['platform_admin', 'tenant_admin'],
			permissions: ['*'],
			admin_scope: 'platform',
			is_platform_admin: true,
			expires_at: Math.floor(Date.now() / 1000) + 86400,
			created_at: Math.floor(NOW / 1000),
			last_login_at: Math.floor(NOW / 1000)
		});
	}
	if (segments[0] === 'logout') return json({ success: true });
	if (segments[0] === 'client-profile-presets') {
		return json({
			presets: [
				{
					id: 'authrim-websdk',
					name: 'Authrim WebSDK',
					description: 'Dev mock preset',
					clientType: 'public'
				}
			]
		});
	}
	if (segments[0] === 'field-mapping') return handleIdentityMapping(event, segments.slice(1));
	if (
		segments[0] === 'saml-providers' ||
		segments[0] === 'saml-settings' ||
		segments[0].startsWith('saml-')
	) {
		const response = await handleSamlProviders(event, segments);
		if (response) return response;
	}
	const scopedClientSettings = await handleScopedClientSettings(event, segments);
	if (scopedClientSettings) return scopedClientSettings;
	if (segments[0] === 'clients') {
		const response = await handleClients(event, segments);
		if (response) return response;
	}
	const settingsResponse = await handleSettings(event, segments);
	if (settingsResponse) return settingsResponse;
	if (segments[0] === 'logging-policies' && segments[1] === 'notifications') {
		return json({ items: [], total: 0 });
	}
	if (segments[0] === 'notifications') return json({ items: [], total: 0 });
	if (segments[0] === 'stats') return json({ totals: {}, recent: [] });

	return json(
		{
			error: 'dev_mock_not_implemented',
			error_description: `Admin UI dev mock has no handler for ${event.url.pathname}`
		},
		404
	);
}
