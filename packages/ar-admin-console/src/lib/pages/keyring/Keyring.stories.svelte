<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import {
		FRESH_AUTH_REQUIRED,
		WalletCredentialError,
		type WalletCredentialsClient,
		type WalletOfferStatus
	} from '#lib/api/wallet-credentials.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Keyring from './Keyring.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Account/Keyring',
		component: Keyring,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Account → Authrim Keyring. Step 1 shows only the QR code; once the app has fetched the offer the QR is replaced by the 6-digit transaction code; after issuance the admin compares the key confirmation code with the one Keyring shows. The mocked client steps through the states every few seconds.'
				}
			}
		}
	});

	const OFFER_URI =
		'openid-credential-offer://?credential_offer_uri=https%3A%2F%2Fexample.test%2Foffer';

	/** A client that moves through `states` on each status check, ending on the last one. */
	function client(
		states: Array<WalletOfferStatus['state']>,
		options: { failCreate?: string } = {}
	): WalletCredentialsClient {
		let index = 0;
		return {
			async createOffer() {
				if (options.failCreate) throw new WalletCredentialError(options.failCreate, 403);
				return {
					offerId: 'off_story',
					credentialOffer: OFFER_URI,
					transactionCode: '482915',
					expiresAt: Date.now() + 5 * 60_000
				};
			},
			async getOfferStatus(offerId) {
				const state = states[Math.min(index++, states.length - 1)];
				return {
					offerId,
					state,
					expiresAt: Date.now() + 5 * 60_000,
					...(state === 'issued'
						? { holderKeyThumbprint: 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo' }
						: {})
				};
			}
		};
	}
</script>

<Story
	name="Ready"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: t('keyring.start.button') });
	}}
>
	{#snippet template()}
		<Keyring client={client(['pending'])} />
	{/snippet}
</Story>

<Story
	name="QR code"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('keyring.start.button') }));
		await canvas.findByRole('img', { name: t('keyring.qr.alt') });
		expect(canvas.queryByText('482 915')).toBeNull();
	}}
>
	{#snippet template()}
		<Keyring client={client(['pending'])} />
	{/snippet}
</Story>

<Story
	name="Transaction code"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('keyring.start.button') }));
		await canvas.findByText('482 915', {}, { timeout: 5000 });
		expect(canvas.queryByRole('img', { name: t('keyring.qr.alt') })).toBeNull();
	}}
>
	{#snippet template()}
		<Keyring client={client(['fetched'])} />
	{/snippet}
</Story>

<Story
	name="Issued"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('keyring.start.button') }));
		// The title is also announced by the live region, so look for the heading itself.
		await canvas.findByRole('heading', { name: t('keyring.issued.title') }, { timeout: 5000 });
		await canvas.findByText('MZXW-6YTB');
	}}
>
	{#snippet template()}
		<Keyring client={client(['issued'])} />
	{/snippet}
</Story>

<Story
	name="Locked"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('keyring.start.button') }));
		await canvas.findByRole('heading', { name: t('keyring.ended.locked') }, { timeout: 5000 });
		await canvas.findByRole('button', { name: t('keyring.again') });
	}}
>
	{#snippet template()}
		<Keyring client={client(['locked'])} />
	{/snippet}
</Story>

<Story
	name="Sign in again required"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('keyring.start.button') }));
		await canvas.findByRole('button', { name: t('keyring.reauth.button') });
	}}
>
	{#snippet template()}
		<Keyring client={client(['pending'], { failCreate: FRESH_AUTH_REQUIRED })} />
	{/snippet}
</Story>
