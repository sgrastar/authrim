<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, fn, userEvent, within } from 'storybook/test';
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
			headingLevel: 2,
			onWithdraw: fn()
		},
		parameters: {
			docs: {
				description: {
					component:
						'What the account has agreed to: OAuth clients with the scopes granted and the information they are given, and consent statements (terms, policies, marketing) with their version and choice. Each service and SAML service provider has a withdraw button, and so does a statement that allows withdrawal; the button asks first (what happens next time) and the page refreshes the list afterwards. Without `onWithdraw` the list is read-only.'
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
	name="Withdraw asks first"
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const messages = get(LL);
		// Each row's button names what it withdraws.
		await userEvent.click(
			canvas.getByRole('button', { name: messages.account_consentWithdrawFor({ name: 'Docs' }) })
		);
		await expect(
			canvas.getByText(messages.account_consentWithdrawConfirmService({ name: 'Docs' }))
		).toBeVisible();
		await expect(args.onWithdraw).not.toHaveBeenCalled();
		await userEvent.click(canvas.getByRole('button', { name: messages.dialog_cancel() }));
		await expect(args.onWithdraw).not.toHaveBeenCalled();
		await userEvent.click(
			canvas.getByRole('button', { name: messages.account_consentWithdrawFor({ name: 'Docs' }) })
		);
		await userEvent.click(
			canvas.getByRole('button', { name: messages.account_consentWithdrawFor({ name: 'Docs' }) })
		);
		await expect(args.onWithdraw).toHaveBeenCalledTimes(1);
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Withdrawn"
	args={{
		consents: [clientConsent()],
		notice: { kind: 'success', message: 'The consent was withdrawn.' }
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('status')).toHaveTextContent('The consent was withdrawn.');
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Withdrawing"
	args={{ actionLoading: 'consent:consent-client-1' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// The other rows' buttons are disabled while one request runs.
		const messages = get(LL);
		await expect(
			canvas.getByRole('button', {
				name: messages.account_consentWithdrawFor({ name: 'Product news by email' })
			})
		).toBeDisabled();
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Withdraw failed"
	args={{
		consents: [clientConsent()],
		notice: { kind: 'error', message: 'The consent could not be withdrawn. Try again.' }
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('alert')).toHaveTextContent(
			'The consent could not be withdrawn.'
		);
	}}
>
	{#snippet template(args)}{@render widget(args)}{/snippet}
</Story>

<Story
	name="Statement that cannot be withdrawn"
	args={{
		consents: [
			statementConsent({ id: 'consent-terms', title: 'Terms of service', withdrawable: false }),
			statementConsent({ id: 'consent-legacy', title: 'Older record', withdrawable: undefined })
		]
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.queryByRole('button')).toBeNull();
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
	name="SAML service providers"
	args={{
		consents: [
			{
				kind: 'saml_sp',
				id: 'https://sp.example.edu/shibboleth',
				spEntityId: 'https://sp.example.edu/shibboleth',
				spName: 'Library portal',
				decidedAt: 1_754_000_000_000,
				informationRelease: {
					basis: 'user',
					approved: [
						'["nameid","urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"]',
						'["attribute","mail","urn:oasis:names:tc:SAML:2.0:attrname-format:basic"]'
					],
					declined: [
						'["attribute","eduPersonAffiliation","urn:oasis:names:tc:SAML:2.0:attrname-format:basic"]'
					],
					decidedAt: 1_754_000_000_000
				}
			},
			{
				kind: 'saml_sp',
				id: 'https://lms.example.edu/sp',
				spEntityId: 'https://lms.example.edu/sp',
				decidedAt: 1_754_000_000_000,
				informationRelease: {
					basis: 'user',
					approved: [],
					declined: [],
					decidedAt: 1_754_000_000_000,
					refused: true
				}
			}
		]
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
