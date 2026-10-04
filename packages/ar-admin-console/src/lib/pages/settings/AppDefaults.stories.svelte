<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { adminAccess } from '$lib/access/admin-access.svelte';
	import { createFakeSettings } from '$lib/api/fake/settings-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import AppDefaults from './AppDefaults.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Applications/App defaults',
		component: AppDefaults,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Applications → App defaults: what every app of the tenant must meet — PKCE, HTTPS redirect URIs, DPoP-bound tokens, signed or encrypted request objects (a floor an app can raise but not lower) — with FAPI and token exchange. Delegation and impersonation are still in development: shown, but not editable.'
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
		await canvas.findAllByText(t('set.k.security.pkce_required'));
		await canvas.findAllByText(t('set.k.security.https_redirect_only'));
		expect(canvas.queryByText(t('settings.notice.fapi.title'))).toBeNull();
	}}
>
	{#snippet template()}
		<AppDefaults client={settings()} tenantId={TENANT} />
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
		<AppDefaults
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
