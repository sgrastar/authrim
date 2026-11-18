<script lang="ts">
	import type { ConsentContentType } from '#lib/api/consent-statements.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { statementDescriptionHtml } from './statement-html';
	import { isHttpUrl, plainText, type LanguageValue } from './statement-model';

	/** How one language of a statement reads to the person asked: title, summary, text or link. */
	interface Props {
		value: LanguageValue | undefined;
		contentType: ConsentContentType;
		dir?: 'ltr' | 'rtl';
		/**
		 * Say the document's link under the preview: where it cannot be read in a field (a version
		 * shown read-only). People asked see only the description's own links.
		 */
		showUrl?: boolean;
	}

	let { value, contentType, dir, showUrl = false }: Props = $props();
</script>

<section class="preview" aria-label={t('cs.content.preview')} {dir}>
	{#if !value || (!value.title && !value.description && !value.content && !value.url)}
		<p class="preview__empty">{t('cs.content.previewEmpty')}</p>
	{:else}
		<h3>{value.title}</h3>
		<!-- Sanitized as the sign-in screen shows it (a few tags only, every link checked). -->
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		<div class="preview__summary">{@html statementDescriptionHtml(value.description)}</div>
		{#if contentType === 'url'}
			<!-- The link is the description's own (an <a> in it), so none is added here. -->
			{#if !isHttpUrl(value.url)}
				<p class="preview__empty">{t('cs.content.noLink')}</p>
			{:else if showUrl}
				<p class="preview__url">{t('cs.content.url')}: <bdi>{value.url}</bdi></p>
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

	.preview__url {
		color: var(--text-secondary);
		overflow-wrap: anywhere;
	}

	.preview__summary,
	.preview__empty {
		color: var(--text-secondary);
	}

	/* The description is HTML (statement-html.ts): its links read as the console's links do. */
	.preview__summary :global(a) {
		color: var(--info);
		text-decoration: underline;
		text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
		text-decoration-thickness: 1px;
		text-underline-offset: 3px;
	}

	.preview__summary :global(p) {
		margin: 0;
	}

	.preview__body {
		max-block-size: 360px;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
