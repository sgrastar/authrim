<script lang="ts">
	import type {
		FederationRequestedAttributes,
		FederationSourcesClient
	} from '#lib/api/federation-sources.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';

	/**
	 * What the federation's service providers ask for in their metadata (RequestedAttribute),
	 * counted over them: each attribute with how many ask for it and how many mark it required.
	 * Shown with the mapping, so the attributes that some services cannot do without are not
	 * forgotten. With `sendable` (the attribute names of the output source in use) each row also
	 * says whether the output source has it at all; without, it only reports.
	 */
	interface Props {
		client: Pick<FederationSourcesClient, 'requestedAttributes'>;
		id: string;
		/** The SAML attribute names the output source in use can send; null while none is chosen. */
		sendable?: ReadonlySet<string> | null;
		/** Changes whenever the metadata may have changed (a refresh, a save): read again. */
		refreshKey?: number;
	}

	let { client, id, sendable = null, refreshKey = 0 }: Props = $props();

	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let data = $state<FederationRequestedAttributes | null>(null);
	let generation = 0;

	async function load() {
		const mine = ++generation;
		phase = 'loading';
		try {
			const result = await client.requestedAttributes(id);
			if (mine !== generation) return;
			data = result;
			phase = 'ready';
		} catch {
			if (mine !== generation) return;
			phase = 'failed';
		}
	}

	$effect(() => {
		void id;
		void refreshKey;
		void load();
	});

	const partial = $derived(data !== null && data.spRead < data.spTotal);
</script>

<Card title={t('sf.fed.req.title')} description={t('sf.fed.req.desc')}>
	{#if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('sf.fed.req.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else if data}
		<div class="req">
			{#if partial}
				<Callout tone="info">
					{t('sf.fed.req.partial', { read: data.spRead, total: data.spTotal })}
				</Callout>
			{/if}
			{#if data.attributes.length === 0}
				{#if !partial}<p class="req__none">{t('sf.fed.req.none')}</p>{/if}
			{:else}
				<ul class="req__list" aria-label={t('sf.fed.req.title')}>
					{#each data.attributes as attribute (attribute.name)}
						<li class="req__row">
							<div class="req__name">
								<span class="req__label">{attribute.friendlyName ?? attribute.name}</span>
								{#if attribute.friendlyName}
									<code class="req__id" dir="ltr">{attribute.name}</code>
								{/if}
							</div>
							<div class="req__marks">
								{#if attribute.requiredBy > 0}
									<Badge tone="warning">
										{t('sf.fed.req.required', { count: attribute.requiredBy })}
									</Badge>
								{:else}
									<Badge>{t('sf.fed.req.optional')}</Badge>
								{/if}
								<span class="req__count">
									{t('sf.fed.req.askedBy', { count: attribute.requestedBy })}
								</span>
								{#if sendable}
									{#if sendable.has(attribute.name)}
										<Badge tone="success">{t('sf.fed.req.sendable')}</Badge>
									{:else}
										<Badge tone={attribute.requiredBy > 0 ? 'danger' : 'neutral'}>
											{t('sf.fed.req.notSendable')}
										</Badge>
									{/if}
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</Card>

<style>
	.req {
		display: grid;
		gap: var(--space-related);
	}

	.req__none {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-body);
	}

	.req__list {
		display: grid;
		gap: 0;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.req__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-related);
		padding-block: 10px;
		border-block-start: 1px solid var(--border-subtle);
	}

	.req__row:first-child {
		border-block-start: 0;
	}

	.req__name {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.req__label {
		color: var(--text-primary);
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	.req__id {
		overflow-wrap: anywhere;
		color: var(--text-muted);
		font-family: var(--font-mono);
		font-size: var(--fs-caption);
	}

	.req__marks {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
	}

	.req__count {
		color: var(--text-secondary);
		font-size: var(--fs-caption);
	}
</style>
