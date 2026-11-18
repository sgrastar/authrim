<script lang="ts">
	import type { CustomBlockPosition } from '#lib/custom-blocks/custom-blocks.js';
	import { sanitizeFooterHtml } from '#lib/footer/footer-html.js';
	import { useLoginUIStores } from '#lib/stores/login-ui-context.js';
	import SanitizedHtml from './SanitizedHtml.svelte';

	/**
	 * The tenant's own content blocks at one place around the screens (`login-ui.custom_blocks`):
	 * a paragraph, a paragraph with links, an image, or a link. Nothing is drawn when the tenant
	 * has no block there. HTML goes through the footer's rule (`sanitizeFooterHtml`): only
	 * `<a href="https://…">` stays, every other tag is removed and the text kept.
	 */
	type Props = {
		position: CustomBlockPosition;
	};

	let { position }: Props = $props();
	const { loginUIPageStore } = useLoginUIStores();
	const blocks = $derived(
		loginUIPageStore.customBlocks.filter((block) => block.position === position)
	);
</script>

{#if blocks.length > 0}
	<div class="auth-custom-blocks auth-custom-blocks--{position}">
		{#each blocks as block, i (i)}
			{#if block.type === 'text'}
				<p class="auth-custom-block auth-custom-block--text">{block.content}</p>
			{:else if block.type === 'html'}
				<p class="auth-custom-block auth-custom-block--html">
					<SanitizedHtml sanitizedHtml={sanitizeFooterHtml(block.content)} />
				</p>
			{:else if block.type === 'image'}
				<img
					class="auth-custom-block auth-custom-block--image"
					src={block.content}
					alt={block.alt ?? ''}
					loading="lazy"
					onerror={(event) => ((event.currentTarget as HTMLImageElement).style.display = 'none')}
				/>
			{:else if block.type === 'link'}
				<p class="auth-custom-block auth-custom-block--link">
					<a href={block.url} target="_blank" rel="noopener noreferrer">{block.content}</a>
				</p>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.auth-custom-blocks {
		display: grid;
		gap: 0.5rem;
		width: 100%;
		max-width: 100%;
		color: var(--login-copy-color, var(--text-secondary));
		font-size: 0.875rem;
		line-height: 1.5;
		text-align: center;
	}

	.auth-custom-blocks--above-header,
	.auth-custom-blocks--above-form {
		margin-bottom: 1rem;
	}

	.auth-custom-blocks--below-form {
		margin-top: 1rem;
	}

	/* After the footer, which the page (a column) orders last with `order: 3`. */
	.auth-custom-blocks--below-footer {
		order: 4;
		margin: 0.75rem auto 1rem;
		padding: 0 1rem;
		max-width: 28rem;
	}

	/* Above a header bar: a band across the page, not a line of the card. */
	:global(.auth-page) > .auth-custom-blocks--above-header {
		margin: 0;
		padding: 0.75rem clamp(16px, 4vw, 40px) 0;
	}

	.auth-custom-block {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.auth-custom-block--image {
		display: block;
		max-width: 100%;
		max-height: 12rem;
		margin-inline: auto;
		object-fit: contain;
	}

	.auth-custom-block a {
		color: var(--login-link-color, inherit);
		text-decoration: underline;
	}
</style>
