<script lang="ts">
	import { onMount } from 'svelte';
	import { adminComplianceAPI, type ComplianceStatus } from '$lib/api/admin-compliance';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminTabs from '$lib/components/admin/AdminTabs.svelte';
	import type { AdminTabItem } from '$lib/components/admin/AdminTabs.svelte';
	import AccessReviews from '$lib/components/compliance/AccessReviews.svelte';
	import ComplianceOverview from '$lib/components/compliance/ComplianceOverview.svelte';
	import ComplianceReports from '$lib/components/compliance/ComplianceReports.svelte';
	import DataRetention from '$lib/components/compliance/DataRetention.svelte';
	import { LL } from '$i18n/i18n-svelte';

	const TABS = ['overview', 'reviews', 'reports', 'retention'] as const;
	type ComplianceTab = (typeof TABS)[number];

	let activeTab = $state<ComplianceTab>('overview');
	let status = $state<ComplianceStatus | null>(null);
	let statusLoading = $state(true);
	let statusError = $state(false);

	async function loadStatus() {
		statusLoading = true;
		statusError = false;
		try {
			status = await adminComplianceAPI.getStatus();
		} catch {
			// The status answers 503 when any fact behind it cannot be read.
			statusError = true;
		} finally {
			statusLoading = false;
		}
	}

	onMount(() => {
		void loadStatus();
	});

	const tabItems = $derived<AdminTabItem[]>([
		{ id: 'overview', label: $LL.admin_compliance_tab_overview() },
		{ id: 'reviews', label: $LL.admin_compliance_tab_reviews() },
		{ id: 'reports', label: $LL.admin_compliance_tab_reports() },
		{ id: 'retention', label: $LL.admin_compliance_tab_retention() }
	]);

	function changeTab(id: string) {
		if ((TABS as readonly string[]).includes(id)) activeTab = id as ComplianceTab;
	}
</script>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_compliance_title()}
		description={$LL.admin_compliance_description()}
	/>

	<AdminTabs items={tabItems} active={activeTab} onChange={changeTab} />

	{#if activeTab === 'overview'}
		{#if statusLoading}
			<div class="loading-state">{$LL.admin_compliance_loading()}</div>
		{:else if statusError || !status}
			<div class="alert alert-error" role="alert">
				{$LL.admin_compliance_unavailable()}
				<button class="btn btn-secondary btn-sm" onclick={loadStatus}>
					{$LL.admin_compliance_retry()}
				</button>
			</div>
		{:else}
			<ComplianceOverview {status} />
		{/if}
	{:else if activeTab === 'reviews'}
		<AccessReviews />
	{:else if activeTab === 'reports'}
		<ComplianceReports />
	{:else}
		<DataRetention />
	{/if}
</AdminPageShell>
