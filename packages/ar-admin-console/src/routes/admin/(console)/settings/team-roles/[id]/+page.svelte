<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { teamAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAdminRoles } from '#lib/api/admin-roles.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import RolePage from '#lib/pages/team/RolePage.svelte';

	const BASE = '/admin/settings/team-roles';
	const id = $derived(page.params.id ?? 'new');
</script>

<svelte:head>
	<title>{t('nav.set.teamRoles')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key `${tenantScope.tenantId}:${id}`}
		<RolePage
			client={httpAdminRoles(tenantScope.tenantId)}
			roleId={id}
			access={teamAccess(adminAccess.current)}
			who={adminAccess.current}
			listHref={BASE}
			oncreated={(roleId) =>
				void goto(`${BASE}/${encodeURIComponent(roleId)}`, { replaceState: true })}
			ondeleted={() => void goto(BASE)}
			onopenadmin={(adminId) => void goto(`/admin/settings/team/${encodeURIComponent(adminId)}`)}
		/>
	{/key}
{/if}
