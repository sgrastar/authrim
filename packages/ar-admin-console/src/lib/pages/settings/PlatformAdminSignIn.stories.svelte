<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { persona } from '#lib/access/personas.js';
	import { createFakeSettings } from '#lib/api/fake/settings-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import PlatformAdminSignIn from './PlatformAdminSignIn.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Platform/Administrators/Sign-in',
		component: PlatformAdminSignIn,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						"Platform → Administrators → Sign-in: which ways the console's sign-in page offers (`security.admin_sign_in_methods`: the passkey always, VC / wallet opt-in and off by default while it is being built out), and which kinds of second factor satisfy L2 for every tenant that sets no list of its own (`security.admin_second_factor_allowed_kinds` at the platform scope). Security keys and Keyring are always allowed; an authenticator app (TOTP) can be added. A tenant's own list, on its Administrators page, replaces this one. Saving asks for step-up first. The page is `PLATFORM_ADMIN_SIGN_IN` (`settings/platform-admin-sign-in.ts`), kept out of `SETTINGS_PAGES` because the settings have their home on the tenant page."
				}
			}
		}
	});

	const platform = persona('platform').access;
</script>

<Story
	name="Turn wallet sign-in on"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('set.section.adminSignInMethods'));
		// Not set at the platform yet: the default applies (passkey only, the wallet off).
		const overrides = await canvas.findAllByRole('checkbox', {
			name: new RegExp(`^${t('settings.setHereOption')}`)
		});
		await userEvent.click(overrides[0]);
		// A function, not a RegExp: the name holds parentheses ("VC (wallet)").
		const vc = await canvas.findByRole('checkbox', {
			name: (name) => name.includes(t('set.method.vc'))
		});
		await expect(vc).not.toBeChecked();
		await userEvent.click(vc);
		await expect(vc).toBeChecked();
		// The passkey can never be turned off.
		await expect(
			canvas.getByRole('checkbox', { name: (name) => name.includes(t('set.method.passkey')) })
		).toBeDisabled();
	}}
>
	{#snippet template()}
		<PlatformAdminSignIn
			client={createFakeSettings({ access: () => platform, latency: 100 })}
			access={platform}
		/>
	{/snippet}
</Story>

<Story
	name="Allow authenticator apps"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('set.section.adminSecondFactorPlatform'));
		// Not set at the platform yet: the default applies (security keys only, TOTP off).
		const overrides = await canvas.findAllByRole('checkbox', {
			name: new RegExp(`^${t('settings.setHereOption')}`)
		});
		await userEvent.click(overrides[1]);
		const totp = await canvas.findByRole('checkbox', { name: new RegExp(t('set.kind.totp')) });
		await expect(totp).not.toBeChecked();
		await userEvent.click(totp);
		await expect(totp).toBeChecked();
		await expect(
			canvas.getByRole('checkbox', { name: new RegExp(t('set.kind.hardware')) })
		).toBeDisabled();
	}}
>
	{#snippet template()}
		<PlatformAdminSignIn
			client={createFakeSettings({ access: () => platform, latency: 100 })}
			access={platform}
		/>
	{/snippet}
</Story>
