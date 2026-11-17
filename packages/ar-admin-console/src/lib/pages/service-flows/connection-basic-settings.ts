import { readAdvanced, RP_FIELDS, SP_FIELDS } from './advanced-settings';
import { publicKeyInput } from './public-client-keys';
import type { ClientDetail, ClientSettingsClient, ClientBasicUpdate } from '#lib/api/clients.js';
import type {
	SamlServiceProvider,
	SamlSettingsClient,
	SamlMetadataClient,
	SamlActivationClient
} from '#lib/api/saml-providers.js';
import { emptyAnswers, type Answers } from './connection-model';

export type ConnectionSettingsResources =
	| { kind: 'rp'; detail: ClientDetail; client: ClientSettingsClient }
	| {
			kind: 'sp';
			detail: SamlServiceProvider;
			client: SamlSettingsClient & SamlActivationClient;
			metadata?: SamlMetadataClient;
			canPreviewMetadata?: boolean;
			canImportMetadata?: boolean;
	  };

export function basicSettingsAnswers(
	resources: ConnectionSettingsResources
): Answers & { advanced: Record<string, unknown> } {
	const answers = emptyAnswers(true);
	answers.kind = resources.kind;
	answers.direction = 'out';
	answers.rp.name = resources.detail.name;
	if (resources.kind === 'rp') {
		answers.rp.redirectUris = [...resources.detail.redirectUris];
		answers.rp.authMethod = resources.detail.authMethod ?? '';
		answers.rp.appType =
			resources.detail.applicationType === 'spa'
				? 'spa'
				: resources.detail.applicationType === 'native'
					? 'native'
					: 'web';
		answers.rp.jwksUri = resources.detail.jwksUri ?? '';
		answers.rp.publicJwks = resources.detail.jwks
			? JSON.stringify(resources.detail.jwks, null, 2)
			: '';
		answers.rp.keySource = resources.detail.jwksUri
			? 'uri'
			: resources.detail.jwks
				? 'inline'
				: 'uri';
		// Null has its own read-only explanation; it is never sent as a default false.
		answers.rp.pkce = resources.detail.pkce === true;
	} else {
		answers.sp.entityId = resources.detail.entityId;
		answers.sp.acsUrl = resources.detail.acsUrl;
		answers.sp.importMode = 'manual';
		answers.active = resources.detail.enabled;
	}
	return Object.assign(answers, {
		advanced:
			resources.kind === 'rp'
				? readAdvanced(resources.detail.advanced, RP_FIELDS)
				: readAdvanced(resources.detail.config, SP_FIELDS)
	});
}

/** A partial update contains intended edits and public keys only; secrets and mapping are never copied. */
export function clientBasicUpdate(source: ClientDetail, answers: Answers): ClientBasicUpdate {
	const value = answers.rp;
	const update: ClientBasicUpdate = {};
	if (value.name.trim() !== source.name) update.client_name = value.name.trim();
	if (JSON.stringify(value.redirectUris) !== JSON.stringify(source.redirectUris))
		update.redirect_uris = [...value.redirectUris];
	if (value.authMethod !== (source.authMethod ?? '')) {
		if (
			(value.authMethod !== 'private_key_jwt' &&
				((source.authMethod !== 'client_secret_basic' &&
					source.authMethod !== 'client_secret_post') ||
					(value.authMethod !== 'client_secret_basic' &&
						value.authMethod !== 'client_secret_post'))) ||
			source.authMethod === 'none' ||
			(value.authMethod === 'private_key_jwt' &&
				(source.applicationType === 'spa' || source.applicationType === 'native'))
		)
			throw new Error('Unsupported credential transition');
		if (
			value.authMethod === 'client_secret_basic' ||
			value.authMethod === 'client_secret_post' ||
			value.authMethod === 'private_key_jwt'
		)
			update.token_endpoint_auth_method = value.authMethod;
	}
	if (source.pkce !== null && value.pkce !== source.pkce) {
		if (source.authMethod === 'none' && !value.pkce) throw new Error('Public clients require PKCE');
		update.require_pkce = value.pkce;
	}
	if (value.authMethod === 'private_key_jwt') {
		const before = {
			keySource: source.jwksUri ? 'uri' : source.jwks ? 'inline' : 'uri',
			jwksUri: source.jwksUri ?? '',
			publicJwks: source.jwks ? JSON.stringify(source.jwks, null, 2) : ''
		};
		if (
			value.authMethod !== source.authMethod ||
			value.keySource !== before.keySource ||
			value.jwksUri !== before.jwksUri ||
			value.publicJwks !== before.publicJwks
		)
			Object.assign(update, publicKeyInput(value));
	}
	if (source.updatedAt !== undefined) update.expected_updated_at = source.updatedAt;
	return update;
}
