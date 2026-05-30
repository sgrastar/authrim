<script lang="ts">
	import IdentityMappingPageShell from '$lib/components/identity-mapping/IdentityMappingPageShell.svelte';
</script>

<IdentityMappingPageShell
	pageTitle="Edit"
	headTitle="Identity Mapping Edit"
	pageDescription="Edit inbound mappings and outbound release projections against registered source and destination profiles."
	editorAllowedViewModes={['inbound', 'outbound']}
	editorInitialViewMode="inbound"
	showEditorToolbarSourceProfile={false}
	showEditorToolbarModeToggle={false}
	showEditorMetrics={false}
	showProfileModeControl
/>
