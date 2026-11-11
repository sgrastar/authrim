<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, waitFor, within } from 'storybook/test';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { createFakeSettings } from '#lib/api/fake/settings-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import TokensAndProtocols from './TokensAndProtocols.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/Tokens and protocols',
		component: TokensAndProtocols,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Authentication → Tokens and protocols: how long the tokens apps receive last (access, ID and refresh tokens, rotation), and what every app of the tenant must meet — PKCE, HTTPS redirect URIs, DPoP-bound tokens, signed or encrypted request objects (a floor an app can raise but not lower) — with FAPI, token exchange (the tenant’s delegation and impersonation ceilings, both off unless set), token introspection and the SCIM token lifetime.'
				}
			}
		}
	});

	const TENANT = 'acme';
	const settings = (stored: Record<string, unknown> = {}) =>
		createFakeSettings({
			access: () => adminAccess.current,
			latency: 200,
			stored: { [`tenant:${TENANT}`]: stored }
		});
</script>

<Story
	name="Defaults"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(t('set.k.oauth.access_token_expiry'));
		await canvas.findAllByText(t('set.k.security.pkce_required'));
		await canvas.findAllByText(t('set.k.security.https_redirect_only'));
		await canvas.findAllByText(t('set.k.tokens.introspection_extended_claims'));
		await canvas.findAllByText(t('set.k.federation.scim_token_default_expiry'));
		expect(canvas.queryByText(t('settings.notice.fapi.title'))).toBeNull();
		expect(canvas.queryByText(t('settings.notice.exchangeCeilings.title'))).toBeNull();
	}}
>
	{#snippet template()}
		<TokensAndProtocols client={settings()} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="Strict tenant with FAPI"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('settings.notice.fapi.title'));
	}}
>
	{#snippet template()}
		<TokensAndProtocols
			client={settings({
				'security.pkce_required': true,
				'security.dpop_bound_access_tokens': true,
				'security.require_encrypted_request_object': true,
				'security.fapi_enabled': true
			})}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>

<Story
	name="Token exchange on, delegation not allowed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('settings.notice.exchangeCeilings.title'));
	}}
>
	{#snippet template()}
		<TokensAndProtocols client={settings({ 'tokens.exchange_enabled': true })} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="Token exchange on, delegation allowed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(t('set.k.tokens.exchange_delegation_enabled'));
		expect(canvas.queryByText(t('settings.notice.exchangeCeilings.title'))).toBeNull();
	}}
>
	{#snippet template()}
		<TokensAndProtocols
			client={settings({
				'tokens.exchange_enabled': true,
				'tokens.exchange_delegation_enabled': true
			})}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>

<Story
	name="Token lifetime fixed by the platform"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// A fixed lifetime says why and shows its value; there is nothing to change.
		await waitFor(() =>
			expect(canvas.getAllByText(t('settings.locked.platform')).length).toBeGreaterThan(0)
		);
	}}
>
	{#snippet template()}
		<TokensAndProtocols
			client={createFakeSettings({
				access: () => adminAccess.current,
				latency: 200,
				locked: ['oauth.access_token_expiry', 'oauth.refresh_token_rotation']
			})}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>
