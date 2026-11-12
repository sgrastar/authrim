<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '#lib/storybook/LoginUIFrame.svelte';
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
						'What the account has agreed to: OAuth clients with the scopes granted and the information they are given, and consent statements (terms, policies, marketing) with their version and choice. Read-only.'
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
		await expect(canvas.getByText('Full name, Email address')).toBeVisible();
		await expect(canvas.getByText(get(LL).account_consentSelectedAlways())).toBeVisible();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Information decided for the user"
	args={{
		consents: [
			clientConsent({
				id: 'consent-trusted',
				clientName: 'Intranet',
				clientId: 'client-intranet',
				informationRelease: { basis: 'trust', approved: [], declined: [], decidedAt: 1 }
			}),
			clientConsent({
				id: 'consent-not-asked',
				clientName: 'Status page',
				clientId: 'client-status',
				informationRelease: { basis: 'not_asked', approved: [], declined: [], decidedAt: 1 }
			}),
			clientConsent({
				id: 'consent-not-recorded',
				clientName: 'Legacy app',
				clientId: 'client-legacy',
				informationRelease: undefined
			})
		]
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const messages = get(LL);
		await expect(canvas.getByText(messages.account_consentInformationTrusted())).toBeVisible();
		await expect(canvas.getByText(messages.account_consentInformationRequiredOnly())).toBeVisible();
		await expect(canvas.getByText(messages.account_consentInformationNotRecorded())).toBeVisible();
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
