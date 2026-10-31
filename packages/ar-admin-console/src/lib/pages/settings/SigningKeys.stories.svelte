<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { adminAccess } from '$lib/access/admin-access.svelte';
	import { createFakeSettings } from '$lib/api/fake/settings-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import SigningKeys from './SigningKeys.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Settings/Signing keys',
		component: SigningKeys,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Settings → Signing keys: the algorithm the tenant signs ID tokens with (`oauth.id_token_signing_alg`) and whether apps may choose their own (`oauth.id_token_signing_alg_client_override`). One algorithm other than RS256, with apps unable to choose, departs from OpenID Connect Discovery: the page says so while the admin chooses.'
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
		await canvas.findAllByText(t('set.k.oauth.id_token_signing_alg'));
		expect(canvas.queryByText(t('settings.notice.idTokenAlgorithm.title'))).toBeNull();
	}}
>
	{#snippet template()}
		<SigningKeys client={settings()} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="One algorithm other than RS256"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('settings.notice.idTokenAlgorithm.title'));
	}}
>
	{#snippet template()}
		<SigningKeys
			client={settings({
				'oauth.id_token_signing_alg': 'ES256',
				'oauth.id_token_signing_alg_client_override': false
			})}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>
