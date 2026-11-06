<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import {
		FRESH_AUTH_REQUIRED,
		WalletCredentialError,
		type WalletCredential,
		type WalletCredentialManager,
		type WalletCredentialsClient,
		type WalletOfferStatus
	} from '#lib/api/wallet-credentials.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
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

	/** base64url thumbprint whose confirmation code is MZXW-6YTB. */
	const THUMBPRINT = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';
	const DAY = 86_400_000;

	const CREDENTIALS: WalletCredential[] = [
		{
			id: 'cred_new',
			status: 'active',
			issuedAt: Date.UTC(2026, 10, 2, 9, 30),
			expiresAt: Date.UTC(2027, 10, 2, 9, 30),
			holderKeyThumbprint: THUMBPRINT
		},
		{
			id: 'cred_old',
			status: 'revoked',
			issuedAt: Date.UTC(2026, 9, 1, 9, 30),
			expiresAt: Date.UTC(2026, 9, 1, 9, 30) + 365 * DAY
		}
	];

	/** A client that moves through `states` on each status check, ending on the last one. */
	function client(
		states: Array<WalletOfferStatus['state']>,
		options: {
			failCreate?: string;
			credentials?: WalletCredential[];
			failRevoke?: string;
			failList?: boolean;
		} = {}
	): WalletCredentialsClient & WalletCredentialManager {
		let index = 0;
		let credentials = (options.credentials ?? []).map((credential) => ({ ...credential }));
		return {
			async listCredentials() {
				if (options.failList) throw new WalletCredentialError('http_500', 500);
				return credentials.map((credential) => ({ ...credential }));
			},
			async revokeCredential(credentialId) {
				if (options.failRevoke) throw new WalletCredentialError(options.failRevoke, 403);
				credentials = credentials.map((credential) =>
					credential.id === credentialId ? { ...credential, status: 'revoked' } : credential
				);
			},
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
				if (
					state === 'issued' &&
					!credentials.some((credential) => credential.id === 'cred_story')
				) {
					credentials = [
						{
							id: 'cred_story',
							status: 'active',
							issuedAt: Date.now(),
							expiresAt: Date.now() + 365 * DAY,
							holderKeyThumbprint: THUMBPRINT
						},
						...credentials
					];
				}
				return {
					offerId,
					state,
					expiresAt: Date.now() + 5 * 60_000,
					...(state === 'issued' ? { holderKeyThumbprint: THUMBPRINT } : {})
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
		await canvas.findAllByText('MZXW-6YTB');
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

<Story
	name="Credential list"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: t('keyring.credentials.title') });
		await canvas.findByText('MZXW-6YTB');
		await canvas.findByText(t('keyring.credentials.status.active'));
		await canvas.findByText(t('keyring.credentials.status.revoked'));
		// Only the credential that is still usable can be revoked.
		expect(
			canvas.getAllByRole('button', { name: new RegExp(t('keyring.credentials.revoke')) })
		).toHaveLength(1);
	}}
>
	{#snippet template()}
		<Keyring client={client(['pending'], { credentials: CREDENTIALS })} />
	{/snippet}
</Story>

<Story
	name="Empty credential list"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('keyring.credentials.empty'));
	}}
>
	{#snippet template()}
		<Keyring client={client(['pending'])} />
	{/snippet}
</Story>

<Story
	name="Credential list failed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('keyring.credentials.loadFailed'));
		await canvas.findByRole('button', { name: t('common.retry') });
	}}
>
	{#snippet template()}
		<Keyring client={client(['pending'], { failList: true })} />
	{/snippet}
</Story>

<Story
	name="Revoke a credential"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('button', { name: new RegExp(t('keyring.credentials.revoke')) })
		);
		// The confirmation is a modal dialog, which is outside the canvas.
		const dialog = within(await within(document.body).findByRole('dialog'));
		await dialog.findByText(t('keyring.credentials.revokeTitle', { code: 'MZXW-6YTB' }));
		await userEvent.click(
			await dialog.findByRole('button', { name: t('keyring.credentials.revoke') })
		);
		// Revoked: the list shows it as such and offers no second revoke.
		await canvas.findAllByText(t('keyring.credentials.status.revoked'));
		await waitFor(() =>
			expect(toast.items.map((item) => item.message)).toContain(t('keyring.credentials.revoked'))
		);
		expect(
			canvas.queryByRole('button', { name: new RegExp(t('keyring.credentials.revoke')) })
		).toBeNull();
	}}
>
	{#snippet template()}
		<Keyring client={client(['pending'], { credentials: CREDENTIALS })} />
	{/snippet}
</Story>

<Story
	name="Revoke needs sign-in"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('button', { name: new RegExp(t('keyring.credentials.revoke')) })
		);
		const dialog = within(await within(document.body).findByRole('dialog'));
		await userEvent.click(
			await dialog.findByRole('button', { name: t('keyring.credentials.revoke') })
		);
		await canvas.findByText(t('keyring.error.freshAuth'));
		await canvas.findByRole('button', { name: t('keyring.reauth.button') });
	}}
>
	{#snippet template()}
		<Keyring
			client={client(['pending'], { credentials: CREDENTIALS, failRevoke: FRESH_AUTH_REQUIRED })}
		/>
	{/snippet}
</Story>

<Story
	name="Issued adds the credential to the list"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('keyring.start.button') }));
		await canvas.findByRole('heading', { name: t('keyring.issued.title') }, { timeout: 5000 });
		// The confirmation code of the new key is in the issuance result and in the list.
		await waitFor(() => expect(canvas.getAllByText('MZXW-6YTB').length).toBeGreaterThanOrEqual(2));
	}}
>
	{#snippet template()}
		<Keyring client={client(['issued'])} />
	{/snippet}
</Story>
