<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Catalog from '$lib/storybook/Catalog.svelte';

	const { Story } = defineMeta({
		title: 'Foundations/Icons',
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Icons the login pages use today. **Heroicons** (`i-heroicons-*`) draw the page markup; **Phosphor** (`i-ph-*`) draw screens, alerts and provider buttons. Both are UnoCSS icon classes, so an icon must appear as a literal class name in source (or in the safelist in `uno.config.ts`) to be generated. Two sets for one UI is a candidate for consolidation.'
				}
			}
		}
	});

	// Literal class names so UnoCSS generates every one of them.
	const heroicons = [
		['i-heroicons-arrow-left', 'back links and buttons'],
		['i-heroicons-arrow-path', 'refresh (ciba)'],
		['i-heroicons-arrow-right', 'landing call to action'],
		['i-heroicons-arrow-top-right-on-square', 'external links (consent)'],
		['i-heroicons-building-office', 'client placeholder (consent)'],
		['i-heroicons-check', 'logout complete, approve'],
		['i-heroicons-check-badge', 'no pending requests (ciba)'],
		['i-heroicons-check-circle', 'success, scopes, callback'],
		['i-heroicons-device-phone-mobile', 'device, authenticator app'],
		['i-heroicons-envelope', 'email code'],
		['i-heroicons-envelope-solid', 'verify-email-code badge'],
		['i-heroicons-exclamation-circle', 'error badge'],
		['i-heroicons-exclamation-triangle', 'delegated access warning'],
		['i-heroicons-identification', 'directory password'],
		['i-heroicons-information-circle', 'binding message (ciba)'],
		['i-heroicons-key', 'passkey'],
		['i-heroicons-moon', 'theme toggle (to dark)'],
		['i-heroicons-pencil-square', 'account page'],
		['i-heroicons-question-mark-circle', 'contact support'],
		['i-heroicons-shield-check', 'trusted client'],
		['i-heroicons-shield-exclamation', 'reauth badge'],
		['i-heroicons-sun', 'theme toggle (to light)'],
		['i-heroicons-user', 'avatar placeholder'],
		['i-heroicons-x-mark', 'reject (ciba)']
	] as const;

	const phosphor = [
		['i-ph-arrow-clockwise', 'resend code'],
		['i-ph-arrow-left', 'back (screen)'],
		['i-ph-arrow-right', 'account launcher'],
		['i-ph-arrow-square-out', 'account launcher'],
		['i-ph-check-circle', 'verify, success alert'],
		['i-ph-circle-notch', 'busy spinner'],
		['i-ph-device-mobile', 'authenticator app (screen)'],
		['i-ph-envelope-simple', 'email code (screen)'],
		['i-ph-globe', 'provider fallback'],
		['i-ph-handshake', 'consent block'],
		['i-ph-identification-card', 'directory password (screen)'],
		['i-ph-info', 'info alert'],
		['i-ph-key', 'passkey (screen)'],
		['i-ph-magnifying-glass', 'account launcher search'],
		['i-ph-star', 'account launcher'],
		['i-ph-star-fill', 'account launcher'],
		['i-ph-warning', 'warning alert'],
		['i-ph-x', 'dismiss alert'],
		['i-ph-x-circle', 'error alert']
	] as const;

	const providers = [
		['i-ph-google-logo', 'Google'],
		['i-ph-github-logo', 'GitHub'],
		['i-ph-windows-logo', 'Microsoft / Azure'],
		['i-ph-apple-logo', 'Apple'],
		['i-ph-meta-logo', 'Facebook / Meta'],
		['i-ph-x-logo', 'X / Twitter'],
		['i-ph-linkedin-logo', 'LinkedIn'],
		['i-ph-buildings', 'SAML'],
		['i-ph-identification-badge', 'verifiable credentials'],
		['i-ph-sign-in', 'other providers']
	] as const;
</script>

{#snippet grid(items: readonly (readonly [string, string])[])}
	<div class="grid">
		{#each items as [name, use] (name)}
			<div class="cell">
				<span class={`${name} icon`}></span>
				<code>{name}</code>
				<small>{use}</small>
			</div>
		{/each}
	</div>
{/snippet}

<Story name="Heroicons (page markup)">
	{#snippet template()}<Catalog>{@render grid(heroicons)}</Catalog>{/snippet}
</Story>

<Story name="Phosphor (screens and alerts)">
	{#snippet template()}<Catalog>{@render grid(phosphor)}</Catalog>{/snippet}
</Story>

<Story name="Provider logos">
	{#snippet template()}
		<Catalog
			intro="Chosen from the provider's name or type unless the admin picks an icon (a fixed list in login-provider-icons.ts)."
		>
			{@render grid(providers)}
		</Catalog>
	{/snippet}
</Story>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 12px;
	}

	.cell {
		display: grid;
		justify-items: start;
		gap: 4px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-card);
	}

	.icon {
		width: 24px;
		height: 24px;
		color: var(--primary);
	}

	code {
		font: 0.6875rem/1.3 var(--font-mono);
		color: var(--text-primary);
		word-break: break-all;
	}

	small {
		font-size: 0.6875rem;
		color: var(--text-muted);
	}
</style>
