<script lang="ts">
	import { goto } from '$app/navigation';
	import { teamAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAdminRoles } from '#lib/api/admin-roles.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import RoleListPage from '#lib/pages/team/RoleListPage.svelte';

	const BASE = '/admin/settings/team-roles';
</script>

<svelte:head>
	<title>{t('nav.set.teamRoles')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<RoleListPage
			client={httpAdminRoles(tenantScope.tenantId)}
			access={teamAccess(adminAccess.current)}
			newHref={`${BASE}/new`}
			onopen={(roleId) => void goto(`${BASE}/${encodeURIComponent(roleId)}`)}
		/>
	{/key}
{/if}
