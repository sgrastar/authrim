<script lang="ts">
	import { environmentBannerText } from '@authrim/ar-lib-core/utils/environment-banner-text';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';

	/**
	 * The platform's environment notice ("This is the staging environment"), as a flat full-width
	 * band in the shell's `banner` slot. A notice only, not a security control. The text comes from
	 * the session answer: the language's own text, else the general one; nothing is drawn while
	 * there is none.
	 */
	interface Props {
		text: string;
		textLocalizations?: Readonly<Record<string, string>>;
	}

	let { text, textLocalizations = {} }: Props = $props();

	const shown = $derived(environmentBannerText({ text, textLocalizations }, i18n.locale));
</script>

{#if shown}
	<section class="environment-banner" aria-label={t('env.banner.label')}>
		<p>{shown}</p>
	</section>
{/if}

<style>
	.environment-banner {
		padding: 6px var(--space-page-x);
		border-block-end: 1px solid color-mix(in srgb, var(--warning) 24%, transparent);
		background: var(--warning-bg);
		color: var(--warning-text);
		font-size: var(--fs-small);
	}

	.environment-banner p {
		margin: 0;
		text-align: center;
		overflow-wrap: anywhere;
	}
</style>
