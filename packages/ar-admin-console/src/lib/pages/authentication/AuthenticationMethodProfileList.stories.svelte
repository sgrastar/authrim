<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeAuthenticationMethodProfiles } from '#lib/api/fake/authentication-method-profiles-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AuthenticationMethodProfileList from './AuthenticationMethodProfileList.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/Sign-in method profiles',
		component: AuthenticationMethodProfileList,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Saved authentication method profiles. Default reflects the tenant-wide settings. New profiles are stored independently and can later be selected by a service flow.'
				}
			}
		}
	});
	const hrefOf = (id: string) => `/admin/authentication/methods/${id}`;
	const onopen = fn();
</script>

<Story
	name="Default only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: t('am.list.open', { name: 'Default' }) });
		await expect(
			canvas.getByRole('columnheader', { name: t('am.list.usage') })
		).toBeInTheDocument();
		await expect(canvas.getByText(t('am.usage.default'))).toBeInTheDocument();
		await expect(canvas.getByText(t('am.list.active'))).toBeInTheDocument();
		await expect(canvas.getByRole('link', { name: t('am.list.create') })).toHaveAttribute(
			'href',
			hrefOf('new')
		);
	}}
>
	{#snippet template()}
		<AuthenticationMethodProfileList
			client={createFakeAuthenticationMethodProfiles()}
			canWrite
			{hrefOf}
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Saved profiles"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Members');
		await expect(canvas.getByText(t('am.usage.none'))).toBeInTheDocument();
		await userEvent.click(canvas.getByText('Members'));
		await waitFor(() => expect(onopen).toHaveBeenCalledWith('amp_members'));
	}}
>
	{#snippet template()}
		<AuthenticationMethodProfileList
			client={createFakeAuthenticationMethodProfiles([
				{
					id: 'amp_members',
					name: 'Members',
					is_system: false,
					version: 2,
					values: {
						'authentication-methods.passkey.login_enabled': true,
						'authentication-methods.did.login_enabled': true,
						'authentication-methods.directory_password.enabled': true
					},
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
