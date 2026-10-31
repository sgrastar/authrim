<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountDevicesWidget from './AccountDevicesWidget.svelte';
	import AccountPasskeysWidget from './AccountPasskeysWidget.svelte';
	import AccountSessionsWidget from './AccountSessionsWidget.svelte';
	import AccountSocialAccountsWidget from './AccountSocialAccountsWidget.svelte';
	import AccountTotpWidget from './AccountTotpWidget.svelte';
	import AccountWidgetPanel from './AccountWidgetPanel.svelte';
	import { device, passkey, session, totpCredential } from './fixtures';

	const { Story } = defineMeta({
		title: 'Account/Security panel',
		component: AccountWidgetPanel,
		tags: ['autodocs'],
		args: {
			title: '',
			headingLevel: 2,
			busy: false,
			refreshing: false,
			error: '',
			reauthNeeded: false,
			onRefresh: fn(),
			onReauthenticate: fn()
		},
		parameters: {
			docs: {
				description: {
					component:
						'The frame every account widget shares (heading, refresh, error with re-authentication). Without a published account page composition the page shows one Security panel with the five widgets inside at heading level 3, refreshed together.'
				}
			}
		}
	});
</script>

{#snippet security({ children: _, ...args }: Parameters<typeof AccountWidgetPanel>[1])}
	<LoginUIFrame>
		<AccountWidgetPanel {...args} title={args.title || get(LL).account_securityTitle()}>
			<AccountDevicesWidget headingLevel={3} devices={[device({ current: true })]} />
			<AccountSessionsWidget
				headingLevel={3}
				sessions={[session({ id: 'session-current', current: true }), session()]}
				onRevokeSession={fn()}
			/>
			<AccountPasskeysWidget
				headingLevel={3}
				passkeys={[passkey()]}
				passkeySupported
				onAddPasskey={fn()}
				onDeletePasskey={fn()}
			/>
			<AccountTotpWidget
				headingLevel={3}
				credentials={[totpCredential()]}
				backupCodes={{ total: 10, remaining: 8 }}
				managementEnabled
				onStartEnrollment={fn()}
				onActivateEnrollment={fn()}
				onDeleteCredential={fn()}
				onRegenerateBackupCodes={fn()}
				onClearEnrollment={fn()}
			/>
			<AccountSocialAccountsWidget headingLevel={3} />
		</AccountWidgetPanel>
	</LoginUIFrame>
{/snippet}

<Story
	name="Security (no published composition)"
	play={async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getAllByRole('heading', { level: 3 })).toHaveLength(5);
		await expect(canvas.getAllByRole('button', { name: get(LL).account_refresh() })).toHaveLength(
			1
		);
		await userEvent.click(canvas.getByRole('button', { name: get(LL).account_refresh() }));
		await expect(args.onRefresh).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render security(args)}{/snippet}
</Story>

<Story name="Loading" args={{ busy: true }}>
	{#snippet template(args)}{@render security(args)}{/snippet}
</Story>

<Story
	name="Reauthentication needed"
	args={{
		error: 'Recent authentication is required. Re-authenticate and retry.',
		reauthNeeded: true
	}}
>
	{#snippet template(args)}{@render security(args)}{/snippet}
</Story>
