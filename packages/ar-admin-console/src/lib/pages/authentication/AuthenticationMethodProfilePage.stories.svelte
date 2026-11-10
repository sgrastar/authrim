<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeAuthenticationMethodProfiles } from '#lib/api/fake/authentication-method-profiles-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AuthenticationMethodProfilePage from './AuthenticationMethodProfilePage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/Sign-in method profile',
		component: AuthenticationMethodProfilePage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'A profile detail page with the same inline name editing as themes. The method fields are a separate responsive component that can also be mounted in a service-flow side panel.'
				}
			}
		}
	});
	const oncreated = fn();
	const directoryStatusClient = { get: async () => 'unconfigured' as const };
</script>

<Story
	name="Create profile"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: t('am.page.name') });
		await userEvent.type(name, 'Members');
		await userEvent.click(canvas.getByRole('button', { name: t('am.page.nameDone') }));
		await expect(canvas.getByRole('heading', { name: 'Members' })).toBeInTheDocument();
		await userEvent.click(await canvas.findByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(oncreated).toHaveBeenCalledWith('amp_1'));
	}}
>
	{#snippet template()}
		<AuthenticationMethodProfilePage
			client={createFakeAuthenticationMethodProfiles()}
			{directoryStatusClient}
			tenantId="acme"
			id="new"
			canWrite
			listHref="/admin/authentication/methods"
			{oncreated}
		/>
	{/snippet}
</Story>

<Story
	name="Default profile"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Default' });
		await expect(canvas.getByText(t('am.methods.totp'))).toBeInTheDocument();
		await canvas.findByText(t('am.methods.notConfigured'));
		await expect(
			canvas.getByRole('link', { name: t('am.methods.directorySettings') })
		).toHaveAttribute('href', '/admin/authentication/directory');
		const did = canvas.getByRole('checkbox', { name: /DID/ });
		await expect(did).not.toBeChecked();
		await userEvent.click(did);
		const bar = await canvas.findByRole('region', { name: t('common.unsaved') });
		await userEvent.click(within(bar).getByRole('button', { name: t('common.discard') }));
		await waitFor(() => expect(did).not.toBeChecked());
		await waitFor(() =>
			expect(canvas.queryByRole('region', { name: t('common.unsaved') })).toBeNull()
		);
	}}
>
	{#snippet template()}
		<AuthenticationMethodProfilePage
			client={createFakeAuthenticationMethodProfiles()}
			{directoryStatusClient}
			tenantId="acme"
			id="default"
			canWrite
			listHref="/admin/authentication/methods"
			{oncreated}
		/>
	{/snippet}
</Story>
