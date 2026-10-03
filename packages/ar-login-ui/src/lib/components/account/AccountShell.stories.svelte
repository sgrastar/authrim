<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { get } from 'svelte/store';
	import { expect, fn, waitFor, within } from 'storybook/test';
	import { LL } from '$i18n/i18n-svelte';
	import type { AccountPageScreenField } from '$lib/api/account';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import AccountReauthDialog from './AccountReauthDialog.svelte';
	import AccountScreenBlock, { isAccountScreenStaticBlock } from './AccountScreenBlock.svelte';
	import AccountScreenPlacement from './AccountScreenPlacement.svelte';
	import AccountShell from './AccountShell.svelte';
	import { accountPagePlacements } from './account-page-fixtures';
	import AccountActivityWidget from './widgets/AccountActivityWidget.svelte';
	import AccountConsentWidget from './widgets/AccountConsentWidget.svelte';
	import AccountDevicesWidget from './widgets/AccountDevicesWidget.svelte';
	import AccountLauncherWidget from './widgets/AccountLauncherWidget.svelte';
	import AccountPasskeysWidget from './widgets/AccountPasskeysWidget.svelte';
	import AccountProfileWidget from './widgets/AccountProfileWidget.svelte';
	import AccountSessionsWidget from './widgets/AccountSessionsWidget.svelte';
	import AccountSocialAccountsWidget from './widgets/AccountSocialAccountsWidget.svelte';
	import AccountTotpWidget from './widgets/AccountTotpWidget.svelte';
	import AccountUpgradeWidget from './widgets/AccountUpgradeWidget.svelte';
	import AccountWidgetPanel from './widgets/AccountWidgetPanel.svelte';
	import {
		clientConsent,
		device,
		guestUpgradeStatus,
		launchers,
		operation,
		passkey,
		profile,
		session,
		statementConsent,
		totpCredential
	} from './widgets/fixtures';
	import { linkedIdentity, socialProviders } from './widgets/social-fixtures';

	const { Story } = defineMeta({
		title: 'Screens/Account',
		component: AccountShell,
		tags: ['autodocs'],
		args: {
			brandName: 'Acme ID',
			title: 'Account',
			description: '',
			logoutLoading: false,
			pageError: '',
			busy: false,
			onLogout: fn()
		},
		parameters: {
			layout: 'fullscreen',
			docs: {
				// Fixed preference controls and the dialog belong to the viewport: one frame per story.
				story: { inline: false, iframeHeight: 900 },
				description: {
					component:
						'The account page at `/account`: the shell (brand, title, sign-out, preference controls, footer) around the account grid. With a published account page composition each placement is a half- or full-width cell of the grid; without one the page falls back to the profile, one Security panel, consents and activity. `AccountPage` owns the requests and state; these stories feed the same widgets fixtures.'
				}
			}
		}
	});

	/** Widget callbacks: the stories show states, the widgets' own stories test the actions. */
	const action = fn();

	type Account = 'registered' | 'guest';
</script>

