<script lang="ts">
	/**
	 * A login or signup page: the shared shell around a card holding a runtime screen, with the
	 * switch link and optional "signing in to" card that the routes add.
	 */
	import AuthPageShell from '$lib/components/AuthPageShell.svelte';
	import AuthSwitchLink from '$lib/components/AuthSwitchLink.svelte';
	import Card from '$lib/components/Card.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';
	import { blocks, screenOf } from './fixtures';
	import RuntimeScreenHarness from './RuntimeScreenHarness.svelte';

	type Props = {
		kind?: 'login' | 'signup';
		/** The "Signing in to <client>" card the login page shows for OIDC sign-ins. */
		client?: boolean;
	};

	let { kind = 'login', client = false }: Props = $props();

	const { loginUIPageStore } = useLoginUIStores();

	// A short screen so a whole page fits a gallery cell; the full screens are on Runtime screen.
	const screen = $derived(
		kind === 'signup'
			? screenOf(
					[
						blocks.heading('Create your account'),
						blocks.passkey('Create Account with Passkey'),
						blocks.divider('or'),
						blocks.mailOtp(),
						blocks.divider('Continue with another account'),
						blocks.externalIdp(false)
					],
					{ canvas_layout: 'narrow' },
					'registration'
				)
			: screenOf(
					[
						blocks.heading('Sign in'),
						blocks.passkey(),
						blocks.divider('or'),
						blocks.mailOtp(),
						blocks.divider('Continue with another account'),
						blocks.externalIdp(false)
					],
					{ canvas_layout: 'narrow' },
					'login'
				)
	);
</script>

<AuthPageShell wide={screen.settings?.canvas_layout === 'wide'}>
	{#if client}
		<div class="auth-client-card">
			<div class="auth-client-card__row">
				<div class="flex-1 min-w-0">
					<p class="auth-client-card__label">{$LL.login_signingInTo()}</p>
					<p class="auth-client-card__name">
						<a href="https://example.com" class="truncate block">Acme Dashboard</a>
					</p>
					<div class="auth-client-card__links">
						<a href="https://example.com/privacy" class="auth-client-card__link"
							>{$LL.consent_privacyPolicy()}</a
						>
						<a href="https://example.com/terms" class="auth-client-card__link"
							>{$LL.consent_termsOfService()}</a
						>
					</div>
				</div>
			</div>
		</div>
	{/if}
	<Card class="mb-6">
		<div class="runtime-screen-step mb-4">
			<RuntimeScreenHarness {screen} mode={kind} framed={false} guest={false} providerCount={2} />
		</div>
	</Card>
	{#if loginUIPageStore.authSwitchLinkEnabled}
		<p class="auth-bottom-link">
			<AuthSwitchLink
				href={kind === 'login' ? '/signup' : '/login'}
				label={kind === 'login' ? $LL.login_createAccount() : $LL.register_alreadyHaveAccount()}
				loadingLabel={$LL.common_loading()}
			/>
		</p>
	{/if}
</AuthPageShell>
