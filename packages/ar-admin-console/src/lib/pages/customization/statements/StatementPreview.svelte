<script lang="ts">
	import type { ConsentContentType } from '#lib/api/consent-statements.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Link from '#lib/ui/primitives/Link.svelte';
	import { isHttpUrl, plainText, type LanguageValue } from './statement-model';

	/** How one language of a statement reads to the person asked: title, summary, text or link. */
	interface Props {
		value: LanguageValue | undefined;
		contentType: ConsentContentType;
		dir?: 'ltr' | 'rtl';
	}

	let { value, contentType, dir }: Props = $props();
</script>

<section class="preview" aria-label={t('cs.content.preview')} {dir}>
	{#if !value || (!value.title && !value.description && !value.content && !value.url)}
		<p class="preview__empty">{t('cs.content.previewEmpty')}</p>
	{:else}
		<h3>{value.title}</h3>
		<p class="preview__summary">{value.description}</p>
		{#if contentType === 'url'}
			{#if isHttpUrl(value.url)}
				<p><Link href={value.url} newTab>{t('cs.content.openDocument')}</Link></p>
			{:else}
				<p class="preview__empty">{t('cs.content.noLink')}</p>
			{/if}
		{:else if value.content.trim()}
			<div class="preview__body">{plainText(value.content)}</div>
		{:else}
			<p class="preview__empty">{t('cs.content.noText')}</p>
		{/if}
	{/if}
</section>

<style>
	.preview {
		display: grid;
		gap: var(--space-related);
		padding: var(--space-related);
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
	}

	.preview h3 {
		margin: 0;
		font-size: var(--fs-heading);
	}

	.preview p {
		margin: 0;
	}

	.preview__summary,
	.preview__empty {
		color: var(--text-secondary);
	}

	.preview__body {
		max-block-size: 360px;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
