import { ApiError } from '#lib/api/api-error.js';
import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
import type { ClientBasicUpdate, ClientDetail } from '#lib/api/clients.js';

export interface LiveClientFixtureOptions {
	auth?: string;
	enabled?: boolean;
	advanced?: boolean;
	redirects?: string[];
	ciba?: boolean;
	pkce?: boolean;
	missingKeys?: boolean;
	activationCancelled?: boolean;
	refuseMissingCallbacks?: boolean;
}

function enableBlockers(client: ClientDetail): string[] {
	const grants: unknown[] = Array.isArray(client.advanced?.grant_types)
		? client.advanced.grant_types
		: ['authorization_code'];
	return [
		...(grants.some((grant) => grant === 'authorization_code' || grant === 'implicit') &&
		!client.redirectUris.length
			? ['redirect_uris']
			: []),
		...(client.authMethod === 'none' && grants.includes('authorization_code') && !client.pkce
			? ['require_pkce']
			: []),
		...(client.authMethod === 'none' && grants.includes('urn:openid:params:grant-type:ciba')
			? ['token_endpoint_auth_method']
			: []),
		...(client.authMethod === 'private_key_jwt' && !client.jwksUri && !client.jwks ? ['jwks'] : [])
	];
}

/** Reset server state between stories, including when the same story runs again. */
export function liveClientSettingsFixture(options: LiveClientFixtureOptions = {}) {
	const initial: ClientDetail = {
		id: 'portal',
		name: 'Staff portal',
		enabled: options.enabled ?? false,
		enableBlockers: [],
		redirectUris: options.redirects ?? ['https://portal.example.test/callback'],
		applicationType: 'web',
		authMethod: options.auth ?? 'client_secret_basic',
		pkce: options.pkce ?? true,
		updatedAt: 1000,
		...(options.auth === 'private_key_jwt' && !options.missingKeys
			? { jwksUri: 'https://keys.example.test/jwks' }
			: {}),
		advanced: {
			...(options.ciba
				? {
						grant_types: ['urn:openid:params:grant-type:ciba'],
						response_types: [],
						backchannel_token_delivery_mode: 'poll'
					}
				: {}),
			...(options.advanced
				? {
						description: 'Stored note',
						id_token_signed_response_alg: 'PS256',
						default_audience: 'https://api.example.test'
					}
				: {})
		}
	};
	initial.enableBlockers = enableBlockers(initial);
	let stored = structuredClone(initial);
	const client = {
		get: async (_id: string) => structuredClone(stored),
		setEnabled: async (_id: string, enabled: boolean, expectedUpdatedAt: number) => {
			if (expectedUpdatedAt !== stored.updatedAt) throw new ApiError(409, 'conflict', 'Conflict');
			if (options.activationCancelled) throw new StepUpCancelledError();
			if (enabled && stored.enableBlockers.length)
				throw new ApiError(400, 'client_configuration_required_to_enable', 'Missing settings', {
					missing: [...stored.enableBlockers]
				});
			stored = { ...stored, enabled, updatedAt: expectedUpdatedAt + 1 };
			return structuredClone(stored);
		},
		updateBasics: async (_id: string, input: ClientBasicUpdate) => {
			if (input.expected_updated_at !== undefined && input.expected_updated_at !== stored.updatedAt)
				throw new ApiError(409, 'conflict', 'Conflict');
			const next: ClientDetail = {
				...stored,
				name: input.client_name ?? stored.name,
				redirectUris: input.redirect_uris ?? stored.redirectUris,
				authMethod: input.token_endpoint_auth_method ?? stored.authMethod,
				pkce: input.require_pkce ?? stored.pkce,
				...(input.jwks_uri !== undefined ? { jwksUri: input.jwks_uri } : {}),
				...(input.jwks !== undefined ? { jwks: input.jwks } : {}),
				advanced: { ...stored.advanced, ...input.advanced },
				updatedAt: (stored.updatedAt ?? 1000) + 1
			};
			next.enableBlockers = enableBlockers(next);
			if (
				options.refuseMissingCallbacks &&
				next.enabled &&
				input.redirect_uris !== undefined &&
				next.enableBlockers.includes('redirect_uris')
			)
				throw new ApiError(
					400,
					'client_configuration_required_to_enable',
					'Missing redirect_uris',
					{
						missing: ['redirect_uris']
					}
				);
			stored = next;
			return structuredClone(stored);
		}
	};
	return { client, reset: () => (stored = structuredClone(initial)) };
}
