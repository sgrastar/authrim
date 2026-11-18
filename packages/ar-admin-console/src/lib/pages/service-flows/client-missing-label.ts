import { t } from '#lib/i18n/i18n.svelte.js';
const keys = {
	grant_types: 'sf.rp.missing.grant_types',
	redirect_uris: 'sf.rp.missing.redirect_uris',
	jwks: 'sf.rp.missing.jwks',
	client_secret: 'sf.rp.missing.client_secret',
	require_pkce: 'sf.rp.missing.require_pkce',
	token_endpoint_auth_method: 'sf.rp.missing.token_endpoint_auth_method',
	response_types: 'sf.rp.missing.response_types',
	sector_identifier_uri: 'sf.rp.missing.sector_identifier_uri',
	backchannel_client_notification_endpoint: 'sf.rp.missing.backchannel_client_notification_endpoint'
} as const;
export function clientMissingLabel(field: string): string {
	return field in keys ? t(keys[field as keyof typeof keys]) : t('sf.rp.missing.configuration');
}