<!-- One placement block, as AccountPage draws it for the published composition. -->
{#snippet placementBlock(field: AccountPageScreenField, account: Account)}
	{@const guest = account === 'guest'}
	{#if isAccountScreenStaticBlock(field.block_type)}
		<AccountScreenBlock {field} href={field.href ?? null} />
	{:else if field.block_type === 'account_upgrade_widget'}
		<AccountUpgradeWidget
			status={guest ? guestUpgradeStatus() : null}
			onStartEmail={action}
			onStartPasskey={action}
			onConfirmCode={action}
			onChangeMethod={action}
			onRetry={action}
		/>
	{:else if field.block_type === 'account_launcher_widget'}
		<AccountLauncherWidget launchers={launchers()} onRetry={action} onToggleFavorite={action} />
	{:else if field.block_type === 'account_profile_widget'}
		<AccountProfileWidget
			profile={guest
				? profile({
						registration_state: 'guest',
						email: null,
						email_verified: false,
						name: null,
						given_name: null,
						family_name: null
					})
				: profile()}
			onSave={action}
			onStartEmailChange={action}
			onCompleteEmailChange={action}
			onCancelEmailChange={action}
		/>
	{:else if field.block_type === 'account_device_list_widget'}
		<AccountDevicesWidget
			devices={guest
				? []
				: [
						device({ current: true }),
						device({ id: 'device-2', display_name: 'Living room TV', platform: 'tvOS' })
					]}
			onRefresh={action}
		/>
	{:else if field.block_type === 'account_session_widget'}
		<AccountSessionsWidget
			sessions={guest
				? [session({ id: 'session-current', current: true })]
				: [session({ id: 'session-current', current: true }), session()]}
			onRefresh={action}
			onRevokeSession={action}
		/>
	{:else if field.block_type === 'account_passkey_widget'}
		<AccountPasskeysWidget
			passkeys={guest ? [] : [passkey()]}
			passkeySupported
			onRefresh={action}
			onAddPasskey={action}
			onDeletePasskey={action}
		/>
	{:else if field.block_type === 'account_totp_widget'}
		<AccountTotpWidget
			credentials={guest ? [] : [totpCredential()]}
			backupCodes={guest ? { total: 0, remaining: 0 } : { total: 10, remaining: 8 }}
			managementEnabled
			onRefresh={action}
			onStartEnrollment={action}
			onActivateEnrollment={action}
			onDeleteCredential={action}
			onRegenerateBackupCodes={action}
			onClearEnrollment={action}
		/>
	{:else if field.block_type === 'account_consent_widget'}
		<AccountConsentWidget consents={guest ? [] : [clientConsent(), statementConsent()]} />
	{:else if field.block_type === 'account_activity_widget'}
		<AccountActivityWidget
			operations={guest
				? [operation({ action: 'account.guest.created', resource_type: 'user' })]
				: [operation(), operation({ id: 'operation-2', action: 'account.totp.reauthenticated' })]}
		/>
	{:else if field.block_type === 'account_social_account_widget'}
		<AccountSocialAccountsWidget
			identities={[linkedIdentity()]}
			providers={socialProviders()}
			onRefresh={action}
		/>
	{/if}
{/snippet}

<!-- The published composition, laid out by AccountScreenPlacement as on the real page. -->
{#snippet composition(account: Account)}
	{#each accountPagePlacements() as placement (placement.id)}
		<AccountScreenPlacement
			id={placement.id}
			full={placement.width === 'full'}
			overview={placement.screen_key === 'account_overview'}
			fields={placement.fields}
		>
			{#snippet block(field)}{@render placementBlock(field, account)}{/snippet}
		</AccountScreenPlacement>
	{/each}
{/snippet}

{#snippet page(
	{ children: _, dialog: __, ...args }: Parameters<typeof AccountShell>[1],
	content: 'registered' | 'guest' | 'fallback',
	reauthenticating = false
)}
	<LoginUIFrame fit="page">
		<AccountShell {...args}>
			{#if content === 'fallback'}
				<AccountProfileWidget
					profile={profile()}
					onSave={action}
					onStartEmailChange={action}
					onCompleteEmailChange={action}
					onCancelEmailChange={action}
				/>
				<AccountWidgetPanel title={get(LL).account_securityTitle()} onRefresh={action}>
					<AccountDevicesWidget headingLevel={3} devices={[device({ current: true })]} />
					<AccountSessionsWidget
						headingLevel={3}
						sessions={[session({ id: 'session-current', current: true }), session()]}
						onRevokeSession={action}
					/>
					<AccountPasskeysWidget
						headingLevel={3}
						passkeys={[passkey()]}
						passkeySupported
						onAddPasskey={action}
						onDeletePasskey={action}
					/>
					<AccountTotpWidget
						headingLevel={3}
						credentials={[totpCredential()]}
						backupCodes={{ total: 10, remaining: 8 }}
						managementEnabled
						onStartEnrollment={action}
						onActivateEnrollment={action}
						onDeleteCredential={action}
						onRegenerateBackupCodes={action}
						onClearEnrollment={action}
					/>
					<AccountSocialAccountsWidget
						headingLevel={3}
						identities={[linkedIdentity()]}
						providers={socialProviders()}
					/>
				</AccountWidgetPanel>
				<AccountConsentWidget consents={[clientConsent(), statementConsent()]} />
				<AccountActivityWidget operations={[operation()]} />
			{:else}
				{@render composition(content)}
			{/if}

			{#snippet dialog()}
				<AccountReauthDialog
					open={reauthenticating}
					passkeyAvailable
					emailCodeAvailable
					totpAvailable
					onPasskey={action}
					onSendEmailCode={action}
					onVerifyEmailCode={action}
					onVerifyTotp={action}
					onClose={action}
				/>
			{/snippet}
		</AccountShell>
	</LoginUIFrame>
{/snippet}

<Story
	name="Configured composition"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument();
		// Full-width placements span the grid; half-width ones share a row.
		const overview = canvasElement.querySelector<HTMLElement>('#overview');
		const profileCell = canvasElement.querySelector<HTMLElement>('#profile');
		const devicesCell = canvasElement.querySelector<HTMLElement>('#devices');
		await expect(overview?.classList.contains('overview')).toBe(true);
		if (window.innerWidth > 760) {
			await expect(profileCell?.getBoundingClientRect().top).toBe(
				devicesCell?.getBoundingClientRect().top
			);
			await expect(overview?.getBoundingClientRect().width).toBeGreaterThan(
				(profileCell?.getBoundingClientRect().width ?? 0) * 1.5
			);
		}
	}}
>
	{#snippet template(args)}{@render page(args, 'registered')}{/snippet}
</Story>

<Story
	name="Guest"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByRole('heading', { level: 2, name: get(LL).account_guestTitle() })
		).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render page(args, 'guest')}{/snippet}
</Story>

<Story
	name="No published composition (fallback)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByRole('heading', { level: 2, name: get(LL).account_securityTitle() })
		).toBeInTheDocument();
		await expect(canvas.getAllByRole('heading', { level: 3 })).toHaveLength(5);
	}}
>
	{#snippet template(args)}{@render page(args, 'fallback')}{/snippet}
</Story>

<Story
	name="Reauthentication dialog open"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const dialog = await canvas.findByRole('dialog', { name: get(LL).account_reauthTitle() });
		await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
		// Above the fixed preference controls.
		const backdrop = canvasElement.querySelector<HTMLElement>('.reauth-backdrop');
		const preferences = canvasElement.querySelector<HTMLElement>('.account-preferences');
		if (backdrop && preferences && getComputedStyle(preferences).position === 'fixed') {
			await expect(Number(getComputedStyle(backdrop).zIndex)).toBeGreaterThan(
				Number(getComputedStyle(preferences).zIndex)
			);
		}
	}}
>
	{#snippet template(args)}{@render page(args, 'registered', true)}{/snippet}
</Story>
