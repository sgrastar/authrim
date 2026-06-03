<script lang="ts">
	import IdentityMappingPageShell from '$lib/components/identity-mapping/IdentityMappingPageShell.svelte';
</script>

<IdentityMappingPageShell
	pageTitle="Mapping Policy Editor"
	headTitle="Mapping Policy Editor"
	backHref="/admin/identity-mapping/mapping-policies"
	backLabel="Back to Mapping Policies"
	pageDescription="Edit inbound mappings and outbound release projections against registered source and destination profiles."
	editorAllowedViewModes={['inbound', 'outbound']}
	editorInitialViewMode="inbound"
	showEditorToolbarSourceProfile={false}
	showEditorToolbarModeToggle={false}
	showEditorMetrics={false}
	showProfileModeControl
	showPolicySaveControl
	primaryActionLabel="Save draft"
	primaryActionBusyLabel="Saving..."
/>
