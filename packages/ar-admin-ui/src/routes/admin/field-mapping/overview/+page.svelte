<script lang="ts">
	import IdentityMappingPageShell from '$lib/components/identity-mapping/IdentityMappingPageShell.svelte';
	import { LL } from '$i18n/i18n-svelte';
</script>

<IdentityMappingPageShell
	pageTitle={$LL.admin_identity_mapping_overview_title()}
	headTitle={$LL.admin_identity_mapping_overview_head_title()}
	pageDescription={$LL.admin_identity_mapping_description()}
	editorAllowedViewModes={['overview']}
	editorInitialViewMode="overview"
	editorEditable={false}
	showEditorToolbarSourceProfile={false}
	showEditorToolbarModeToggle={false}
	showEditorMetrics={false}
	laneSelectorMode="policy"
	showGraphPolicyDraftLabel={false}
	showCompileDraftButton={false}
/>
