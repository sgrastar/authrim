<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import RoleAssignmentRules from '$lib/components/admin/RoleAssignmentRules.svelte';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
</script>

<svelte:head>
	<title>{$LL.admin_access_control_role_rules()} - Authrim</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_access_control_role_rules()}
		description={$LL.admin_access_control_role_rules_desc()}
	/>

	<AdminSection
		title={$LL.admin_access_control_role_rules()}
		description={$LL.admin_roles_rules_description()}
	>
		<RoleAssignmentRules showDescription={false} />
	</AdminSection>
</AdminPageShell>
