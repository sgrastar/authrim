<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import { consentBase, consentItems } from './consent-fixtures';
	import ConsentView from './ConsentView.svelte';

	const { Story } = defineMeta({
		title: 'Screens/Consent',
		component: ConsentView,
		tags: ['autodocs'],
		args: {
			consentData: consentBase,
			onOrgChange: fn(),
			onSwitchAccount: fn(),
			onAllow: fn(),
			onDeny: fn()
		},
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'What an application is asking to access. Parts appear by tenant and client settings: trusted badge, delegated access warning, organisation picker, roles, and consent items (required items block Allow until given). The route (`src/routes/consent`) owns the requests.'
				}
			}
		}
	});

	const orgs = [
		{ id: 'org1', name: 'Acme Inc.', type: 'company', is_primary: true },
		{ id: 'org2', name: 'Acme Labs', type: 'company', is_primary: false }
	];
</script>

{#snippet page(args: Parameters<typeof ConsentView>[1])}
	<LoginUIFrame fit="page">
		<AuthPageShell wide><ConsentView {...args} /></AuthPageShell>
	</LoginUIFrame>
{/snippet}

<Story name="Loading" args={{ loading: true, consentData: null }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Failed to load" args={{ consentData: null, error: 'The request is not valid.' }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Default">
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Trusted client"
	args={{ consentData: { ...consentBase, client: { ...consentBase.client, is_trusted: true } } }}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Delegated access"
	args={{
		consentData: {
			...consentBase,
			acting_as: {
				id: 'u2',
				name: 'Grace Hopper',
				email: 'grace@example.com',
				relationship_type: 'guardian',
				permission_level: 'full'
			},
			features: { ...consentBase.features, acting_as_enabled: true }
		}
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Organisation picker and roles"
	args={{
		selectedOrgId: 'org1',
		consentData: {
			...consentBase,
			organizations: orgs,
			roles: ['admin', 'billing'],
			features: { org_selector_enabled: true, acting_as_enabled: false, show_roles: true }
		}
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Consent items (blocking)"
	args={{
		consentData: { ...consentBase, consent_management_enabled: true, consent_items: consentItems },
		consentItemDecisions: { tos: 'denied', 'terms-update': 'denied', news: 'denied' }
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Consent items (all given)"
	args={{
		consentData: { ...consentBase, consent_management_enabled: true, consent_items: consentItems },
		consentItemDecisions: { tos: 'granted', 'terms-update': 'granted', news: 'denied' }
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story name="Allowing" args={{ allowLoading: true }}>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>

<Story
	name="Allow and deny"
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const buttons = canvas.getAllByRole('button');
		await userEvent.click(buttons.at(-1)!);
		await expect(args.onAllow).toHaveBeenCalledOnce();
		await userEvent.click(buttons.at(-2)!);
		await expect(args.onDeny).toHaveBeenCalledOnce();
	}}
>
	{#snippet template(args)}{@render page(args)}{/snippet}
</Story>
