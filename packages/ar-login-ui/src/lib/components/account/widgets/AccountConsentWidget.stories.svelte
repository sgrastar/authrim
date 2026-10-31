<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountConsentWidget from './AccountConsentWidget.svelte';
	import { clientConsent, statementConsent } from './fixtures';

	const { Story } = defineMeta({
		title: 'Account/Consents',
		component: AccountConsentWidget,
		tags: ['autodocs'],
		args: {
			consents: [clientConsent(), statementConsent()],
			loading: false,
			error: '',
			headingLevel: 2
		},
		parameters: {
			docs: {
				description: {
					component:
						'What the account has agreed to: OAuth clients with the scopes granted, and consent statements (terms, policies, marketing) with their version and choice. Read-only.'
				}
			}
		}
	});
</script>

{#snippet widget(args: Parameters<typeof AccountConsentWidget>[1])}
	<LoginUIFrame><AccountConsentWidget {...args} /></LoginUIFrame>
{/snippet}

<Story
	name="Default"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByRole('heading', { level: 2, name: get(LL).account_consentTitle() })
		).toBeInTheDocument();
		await expect(canvas.getByText('Docs')).toBeVisible();
		await expect(canvas.getByText('openid, profile, email')).toBeVisible();
		await expect(canvas.getByText(get(LL).account_consentSelectedAlways())).toBeVisible();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Withdrawn statement"
	args={{
		consents: [statementConsent({ status: 'withdrawn', selectedValue: 'none' })]
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Empty" args={{ consents: [] }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story name="Loading" args={{ consents: [], loading: true }}>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Error"
	args={{ consents: [], error: 'Could not load account data' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('alert')).toHaveTextContent('Could not load account data');
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>
