import type { ClientDetail, ClientSettingsClient, ClientBasicUpdate } from '#lib/api/clients.js';
import type {
	SamlServiceProvider,
	SamlSettingsClient,
	SamlActivationClient
} from '#lib/api/saml-providers.js';
import { emptyAnswers, type Answers } from './connection-model';

export type ConnectionSettingsResources =
	| { kind: 'rp'; detail: ClientDetail; client: ClientSettingsClient }
	| { kind: 'sp'; detail: SamlServiceProvider; client: SamlSettingsClient & SamlActivationClient };

export function basicSettingsAnswers(resources: ConnectionSettingsResources): Answers {
	const answers = emptyAnswers();
	answers.kind = resources.kind;
	answers.direction = 'out';
	answers.rp.name = resources.detail.name;
	if (resources.kind === 'rp') {
		answers.rp.redirectUris = [...resources.detail.redirectUris];
		answers.rp.authMethod = resources.detail.authMethod ?? '';
		// Null has its own read-only explanation; it is never sent as a default false.
		answers.rp.pkce = resources.detail.pkce === true;
	} else {
		answers.sp.entityId = resources.detail.entityId;
		answers.sp.acsUrl = resources.detail.acsUrl;
		answers.sp.importMode = 'manual';
		answers.active = resources.detail.enabled;
	}
	return answers;
}

/** A partial update contains only intended basic edits, never a credential or mapping. */
export function clientBasicUpdate(source: ClientDetail, answers: Answers): ClientBasicUpdate {
	const value = answers.rp;
	const update: ClientBasicUpdate = {};
	if (value.name.trim() !== source.name) update.client_name = value.name.trim();
	if (JSON.stringify(value.redirectUris) !== JSON.stringify(source.redirectUris))
		update.redirect_uris = [...value.redirectUris];
	if (value.authMethod !== (source.authMethod ?? '')) {
		if (
			(source.authMethod !== 'client_secret_basic' && source.authMethod !== 'client_secret_post') ||
			(value.authMethod !== 'client_secret_basic' && value.authMethod !== 'client_secret_post')
		)
			throw new Error('Unsupported credential transition');
		update.token_endpoint_auth_method = value.authMethod;
	}
	if (source.pkce !== null && value.pkce !== source.pkce) {
		if (source.authMethod === 'none' && !value.pkce) throw new Error('Public clients require PKCE');
		update.require_pkce = value.pkce;
	}
	return update;
}
