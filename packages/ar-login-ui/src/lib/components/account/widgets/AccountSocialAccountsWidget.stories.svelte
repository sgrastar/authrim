<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountSocialAccountsWidget from './AccountSocialAccountsWidget.svelte';
	import { linkedIdentity, socialProviders } from './social-fixtures';

	const { Story } = defineMeta({
		title: 'Account/Social accounts',
		component: AccountSocialAccountsWidget,
		tags: ['autodocs'],
		args: {
			identities: [linkedIdentity()],
			providers: socialProviders(),
			actionLoading: '',
			notice: null,
			headingLevel: 2,
			loading: false,
			refreshing: false,
			error: '',
			reauthNeeded: false,
			onRefresh: fn(),
			onReauthenticate: fn(),
			onLink: fn(),
			onUnlink: fn()
		},
		parameters: {
			docs: {
				description: {
					component:
						'External accounts linked to this one, with unlinking behind an inline confirmation, and a button per provider that can still be linked. Linking leaves for the provider and comes back with a notice; both linking and unlinking ask for a recent re-authentication first.'
				}
			}
		}
	});
</script>

<Story
	name="Linked accounts"
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const ll = get(LL);
		await expect(
			canvas.getByRole('heading', { level: 2, name: ll.account_socialAccounts() })
		).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: ll.account_socialUnlink() }));
		await userEvent.click(
			canvas.getByRole('button', {
				name: ll.account_socialUnlinkConfirmAction({ provider: 'Google' })
			})
		);
		await expect(args.onUnlink).toHaveBeenCalledWith('linked-google');
		await userEvent.click(
			canvas.getByRole('button', { name: ll.account_socialLinkWith({ provider: 'GitHub' }) })
		);
		await expect(args.onLink).toHaveBeenCalledWith('github');
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><AccountSocialAccountsWidget {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Nothing linked"
	args={{ identities: [] }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText(get(LL).account_socialEmpty())).toBeInTheDocument();
		await expect(
			canvas.getByRole('button', { name: get(LL).account_socialLinkWith({ provider: 'Google' }) })
		).toBeInTheDocument();
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><AccountSocialAccountsWidget {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Every provider linked"
	args={{
		identities: [
			linkedIdentity(),
			linkedIdentity({
				id: 'linked-github',
				providerId: 'prov_github',
				providerSlug: 'github',
				providerName: 'GitHub',
				providerEmail: undefined,
				lastLoginAt: undefined
			})
		]
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><AccountSocialAccountsWidget {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Confirming unlink"
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const ll = get(LL);
		await userEvent.click(canvas.getByRole('button', { name: ll.account_socialUnlink() }));
		await expect(
			canvas.getByText(ll.account_socialUnlinkConfirm({ provider: 'Google' }))
		).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: ll.dialog_cancel() }));
		await expect(args.onUnlink).not.toHaveBeenCalled();
		await expect(
			canvas.getByRole('button', { name: ll.account_socialUnlink() })
		).toBeInTheDocument();
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><AccountSocialAccountsWidget {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Leaving for the provider" args={{ actionLoading: 'social:link:github' }}>
	{#snippet template(args)}
		<LoginUIFrame><AccountSocialAccountsWidget {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Linked (returned)"
	args={{ notice: { kind: 'success', message: 'The account was linked.' } }}
>
	{#snippet template(args)}
		<LoginUIFrame><AccountSocialAccountsWidget {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Link failed (already linked elsewhere)"
	args={{
		identities: [],
		notice: { kind: 'error', message: 'That account is already linked to another user.' }
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><AccountSocialAccountsWidget {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Last login method"
	args={{
		error: 'This is your last way to log in. Add a passkey or another login method first.'
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><AccountSocialAccountsWidget {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story
	name="Reauthentication needed"
	args={{ error: 'Recent authentication is required for this operation', reauthNeeded: true }}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_reauth() }));
		await expect(args.onReauthenticate).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}
		<LoginUIFrame><AccountSocialAccountsWidget {...args} /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Loading" args={{ loading: true }}>
	{#snippet template(args)}
		<LoginUIFrame><AccountSocialAccountsWidget {...args} /></LoginUIFrame>
	{/snippet}
</Story>
