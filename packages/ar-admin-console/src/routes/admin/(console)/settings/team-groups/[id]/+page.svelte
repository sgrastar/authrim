<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { teamAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAdminGroups } from '#lib/api/admin-groups.js';
	import { httpAdminTeam } from '#lib/api/admin-team.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import GroupDetailPage from '#lib/pages/team/GroupDetailPage.svelte';

	const BASE = '/admin/settings/team-groups';
	const id = $derived(page.params.id ?? '');
</script>

<svelte:head>
	<title>{t('nav.set.teamGroups')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key `${tenantScope.tenantId}:${id}`}
		<GroupDetailPage
			groups={httpAdminGroups(tenantScope.tenantId)}
			team={httpAdminTeam(tenantScope.tenantId)}
			groupId={id}
			access={teamAccess(adminAccess.current)}
			listHref={BASE}
			onopenadmin={(adminId) => void goto(`/admin/settings/team/${encodeURIComponent(adminId)}`)}
			ondeleted={() => void goto(BASE)}
		/>
	{/key}
{/if}
