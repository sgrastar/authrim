<script lang="ts">
	import { onMount } from 'svelte';
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import type {
		FederationRefreshResult,
		FederationSourcesClient
	} from '#lib/api/federation-sources.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import DetailItem from '#lib/ui/patterns/DetailItem.svelte';
	import DetailList from '#lib/ui/patterns/DetailList.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';

	/**
	 * What a federation just made does first: it fetches the metadata once and checks its
	 * signature, so the person sees at once how many entities came in and whether the
	 * certificate they gave was the right one, instead of finding out at the next update.
	 */
	interface Props {
		sourceId: string;
		client: FederationSourcesClient;
		/** Open the federation (its own page). */
		onopen: () => void;
		pending?: boolean;
	}
	let { sourceId, client, onopen, pending = false }: Props = $props();

	let phase = $state<'running' | 'done' | 'failed'>('running');
	let result = $state<FederationRefreshResult | null>(null);
	let failure = $state('');

	async function run() {
		phase = 'running';
		failure = '';
		try {
			result = await client.refresh(sourceId);
			phase = 'done';
		} catch (error) {
			failure =
				error instanceof StepUpCancelledError
					? t('settings.stepUpCancelled')
					: error instanceof Error && error.message
						? error.message
						: t('sf.fed.created.failed');
			phase = 'failed';
		}
	}
	onMount(() => void run());

	const verified = $derived(result?.verificationStatus === 'verified');
</script>

{#if phase === 'running'}
	<LoadingState label={t('sf.fed.created.fetching')} />
{:else if phase === 'failed'}
	<Callout tone="warning" live title={t('sf.fed.created.failedTitle')}>
		{failure}
		<Button size="sm" onclick={run}>{t('common.retry')}</Button>
	</Callout>
{:else if result}
	<Callout
		tone={verified ? 'info' : 'warning'}
		title={t(verified ? 'sf.fed.created.ok' : 'sf.fed.created.unverified')}
	>
		{t(verified ? 'sf.fed.created.okBody' : 'sf.fed.created.unverifiedBody')}
	</Callout>
	<Callout tone="info">{t('sf.fed.created.mappingNeeded')}</Callout>
	<DetailList columns={2} size="sm">
		<DetailItem label={t('sf.fed.created.entities')}>{result.entityCount}</DetailItem>
		<DetailItem label={t('sf.fed.created.signature')}>
			<Badge tone={verified ? 'success' : 'warning'} dot
				>{t(`sf.fed.verification.${result.verificationStatus ?? 'unverified'}`)}</Badge
			>
		</DetailItem>
	</DetailList>
{/if}
<div>
	<Button onclick={onopen} disabled={pending || phase === 'running'} loading={pending}
		>{t('sf.fed.created.open')}</Button
	>
</div>
