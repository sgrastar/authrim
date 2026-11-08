<script lang="ts">
	import type { Snippet } from 'svelte';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import FooterText from '#lib/components/FooterText.svelte';
	import { useLoginUIStores } from '#lib/stores/login-ui-context.js';

	type Props = {
		locale?: string;
		class?: string;
		/** What else sits in the footer bar (the colour-mode and language choices), and on which side. */
		tools?: Snippet;
		toolsSide?: 'left' | 'center' | 'right';
	};

	let { locale, class: className = '', tools, toolsSide = 'right' }: Props = $props();
	const { loginUIPageStore } = useLoginUIStores();
	const localizedFooterText = $derived(
		loginUIPageStore.getLocalizedText(locale ?? getLocale(), 'footerText')
	);
	const BAR_ZONES = ['left', 'center', 'right'] as const;
</script>

{#snippet content()}
	{#if loginUIPageStore.footerLinks.length > 0}
		<nav class="auth-footer__links" aria-label={$LL.common_footerLinks()}>
			{#each loginUIPageStore.footerLinks as link (link.url)}
				<a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>
			{/each}
		</nav>
	{/if}
	{#if loginUIPageStore.poweredByEnabled}
		<FooterText value={localizedFooterText ?? $LL.footer_stack()} />
	{/if}
{/snippet}

{#if loginUIPageStore.footerEnabled}
	{#if loginUIPageStore.footerBar}
		<!-- The footer bar runs along the bottom of the whole page: its text at the start, middle or
		     end, and the choices on their side when they sit in it. -->
		<footer
			class={`auth-footer auth-bar auth-bar--footer ${className}`.trim()}
			data-align={loginUIPageStore.footerAlign}
		>
			{#each BAR_ZONES as zone (zone)}
				<div class="auth-bar__zone auth-bar__zone--{zone}">
					{#if loginUIPageStore.footerAlign === zone}
						<div class="auth-bar__content">{@render content()}</div>
					{/if}
					{#if tools && toolsSide === zone}{@render tools()}{/if}
				</div>
			{/each}
		</footer>
	{:else}
		<footer class={`auth-footer ${className}`.trim()}>
			{@render content()}
		</footer>
	{/if}
{/if}
