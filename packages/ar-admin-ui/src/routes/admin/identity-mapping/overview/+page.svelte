<script lang="ts">
	import IdentityMappingPageShell from '$lib/components/identity-mapping/IdentityMappingPageShell.svelte';
</script>

<IdentityMappingPageShell
	pageTitle="Overview"
	headTitle="Identity Mapping Overview"
	pageDescription="Review inbound sources, canonical identity targets, and outbound projections without changing the graph."
	editorAllowedViewModes={['overview']}
	editorInitialViewMode="overview"
	editorEditable={false}
	showEditorToolbarSourceProfile={false}
	showEditorToolbarModeToggle={false}
	showEditorMetrics={false}
/>
