<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Button from '$lib/components/Button.svelte';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import Catalog from '$lib/storybook/Catalog.svelte';
	import { blocks, screenOf } from '$lib/storybook/fixtures';
	import RuntimeScreenHarness from '$lib/storybook/RuntimeScreenHarness.svelte';
	import Specimen from '$lib/storybook/Specimen.svelte';

	const { Story } = defineMeta({
		title: 'Catalog/Buttons',
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Every kind of button on the login pages, with the class or component it is built from and where it shows. There are **two families**: `Button` (legacy method layout, and every page except login and signup) and `runtime-auth-button` (inside server-driven screens, which is what login and signup show today). They look alike on purpose; a change to one usually needs the same change in the other.'
				}
			}
		}
	});

	const one = (...fields: Parameters<typeof screenOf>[0]) => screenOf(fields);
	const widgetKinds = [
		['Passkey', 'primary', blocks.passkey()],
		['Email code', 'secondary', blocks.mailOtp()],
		['Authenticator app', 'secondary', blocks.totp()],
		['Directory password', 'secondary', blocks.directoryPassword()],
		['Guest', 'primary, no icon', blocks.guest()]
	] as const;
</script>

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
</script>

<Story name="Page buttons (Button)">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Primary"
				source="<Button variant='primary'>"
				where="One main action per card: Continue, Allow, Verify, Passkey in the legacy layout. consent, device, reauth, error, logout, verify-email-code, login/signup fallback."
				card
			>
				<Button class="w-full">{$LL.common_continue()}</Button>
				<Button class="w-full"
					><i class="i-heroicons-key"></i>{$LL.login_signInWithPasskey()}</Button
				>
			</Specimen>
			<Specimen
				name="Secondary"
				source="<Button variant='secondary'>"
				where="Alternative method or the safe choice: Send code, Deny, Resend, Cancel."
				card
			>
				<Button variant="secondary" class="w-full"
					><i class="i-heroicons-envelope"></i>{$LL.login_sendCode()}</Button
				>
				<Button variant="secondary" class="w-full">{$LL.consent_denyButton()}</Button>
			</Specimen>
			<Specimen
				name="Ghost"
				source="<Button variant='ghost'>"
				where="Low emphasis: Back to login (TOTP step), Contact support (error page), sign up / log in in the landing header."
				card
			>
				<Button variant="ghost" size="sm">{$LL.common_backToLogin()}</Button>
				<Button variant="ghost" class="w-full"
					><i class="i-heroicons-question-mark-circle"></i>{$LL.common_contactSupport()}</Button
				>
			</Specimen>
			<Specimen
				name="Deny and allow pair"
				source=".auth-actions > <Button flex-1> ×2"
				where="consent, device (approve), ciba (approve / reject)."
			>
				<div class="auth-actions" style="width:100%;max-width:400px">
					<Button variant="secondary" class="flex-1">{$LL.consent_denyButton()}</Button>
					<Button class="flex-1">{$LL.consent_allowButton()}</Button>
				</div>
			</Specimen>
			<Specimen
				name="Sizes"
				source="size = sm | md | lg"
				where="sm: inline back button. md: everywhere else. lg: not used on a login page today."
			>
				<Button size="sm">sm</Button>
				<Button>md</Button>
				<Button size="lg">lg</Button>
			</Specimen>
			<Specimen
				name="Loading"
				source="<Button loading>"
				where="Whenever a request is running; the button also disables itself."
			>
				<Button loading>{$LL.common_continue()}</Button>
				<Button variant="secondary" loading>{$LL.login_sendCode()}</Button>
			</Specimen>
			<Specimen
				name="Disabled"
				source="<Button disabled>"
				where="Verify until 6 digits, Allow while a required consent is open."
			>
				<Button disabled>{$LL.emailCode_verifyButton()}</Button>
				<Button variant="secondary" disabled>{$LL.emailCode_resendButton()}</Button>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Screen buttons (runtime-auth-button)">
	{#snippet template()}
		<Catalog
			intro="Rendered through RuntimeScreen: the styles live inside it, so these are the real buttons. Labels the admin did not change are replaced by the current language."
		>
			{#each widgetKinds as [name, kind, field] (name)}
				<Specimen
					{name}
					source="button.runtime-auth-button ({kind})"
					where="login / signup screens, when the method is available and its block is not hidden."
					card
				>
					<RuntimeScreenHarness screen={one(field)} framed={false} />
				</Specimen>
			{/each}
			<Specimen
				name="Busy"
				source="button.runtime-auth-button[aria-busy] + .runtime-auth-spinner"
				where="While the server handles that method; the others stay available unless the whole screen is disabled."
				card
			>
				<RuntimeScreenHarness
					screen={one(blocks.passkey(), blocks.mailOtp())}
					framed={false}
					busy={['mail_otp']}
				/>
			</Specimen>
			<Specimen
				name="Disabled"
				source="button.runtime-auth-button:disabled"
				where="Whole screen disabled, or required consent not yet given."
				card
			>
				<RuntimeScreenHarness
					screen={one(blocks.passkey(), blocks.mailOtp())}
					framed={false}
					disabled
				/>
			</Specimen>
			<Specimen
				name="Code entry actions"
				source="button.runtime-auth-button (back, resend, verify)"
				where="Code input block: Back, Resend (counts down, then enables), Verify."
				card
			>
				<RuntimeScreenHarness
					screen={one(blocks.codeInput('mail_otp'))}
					framed={false}
					values={{ mail_otp_resend_remaining: '42', mail_otp_resend_total: '60' }}
				/>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Provider buttons">
	{#snippet template()}
		<Catalog
			intro="One button per configured external provider. The icon comes from the provider's icon setting, else from its name or type; the colour is the provider's brand colour (a second one for dark mode)."
		>
			<Specimen
				name="Name-matched icons"
				source="getExternalProviderIconClass(provider)"
				where="Google, GitHub, Microsoft are matched by name; SAML falls back to a building."
				card
			>
				<RuntimeScreenHarness screen={one(blocks.externalIdp(false))} framed={false} />
			</Specimen>
			<Specimen
				name="With action text"
				source="external_idp_show_action_text = true"
				where="Admin option: the label reads “Continue with Google”."
				card
			>
				<RuntimeScreenHarness
					screen={one(blocks.externalIdp(true))}
					framed={false}
					providerCount={2}
				/>
			</Specimen>
			<Specimen
				name="None configured"
				source="disabled placeholder"
				where="The block is on the screen but no provider is available to this flow."
				card
			>
				<RuntimeScreenHarness
					screen={one(blocks.externalIdp(false))}
					framed={false}
					providers={false}
				/>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Other controls">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Theme toggle"
				source="button.theme-toggle"
				where="Top bar (LanguageSwitcher), unless the tenant turns it off."
			>
				<LanguageSwitcher showLanguageSelect={false} />
			</Specimen>
			<Specimen
				name="Language select"
				source="select.auth-lang-select"
				where="Top bar; also reused for the organisation picker on consent."
			>
				<LanguageSwitcher showThemeToggle={false} />
			</Specimen>
			<Specimen
				name="Text button"
				source="button.text-xs (unstyled)"
				where="consent: “Not you?” to switch account. A candidate for a shared link-button style."
			>
				<button type="button" style="font-size:0.75rem;color:var(--primary)"
					>{$LL.consent_notYou()}</button
				>
			</Specimen>
			<Specimen
				name="Raw primary button"
				source="button.btn-primary"
				where="callback error: Back to login. Not the Button component, so it is the one primary button that ignores theme tokens."
			>
				<button type="button" class="btn-primary">{$LL.common_backToLogin()}</button>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>
