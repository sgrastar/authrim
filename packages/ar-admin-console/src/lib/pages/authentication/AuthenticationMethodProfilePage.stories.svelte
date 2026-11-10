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
</script>

<Story
	name="Create profile"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: t('am.page.name') });
		await userEvent.type(name, 'Members');
		await userEvent.click(canvas.getByRole('button', { name: t('am.page.save') }));
		await waitFor(() => expect(oncreated).toHaveBeenCalledWith('amp_1'));
	}}
>
	{#snippet template()}
		<AuthenticationMethodProfilePage
			client={createFakeAuthenticationMethodProfiles()}
			id="new"
			canWrite
			listHref="/admin/authentication/methods"
			{oncreated}
		/>
	{/snippet}
</Story>

<Story name="Default profile">
	{#snippet template()}
		<AuthenticationMethodProfilePage
			client={createFakeAuthenticationMethodProfiles()}
			id="default"
			canWrite
			listHref="/admin/authentication/methods"
			{oncreated}
		/>
	{/snippet}
</Story>
