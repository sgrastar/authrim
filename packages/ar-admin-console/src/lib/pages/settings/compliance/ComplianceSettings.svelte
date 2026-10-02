<script lang="ts">
	import { untrack } from 'svelte';
	import type { ComplianceClient } from '$lib/api/compliance';
	import { t } from '$lib/i18n/i18n.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import Tabs from '$lib/ui/patterns/Tabs.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import AccessReviews from './AccessReviews.svelte';
	import ComplianceOverview from './ComplianceOverview.svelte';
	import ComplianceReports from './ComplianceReports.svelte';
	import DataRetention from './DataRetention.svelte';

	interface Props {
		client: ComplianceClient;
		tenantId: string;
		/** The tab shown first (stories and links). */
		initialTab?: 'overview' | 'reviews' | 'reports' | 'retention';
	}

	let { client, tenantId, initialTab = 'overview' }: Props = $props();

	// The first tab only; the admin picks the rest.
	let tab = $state<string>(untrack(() => initialTab));

	const tabs = $derived([
		{ id: 'overview', label: t('cmp.tab.overview') },
		{ id: 'reviews', label: t('cmp.tab.reviews') },
		{ id: 'reports', label: t('cmp.tab.reports') },
		{ id: 'retention', label: t('cmp.tab.retention') }
	]);
</script>

<Page width="wide">
	<PageHeader title={t('cmp.page')} description={t('cmp.page.desc')} />
	<Tabs label={t('cmp.page')} items={tabs} bind:value={tab}>
		{#snippet panel(id)}
			{#if id === 'overview'}
				<ComplianceOverview {client} {tenantId} />
			{:else if id === 'reviews'}
				<AccessReviews {client} {tenantId} />
			{:else if id === 'reports'}
				<ComplianceReports {client} {tenantId} />
			{:else}
				<DataRetention {client} {tenantId} />
			{/if}
		{/snippet}
	</Tabs>
</Page>
