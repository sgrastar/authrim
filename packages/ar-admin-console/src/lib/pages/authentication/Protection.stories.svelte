<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { adminAccess } from '$lib/access/admin-access.svelte';
	import { createFakeSettings } from '$lib/api/fake/settings-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import { settingText } from '$lib/settings/setting-text';
	import Protection from './Protection.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/Attack protection',
		component: Protection,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Authentication → Attack protection: how often an emailed code (sign-in, sign-up, re-authentication, directory migration) can be sent to the same address within a period. Built from the Settings API `rate-limit` settings by its placement (`PROTECTION` in `settings/placement.ts`). The failed sign-in lockout, bot protection and API rate limits move here as they are built.'
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
	const label = (key: string) => t(settingText(key).label);
</script>

<Story
	name="Defaults"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(label('rate_limit.email_max_requests'));
		await canvas.findAllByText(label('rate_limit.email_window'));
	}}
>
	{#snippet template()}
		<Protection client={settings()} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="Stricter email limit"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(label('rate_limit.email_max_requests'));
		expect(canvas.queryByText(t('load.error.title'))).toBeNull();
	}}
>
	{#snippet template()}
		<Protection
			client={settings({ 'rate_limit.email_max_requests': 2, 'rate_limit.email_window': 3600 })}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>
