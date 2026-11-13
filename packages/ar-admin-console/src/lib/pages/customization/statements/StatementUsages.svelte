<script lang="ts">
	import type { ConsentStatementUsage } from '#lib/api/consent-statements.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';

	/**
	 * Where a statement is used: the flows that ask for it (in a draft, a published version, or
	 * both) and the services (OIDC clients and SAML providers) that release information on it.
	 */
	interface Props {
		/** Null when the API could not tell. */
		usage: ConsentStatementUsage | null;
		/** False when a stored document could not be read in full. */
		complete: boolean;
		known: boolean;
	}

	let { usage, complete, known }: Props = $props();

	const flows = $derived(usage?.flows ?? []);
	const services = $derived(usage?.services ?? []);
</script>

{#if !known}
	<Callout tone="warning">{t('cs.usage.unknown')}</Callout>
{:else}
	{#if !complete}
		<Callout tone="warning">{t('cs.usage.incomplete')}</Callout>
	{/if}
	{#if flows.length === 0 && services.length === 0}
		<EmptyState icon="list" title={t('cs.usage.none')} description={t('cs.usage.empty')} />
	{:else}
		<ul class="usages">
			{#each flows as flow (flow.flow_id)}
				<li>
					<span class="usages__kind">{t('cs.usage.flow')}</span>
					<strong>{flow.name}</strong>
					{#if flow.published}<Badge tone="success">{t('cs.usage.published')}</Badge>{/if}
					{#if flow.draft}<Badge>{t('cs.usage.draft')}</Badge>{/if}
				</li>
			{/each}
			{#each services as service (`${service.protocol}:${service.id}`)}
				<li>
					<span class="usages__kind">
						{service.protocol === 'saml' ? t('cs.usage.saml') : t('cs.usage.oidc')}
					</span>
					<strong>{service.name}</strong>
				</li>
			{/each}
		</ul>
	{/if}
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

	.usages__kind {
		color: var(--text-secondary);
		font-size: var(--fs-caption);
	}
</style>
