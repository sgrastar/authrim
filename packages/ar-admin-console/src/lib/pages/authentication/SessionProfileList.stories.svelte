<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeSessionProfiles } from '#lib/api/fake/session-profiles-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SessionProfileList from './SessionProfileList.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/Session profiles',
		component: SessionProfileList,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Authentication → Session profiles: how long a session lasts, whether it can be extended and single sign-on, by name (`/api/admin/session-profiles`). Default is the tenant’s own session settings; a sign-in or sign-up service flow chooses one.'
				}
			}
		}
	});
	const hrefOf = (id: string) => `/admin/authentication/session-profiles/${id}`;
	const onopen = fn();
</script>

<Story
	name="Default only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: t('sp.list.open', { name: 'Default' }) });
		await expect(canvas.getByText(new RegExp(t('sp.list.ssoOn')))).toBeInTheDocument();
		await expect(canvas.getByRole('link', { name: t('sp.list.create') })).toHaveAttribute(
			'href',
			hrefOf('new')
		);
	}}
>
	{#snippet template()}
		<SessionProfileList client={createFakeSessionProfiles()} canWrite {hrefOf} {onopen} />
	{/snippet}
</Story>

<Story
	name="Saved profiles"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Kiosk');
		await expect(canvas.getByText(new RegExp(t('sp.list.ssoOff')))).toBeInTheDocument();
		await userEvent.click(canvas.getByText('Kiosk'));
		await waitFor(() => expect(onopen).toHaveBeenCalledWith('sp_kiosk'));
	}}
>
	{#snippet template()}
		<SessionProfileList
			client={createFakeSessionProfiles([
				{
					id: 'sp_kiosk',
					name: 'Kiosk',
					is_system: false,
					version: 1,
					values: { 'session.default_ttl': 900_000, 'oauth.sso_enabled': false },
					created_at: Date.UTC(2026, 10, 1),
					updated_at: Date.UTC(2026, 10, 7)
				}
			])}
			canWrite
			{hrefOf}
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="View only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: t('sp.list.open', { name: 'Default' }) });
		await expect(canvas.queryByRole('link', { name: t('sp.list.create') })).toBeNull();
	}}
>
	{#snippet template()}
		<SessionProfileList client={createFakeSessionProfiles()} canWrite={false} {hrefOf} {onopen} />
	{/snippet}
</Story>
