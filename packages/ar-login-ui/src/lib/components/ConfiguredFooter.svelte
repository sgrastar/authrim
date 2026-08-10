<script lang="ts">
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import FooterText from '$lib/components/FooterText.svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';

	type Props = {
		locale?: string;
		class?: string;
	};

	let { locale, class: className = '' }: Props = $props();
	const { loginUIPageStore } = useLoginUIStores();
	const localizedFooterText = $derived(
		loginUIPageStore.getLocalizedText(locale ?? getLocale(), 'footerText')
	);
</script>

{#if loginUIPageStore.footerEnabled}
	<footer class={`auth-footer ${className}`.trim()}>
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
	</footer>
{/if}
