<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { SAMPLE_AUTHENTICATORS } from '#lib/api/fake/admin-user-detail-fake.js';
	import type { AdminUserPasskey, AdminUserTotp } from '#lib/api/admin-users.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import UserSignInMethods from './UserSignInMethods.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Users/Sign-in methods',
		component: UserSignInMethods,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The **Sign-in methods** card of the user page: passkeys and authenticator apps, read only. Each row starts with a decorative icon. A passkey shows its maker’s logo when the API knows the authenticator (`provider.icon_light` / `icon_dark`, image data URIs taken from the AAGUID list; the dark one is used in the dark theme), and a fingerprint icon when it does not. An authenticator app shows a phone icon. The API does not say whether a passkey is a platform authenticator or a security key, so no finer split is drawn. The logos in these stories are plain stand-in shapes, except Authrim Keyring’s own app icon.'
				}
			}
		}
	});

	const WHEN = Date.UTC(2026, 10, 1);
	const passkeys: AdminUserPasskey[] = SAMPLE_AUTHENTICATORS.map((entry, index) => ({
		id: `pk_${index}`,
		deviceName: entry.device,
		provider: entry.provider,
		providerIcon: entry.icon,
		createdAt: WHEN,
		lastUsedAt: index % 2 ? null : WHEN + 86_400_000
	}));
	const totp: AdminUserTotp[] = [
		{ id: 't1', label: 'Authenticator app', status: 'active', createdAt: WHEN, lastUsedAt: WHEN }
	];
</script>

<Story
	name="Makers, a security key and an unknown one"
	args={{ passkeys, totp }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Authrim Keyring');
		// Logos come from the API as images; the unknown authenticator falls back to an icon.
		expect(canvasElement.querySelectorAll('.authenticator-icon img').length).toBe(6);
		expect(canvasElement.querySelectorAll('.authenticator-icon svg').length).toBe(3);
		await canvas.findByRole('table', { name: t('usr.d.totp') });
	}}
/>
