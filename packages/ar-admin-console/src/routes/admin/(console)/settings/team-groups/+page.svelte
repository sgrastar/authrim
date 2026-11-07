<script lang="ts">
	import { goto } from '$app/navigation';
	import { teamAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAdminGroups } from '#lib/api/admin-groups.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import GroupListPage from '#lib/pages/team/GroupListPage.svelte';
</script>

<svelte:head>
	<title>{t('nav.set.teamGroups')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<GroupListPage
			client={httpAdminGroups(tenantScope.tenantId)}
			access={teamAccess(adminAccess.current)}
			onopen={(groupId) => void goto(`/admin/settings/team-groups/${encodeURIComponent(groupId)}`)}
		/>
	{/key}
{/if}
