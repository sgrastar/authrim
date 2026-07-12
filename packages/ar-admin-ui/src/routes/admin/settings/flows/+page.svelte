<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import FlowAssignmentSettings from '$lib/components/admin/FlowAssignmentSettings.svelte';
</script>

<svelte:head>
	<title>{$LL.admin_flows_assignments_title()} - {$LL.admin_settings_page_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_flows_assignments_title()}
		description={$LL.admin_flows_description()}
	>
		{#snippet actions()}
			<a class="btn btn-secondary" href="/admin/settings">
				<i class="i-ph-arrow-left" aria-hidden="true"></i>
				{$LL.admin_flows_back_to_list()}
			</a>
			<a class="btn btn-secondary" href="/admin/flows">
				{$LL.admin_flows_title()}
			</a>
		{/snippet}
	</AdminPageHeader>

	<AdminSection
		title={$LL.admin_flows_assignment_target_tenant()}
		description={$LL.admin_flows_assignment_requires_published()}
	>
		<FlowAssignmentSettings targetType="tenant" />
	</AdminSection>
</AdminPageShell>
