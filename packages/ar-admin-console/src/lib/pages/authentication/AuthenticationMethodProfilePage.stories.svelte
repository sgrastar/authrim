<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { ApiError } from '#lib/api/api-error.js';
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
	/** A tenant that already has a profile of every name: creating one is refused. */
	const nameTaken = () => ({
		...createFakeAuthenticationMethodProfiles(),
		async create() {
			throw new ApiError(409, 'profile_name_taken', 'Profile name already exists', {
				error: 'profile_name_taken'
			});
		}
	});
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
	name="Unset methods show as on"
	parameters={{
		docs: {
			description: {
				story:
					'A profile only narrows: a method it leaves unset is allowed at sign-in, so it shows (and saves) as on. Only an explicit off is unchecked.'
			}
		}
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: 'Partners' });
		const [passkeyLogin] = canvas.getAllByRole('checkbox', {
			name: new RegExp(t('am.methods.passkey'))
		});
		await expect(passkeyLogin).toBeChecked();
		await expect(canvas.getByRole('checkbox', { name: /DID/ })).not.toBeChecked();
		// Shown as on is not a change: nothing to save.
		await expect(canvas.queryByRole('region', { name: t('common.unsaved') })).toBeNull();
	}}
>
	{#snippet template()}
		<AuthenticationMethodProfilePage
			client={createFakeAuthenticationMethodProfiles([
				{
					id: 'amp_partners',
					name: 'Partners',
					is_system: false,
					values: { 'authentication-methods.did.login_enabled': false },
					version: 1,
					created_at: null,
					updated_at: null,
					layer: null
				}
			])}
			{directoryStatusClient}
			tenantId="acme"
			id="amp_partners"
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

<!-- Save with no name: the editor says so under the field and takes the admin there. -->
<Story
	name="Saving without a name"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: t('am.page.name') });
		await userEvent.click(canvas.getByRole('checkbox', { name: /DID/ }));
		await userEvent.click(await canvas.findByRole('button', { name: t('common.save') }));
		await expect(await canvas.findByText(t('am.page.nameRequired'))).toBeInTheDocument();
		await expect(name).toHaveAttribute('aria-invalid', 'true');
		await waitFor(() => expect(name).toHaveFocus());
		// Saving again without a name takes the admin back to the field.
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(name).toHaveFocus());
		// Done with nothing in the field is the same problem, and the save bar knows it.
		await userEvent.click(canvas.getByRole('button', { name: t('am.page.nameDone') }));
		await expect(await canvas.findByText(t('common.fixErrors'))).toBeInTheDocument();
		// Discarding clears it and leaves the admin in the field.
		await userEvent.click(canvas.getByRole('button', { name: t('common.discard') }));
		await waitFor(() => expect(canvas.queryByText(t('am.page.nameRequired'))).toBeNull());
		await waitFor(() =>
			expect(canvas.getByRole('textbox', { name: t('am.page.name') })).toHaveFocus()
		);
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

<!-- A name another profile has: the editor opens again with the API's reason, cleared by typing. -->
<Story
	name="Name already taken"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = await canvas.findByRole('textbox', { name: t('am.page.name') });
		await userEvent.type(name, 'Default{Enter}');
		await userEvent.click(await canvas.findByRole('button', { name: t('common.save') }));
		const field = await canvas.findByRole('textbox', { name: t('am.page.name') });
		await expect(await canvas.findByText(t('am.page.nameTaken'))).toBeInTheDocument();
		await waitFor(() => expect(field).toHaveFocus());
		await userEvent.type(field, ' 2');
		await expect(canvas.queryByText(t('am.page.nameTaken'))).toBeNull();
	}}
>
	{#snippet template()}
		<AuthenticationMethodProfilePage
			client={nameTaken()}
			{directoryStatusClient}
			tenantId="acme"
			id="new"
			canWrite
			listHref="/admin/authentication/methods"
			{oncreated}
		/>
	{/snippet}
</Story>
