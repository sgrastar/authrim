<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import AuthSwitchLink from '$lib/components/AuthSwitchLink.svelte';
	import ConfiguredFooter from '$lib/components/ConfiguredFooter.svelte';
	import Catalog from '$lib/storybook/Catalog.svelte';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import { blocks, screenOf } from '$lib/storybook/fixtures';
	import RuntimeScreenHarness from '$lib/storybook/RuntimeScreenHarness.svelte';
	import Specimen from '$lib/storybook/Specimen.svelte';

	const { Story } = defineMeta({
		title: 'Catalog/Links',
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Every link on the login pages. Links that point at an address the tenant or client typed in (footer links, client homepage, policy and terms) are only rendered when the address passes `isValidLinkUrl`, and open in a new tab with `rel="noopener noreferrer"`.'
				}
			}
		}
	});
</script>

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
</script>

<Story name="Page links">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Switch between login and signup"
				source="p.auth-bottom-link > AuthSwitchLink"
				where="login (Create account) and signup (Already have an account). Hidden when the tenant turns “switch link” off. Shows a spinner after the click."
			>
				<p class="auth-bottom-link">
					<AuthSwitchLink
						href="/signup"
						label={$LL.login_createAccount()}
						loadingLabel={$LL.common_loading()}
					/>
				</p>
				<p class="auth-bottom-link">
					<AuthSwitchLink
						href="/login"
						label={$LL.register_alreadyHaveAccount()}
						loadingLabel={$LL.common_loading()}
					/>
				</p>
			</Specimen>
			<Specimen
				name="Back link"
				source="p.auth-bottom-link > a.inline-flex + arrow icon"
				where="verify-email-code (Back to login, always shown) and device (Back to home)."
			>
				<p class="auth-bottom-link">
					<a href="/login" class="inline-flex items-center gap-2" data-sveltekit-reload>
						<i class="i-ph-arrow-left h-4 w-4"></i>{$LL.common_backToLogin()}
					</a>
				</p>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Footer links">
	{#snippet template()}
		<LoginUIFrame
			ui={{
				appearance: {
					footerLinks: [
						{ label: 'Privacy', url: 'https://example.com/privacy' },
						{ label: 'Terms', url: 'https://example.com/terms' },
						{ label: 'Help', url: 'https://example.com/help' }
					]
				}
			}}
		>
			<ConfiguredFooter />
		</LoginUIFrame>
	{/snippet}
</Story>

<Story name="Footer: only the powered-by text">
	{#snippet template()}
		<LoginUIFrame>
			<ConfiguredFooter />
		</LoginUIFrame>
	{/snippet}
</Story>

<Story name="Links inside a card">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Client card links"
				source="a.auth-client-card__name a, a.auth-client-card__link"
				where="login, when the sign-in comes from a client that has a homepage, privacy policy or terms URL."
			>
				<div class="auth-client-card" style="max-width:400px">
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
			</Specimen>
			<Specimen
				name="Consent document link"
				source="a.runtime-consent-link"
				where="Consent widget, under an item that links to its full document."
				card
			>
				<RuntimeScreenHarness
					screen={screenOf([blocks.consent()])}
					framed={false}
					withConsent
					mode="signup"
				/>
			</Specimen>
			<Specimen
				name="Client website, policy and terms"
				source="a.inline-flex + i-ph-arrow-square-out"
				where="consent: client website under the title; policy and terms at the bottom (muted)."
			>
				<div style="display:flex;flex-direction:column;gap:8px;font-size:0.75rem">
					<a
						href="https://example.com"
						class="inline-flex items-center gap-1"
						style="color:var(--primary)"
						>example.com<span class="i-ph-arrow-square-out h-3 w-3"></span></a
					>
					<a
						href="https://example.com/privacy"
						class="inline-flex items-center gap-1"
						style="color:var(--text-muted)"
						>{$LL.consent_privacyPolicy()}<span class="i-ph-arrow-square-out h-3 w-3"></span></a
					>
				</div>
			</Specimen>
			<Specimen
				name="Delete my account"
				source="a.text-xs (danger colour)"
				where="consent, when a consent item offers deletion and its URL is valid."
			>
				<a href="https://example.com/delete" class="text-xs" style="color:var(--danger)"
					>{$LL.consent_delete_account_link()}</a
				>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>
