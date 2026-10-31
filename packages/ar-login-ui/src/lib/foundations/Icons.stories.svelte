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
						'Icons the login pages use, all from **Phosphor** (`i-ph-*`, regular weight unless the name ends in `-fill`). They are UnoCSS icon classes, so an icon must appear as a literal class name in source (or in the safelist in `uno.config.ts`) to be generated.'
				}
			}
		}
	});

	// Literal class names so UnoCSS generates every one of them.
	const icons = [
		['i-ph-arrow-clockwise', 'refresh, resend code'],
		['i-ph-arrow-left', 'back links and buttons'],
		['i-ph-arrow-right', 'call to action, account launcher'],
		['i-ph-arrow-square-out', 'external links, account launcher'],
		['i-ph-buildings', 'client placeholder (consent)'],
		['i-ph-check', 'logout complete, approve'],
		['i-ph-check-circle', 'success, scopes, verify'],
		['i-ph-circle-notch', 'busy spinner'],
		['i-ph-device-mobile', 'device, authenticator app'],
		['i-ph-envelope-simple', 'email code'],
		['i-ph-envelope-simple-fill', 'verify-email-code badge'],
		['i-ph-globe', 'language, provider fallback'],
		['i-ph-handshake', 'consent block'],
		['i-ph-identification-card', 'directory password'],
		['i-ph-info', 'info alert, binding message'],
		['i-ph-key', 'passkey'],
		['i-ph-magnifying-glass', 'account launcher search'],
		['i-ph-moon', 'theme toggle (to dark)'],
		['i-ph-note-pencil', 'account page'],
		['i-ph-question', 'contact support'],
		['i-ph-seal-check', 'no pending requests (ciba)'],
		['i-ph-shield-check', 'trusted client'],
		['i-ph-shield-warning', 'reauth badge'],
		['i-ph-star', 'account launcher'],
		['i-ph-star-fill', 'account launcher'],
		['i-ph-sun', 'theme toggle (to light)'],
		['i-ph-user', 'avatar placeholder'],
		['i-ph-warning', 'warning alert, delegated access'],
		['i-ph-warning-circle', 'error badge'],
		['i-ph-x', 'dismiss, reject'],
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

<Story name="Interface">
	{#snippet template()}<Catalog>{@render grid(icons)}</Catalog>{/snippet}
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
