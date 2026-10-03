<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Catalog from '$lib/storybook/Catalog.svelte';
	import { blocks, screenOf } from '$lib/storybook/fixtures';
	import RuntimeScreenHarness from '$lib/storybook/RuntimeScreenHarness.svelte';
	import Specimen from '$lib/storybook/Specimen.svelte';

	const { Story } = defineMeta({
		title: 'Catalog/Text',
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Headings, body and helper text. Wording comes from three places: the **language files** (`src/i18n`), the **screen** an admin edits (heading, text and label blocks, per language), and **tenant settings** (tagline, footer text, brand panel copy, login and registration titles, per language). Sizes follow the **font scale** and **font family** settings; switch them under **Page shell / Settings / Fonts and density**.'
				}
			}
		}
	});
</script>

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
</script>

<Story name="Page header">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Brand name"
				source="h1.auth-header__title"
				where="Every page with a header; hidden when the tenant turns the header off, or when the logo setting is “image” and a logo exists."
			>
				<div class="auth-header" style="width:100%">
					<h1 class="auth-header__title">Acme ID</h1>
				</div>
			</Specimen>
			<Specimen
				name="Tagline"
				source="p.auth-header__subtitle"
				where="Under the brand name; tenant text per language, else the default line. Off when “subtitle” is off."
			>
				<div class="auth-header" style="width:100%">
					<p class="auth-header__subtitle">{$LL.app_subtitle()}</p>
				</div>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Card headings">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Section title and subtitle"
				source="h2.auth-section-title + p.auth-section-subtitle"
				where="consent, device, reauth, error, callback, logout, verify-email-code; login and signup fallback layout."
				card
			>
				<h2 class="auth-section-title">{$LL.reauth_title()}</h2>
				<p class="auth-section-subtitle">{$LL.reauth_subtitle()}</p>
			</Specimen>
			<Specimen
				name="Centred variant"
				source=".auth-section-title.text-center"
				where="Pages that start with an icon badge."
				card
			>
				<h2 class="auth-section-title text-center">{$LL.error_title()}</h2>
				<p class="auth-section-subtitle text-center">{$LL.error_subtitle()}</p>
			</Specimen>
			<Specimen
				name="Screen heading"
				source=".runtime-screen-heading h2 (+ p)"
				where="Login and signup: the heading block. The first heading takes the tenant's “login title” or “registration title” when set."
				card
			>
				<RuntimeScreenHarness
					screen={screenOf([blocks.heading('Sign in', 'Use your Acme account to continue.')])}
					framed={false}
				/>
			</Specimen>
			<Specimen
				name="Screen heading with a tenant title"
				source="headingOverride"
				where="Tenant sets “login title” for the language."
				card
			>
				<RuntimeScreenHarness
					screen={screenOf([blocks.heading('Sign in')])}
					framed={false}
					headingOverride="Welcome back to Acme"
				/>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Body, helper and error text">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Screen text"
				source="p.runtime-screen-text"
				where="Text block of a screen."
				card
			>
				<RuntimeScreenHarness
					screen={screenOf([
						blocks.text('Text blocks carry short notes, for example which account to use.')
					])}
					framed={false}
				/>
			</Specimen>
			<Specimen
				name="Field label, help and error"
				source=".runtime-screen-field span / small / small.runtime-screen-error"
				where="Identity field blocks (signup)."
				card
			>
				<RuntimeScreenHarness
					screen={screenOf([
						{ ...blocks.name('given_name', 'First name'), help_text: 'As on your passport.' },
						blocks.name('family_name', 'Last name')
					])}
					framed={false}
					mode="signup"
					errors={{ family_name: 'Enter your last name.' }}
				/>
			</Specimen>
			<Specimen
				name="Divider label"
				source=".runtime-screen-divider.has-label / .auth-divider__text"
				where="Between method groups; the label is the block's text, “or” on the legacy layout."
				card
			>
				<RuntimeScreenHarness
					screen={screenOf([blocks.divider('Continue with another account')])}
					framed={false}
				/>
				<div class="auth-divider">
					<div class="auth-divider__line"></div>
					<span class="auth-divider__text">{$LL.common_or()}</span>
					<div class="auth-divider__line"></div>
				</div>
			</Specimen>
			<Specimen
				name="Instructions box"
				source="div.auth-binding-message > p.text-sm"
				where="verify-email-code, above the code."
				card
			>
				<div class="auth-binding-message">
					<p class="text-sm" style="color:var(--text-secondary)">{$LL.emailCode_instructions()}</p>
				</div>
			</Specimen>
			<Specimen
				name="Terms line"
				source="p.text-xs.text-center (muted)"
				where="signup fallback layout, under the methods."
				card
			>
				<p class="text-xs text-center" style="color:var(--text-muted)">
					{$LL.register_termsAgreement()}
				</p>
			</Specimen>
			<Specimen
				name="Error code"
				source=".auth-error-code-box"
				where="error and callback pages."
				card
			>
				<div class="auth-error-code-box">
					<p class="auth-error-code-box__label">{$LL.error_errorCode()}</p>
					<p class="auth-error-code-box__value">access_denied</p>
				</div>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>

<Story name="Client and organisation">
	{#snippet template()}
		<Catalog>
			<Specimen
				name="Signing in to…"
				source=".auth-client-card__label / __name"
				where="login, for client-initiated sign-ins."
				card
			>
				<div class="auth-client-card">
					<div class="auth-client-card__row">
						<div class="flex-1 min-w-0">
							<p class="auth-client-card__label">{$LL.login_signingInTo()}</p>
							<p class="auth-client-card__name">Acme Dashboard</p>
						</div>
					</div>
				</div>
			</Specimen>
			<Specimen
				name="Info box"
				source=".auth-info-box__label / __value"
				where="consent (organisation), device and reauth (client)."
				card
			>
				<div class="auth-info-box">
					<p class="auth-info-box__label">{$LL.consent_currentOrganization()}</p>
					<p class="auth-info-box__value">Acme Inc.</p>
				</div>
			</Specimen>
		</Catalog>
	{/snippet}
</Story>
