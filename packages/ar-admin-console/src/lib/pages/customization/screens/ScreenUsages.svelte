<script lang="ts">
	import type { ScreenUsage } from '#lib/api/screens.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';

	/**
	 * Where a screen is used: the flow nodes that show it (in a draft, a published version, or an
	 * older version sign-ins in progress still run) and the account pages that place it.
	 */
	interface Props {
		usages: readonly ScreenUsage[];
		/** False when a flow or a settings document could not be read in full. */
		complete: boolean;
	}

	let { usages, complete }: Props = $props();
</script>

{#if !complete}
	<Callout tone="warning">{t('sc.usage.incomplete')}</Callout>
{/if}
{#if usages.length === 0}
	<EmptyState icon="list" title={t('sc.usage.none')} description={t('sc.usage.empty')} />
{:else}
	<ul class="usages">
		{#each usages as usage, index (index)}
			<li>
				{#if usage.kind === 'flow'}
					<span class="usages__kind">{t('sc.usage.flow')}</span>
					<strong>{usage.flow_name}</strong>
					{#if usage.node_title || usage.node_id}
						<span class="usages__node">
							{t('sc.usage.node', { name: usage.node_title || usage.node_id || '' })}
						</span>
					{/if}
					<Badge tone={usage.stage === 'published' ? 'success' : 'neutral'}>
						{t(`sc.usage.stage.${usage.stage}` as MessageKey)}
					</Badge>
				{:else}
					<span class="usages__kind">{t('sc.usage.accountPage')}</span>
					<strong>{usage.page_name}</strong>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
	.usages {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.usages li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 10px;
		padding: 10px 0;
	}

	.usages li + li {
		border-top: 1px solid var(--border-subtle);
	}

	.usages__kind,
	.usages__node {
		color: var(--text-secondary);
		font-size: var(--fs-caption);
	}
</style>
