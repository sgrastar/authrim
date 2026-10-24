<script lang="ts">
	import type { EffectiveSelection } from '$lib/api/identity-mapping';
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import { effectText, setUsable, sourceText } from './labels';

	/**
	 * What is in effect and where it was decided, as the API returned it: the source word (one of
	 * the four, with the colour of its level as a dot) and the set or the kind of "none". A set
	 * that cannot be used, or a selection that failed, shows the warning sign: no token is issued.
	 */
	interface Props {
		selection: EffectiveSelection;
		/** Show "Source:" before the word (where the label is not given by a column head). */
		labelled?: boolean;
		/** Only the source word (tables where the set has its own column). */
		compact?: boolean;
	}

	let { selection, labelled = false, compact = false }: Props = $props();

	const level = $derived(selection.kind === 'bound' ? selection.tier : 'none');
	const problem = $derived(
		selection.kind === 'failed' || (selection.kind === 'bound' && !setUsable(selection))
	);
</script>

<span class="source">
	{#if labelled}<span class="muted">{t('mc.source')}</span>{/if}
	{#if problem}
		<Icon name="warning" />
	{:else}
		<span class="dot" data-level={level} aria-hidden="true"></span>
	{/if}
	<span class="word">{sourceText(selection)}</span>
	{#if !compact && selection.kind !== 'failed'}
		<span class="muted" aria-hidden="true">·</span>
		<span class="effect" class:warn={problem}>{effectText(selection)}</span>
	{/if}
</span>

<style>
	.source {
		display: inline-flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		min-width: 0;
	}

	.dot {
		inline-size: 8px;
		block-size: 8px;
		border-radius: var(--radius-round);
		background: var(--border-strong);
		flex: none;
	}

	.dot[data-level='client'] {
		background: var(--accent-client);
	}

	.dot[data-level='tenant_default'] {
		background: var(--accent-tenant);
	}

	.dot[data-level='platform_default'] {
		background: var(--accent-platform);
	}

	.word {
		font-weight: var(--fw-semibold);
	}

	.effect {
		color: var(--text-secondary);
	}

	.effect.warn {
		color: var(--warning-text);
	}

	.source :global(svg) {
		color: var(--warning);
	}

	.muted {
		color: var(--text-secondary);
	}
</style>
