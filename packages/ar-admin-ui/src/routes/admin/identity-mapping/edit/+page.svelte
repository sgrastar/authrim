<script lang="ts">
	import IdentityMappingPageShell from '$lib/components/identity-mapping/IdentityMappingPageShell.svelte';
	import { LL } from '$i18n/i18n-svelte';
</script>

<IdentityMappingPageShell
	pageTitle={$LL.admin_identity_mapping_editor_title()}
	headTitle={$LL.admin_identity_mapping_editor_title()}
	backHref="/admin/identity-mapping/mapping-policies"
	backLabel={$LL.admin_identity_mapping_back_to_policies()}
	pageDescription={$LL.admin_identity_mapping_editor_description()}
	editorAllowedViewModes={['source', 'destination']}
	editorInitialViewMode="source"
	showEditorToolbarSourceProfile={false}
	showEditorToolbarModeToggle={false}
	showEditorMetrics={false}
	showProfileModeControl
	showPolicySaveControl
	primaryActionLabel={$LL.admin_identity_mapping_editor_save_draft()}
	primaryActionBusyLabel={$LL.admin_identity_mapping_editor_saving()}
/>
