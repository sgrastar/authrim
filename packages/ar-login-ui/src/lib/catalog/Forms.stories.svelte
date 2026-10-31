<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Input from '$lib/components/Input.svelte';
	import PinCodeInput from '$lib/components/PinCodeInput.svelte';
	import ToggleSwitch from '$lib/components/ToggleSwitch.svelte';
	import TurnstileWidget from '$lib/components/TurnstileWidget.svelte';
	import Catalog from '$lib/storybook/Catalog.svelte';
	import { blocks, screenOf } from '$lib/storybook/fixtures';
	import RuntimeScreenHarness from '$lib/storybook/RuntimeScreenHarness.svelte';
	import Specimen from '$lib/storybook/Specimen.svelte';

	const { Story } = defineMeta({
		title: 'Catalog/Forms',
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						"Inputs, choices and verification widgets. Two families again: `Input` for the legacy layout and signup's fallback, and the `.runtime-screen-field` inputs that RuntimeScreen draws for screen blocks."
				}
			}
		}
	});
</script>

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';

	let code = $state('12');
	let toggle = $state(true);
	let token = $state('');
</script>

<Story name="Text inputs">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Input"
				source="<Input>"
				where="Legacy layout: email, directory username and password, TOTP; signup fallback fields."
				card
			>
				<Input
					label={$LL.common_email()}
					placeholder={$LL.common_emailPlaceholder()}
					type="email"
				/>
				<Input
					label={$LL.login_directoryPasswordLabel()}
					placeholder={$LL.login_directoryPasswordPlaceholder()}
					type="password"
					value="secret"
				/>
			</Specimen>
			<Specimen
				name="Input with an error"
				source="<Input error>"
				where="Validation message under the field; the border turns to the danger colour."
				card
			>
				<Input
					label={$LL.common_email()}
					value="not-an-email"
					error="Enter a valid email address."
				/>
			</Specimen>
			<Specimen name="Input with a hint" source="<Input helperText>" card>
				<Input label={$LL.common_email()} helperText="We only use this to send you a code." />
			</Specimen>
			<Specimen name="Disabled input" source="<Input disabled>" card>
				<Input label={$LL.common_email()} value="ada@example.com" disabled />
			</Specimen>
			<Specimen
				name="Screen field"
				source="label.runtime-screen-field > input"
				where="Identity field and shared email input of a screen."
				card
			>
				<RuntimeScreenHarness
					screen={screenOf([blocks.email()])}
					framed={false}
					mode="signup"
					values={{ email: 'ada@example.com' }}
				/>
			</Specimen>
			<Specimen
				name="Screen field with an error"
				source=".runtime-screen-field + small.runtime-screen-error"
				card
			>
				<RuntimeScreenHarness
					screen={screenOf([blocks.email()])}
					framed={false}
					mode="signup"
					values={{ email: 'nope' }}
					errors={{ email: 'Enter a valid email address.' }}
				/>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Codes">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="PIN cells"
				source="<PinCodeInput>"
				where="Email-code and authenticator-code entry: 6 cells (8 for some authenticators), paste fills them all."
				card
			>
				<PinCodeInput
					value={code}
					length={6}
					label={$LL.login_totpCodeLabel()}
					onValueChange={(next) => (code = next)}
				/>
			</Specimen>
			<Specimen name="PIN cells, disabled" source="<PinCodeInput disabled>" card>
				<PinCodeInput value="123456" length={6} disabled label={$LL.login_totpCodeLabel()} />
			</Specimen>
			<Specimen
				name="Code input block"
				source="div.runtime-code-input-widget"
				where="Screen block with progress bar for the resend wait."
				card
			>
				<RuntimeScreenHarness
					screen={screenOf([blocks.codeInput('mail_otp')])}
					framed={false}
					values={{ mail_otp_resend_remaining: '30', mail_otp_resend_total: '60' }}
				/>
			</Specimen>
			<Specimen
				name="Device code"
				source="input.auth-code-input"
				where="device: the code shown on the TV or CLI, typed here."
				card
			>
				<input
					class="auth-code-input"
					type="text"
					value="ABCD-1234"
					maxlength="9"
					aria-label={$LL.device_codeLabel()}
				/>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Choices">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Checkbox field"
				source=".runtime-checkbox-row"
				where="Boolean identity field (newsletter, terms)."
				card
			>
				<RuntimeScreenHarness
					screen={screenOf([blocks.checkbox('newsletter', 'Newsletter', 'Send me product news')])}
					framed={false}
					mode="signup"
				/>
			</Specimen>
			<Specimen
				name="Consent choices"
				source=".runtime-consent-choice (checkbox / radio / display only)"
				where="Consent block: required, optional, single choice and read-only items."
				card
			>
				<RuntimeScreenHarness
					screen={screenOf([blocks.consent()])}
					framed={false}
					mode="signup"
					withConsent
				/>
			</Specimen>
			<Specimen
				name="Select"
				source="select.custom-field-select / select.auth-lang-select"
				where="signup enum fields (route style); organisation picker on consent; language picker."
			>
				<select class="auth-lang-select" aria-label={$LL.consent_organizationSelect()}>
					<option>Acme Inc.</option>
					<option>Acme Labs</option>
				</select>
			</Specimen>
			<Specimen
				name="Toggle switch"
				source="<ToggleSwitch>"
				where="Not used on a login page today; kept in the component set."
			>
				<ToggleSwitch bind:checked={toggle} label={$LL.theme_switchToDarkMode()} />
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Human verification">
	{#snippet template()}
		<Catalog
			intro="The widgets are replaced by a sample box so the stories stay offline; the real ones come from Cloudflare Turnstile, hCaptcha or reCAPTCHA."
		>
			<Specimen
				name="Widget"
				source="<TurnstileWidget>"
				where="Before login or signup actions when the tenant requires verification."
				card
			>
				<TurnstileWidget siteKey="storybook" action="authrim-login" bind:token />
			</Specimen>
			<Specimen
				name="Security verification block"
				source="div.runtime-security-verification"
				where="Screen block; “after submit” timing shows it only after a first attempt."
				card
			>
				<RuntimeScreenHarness
					screen={screenOf([blocks.security('initial')])}
					framed={false}
					humanVerification
				/>
			</Specimen>
			<Specimen
				name="Label while loading"
				source="p.turnstile-status"
				where="Shown until the provider script has drawn the widget."
				card
			>
				<p class="turnstile-status" style="font-size:0.8125rem;color:var(--text-muted)">
					{$LL.login_humanVerificationLoading()}
				</p>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>
