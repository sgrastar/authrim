<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { authzAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpEndUserRoles } from '#lib/api/end-user-roles.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EndUserRolePage from '#lib/pages/authz/EndUserRolePage.svelte';

	const BASE = '/admin/access/roles';
	const id = $derived(page.params.id ?? 'new');
</script>

<svelte:head>
	<title>{t('nav.access.roles')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key `${tenantScope.tenantId}:${id}`}
		<EndUserRolePage
			client={httpEndUserRoles(tenantScope.tenantId)}
			roleId={id}
			access={authzAccess(adminAccess.current)}
			listHref={BASE}
			oncreated={(roleId) =>
				void goto(`${BASE}/${encodeURIComponent(roleId)}`, { replaceState: true })}
			ondeleted={() => void goto(BASE)}
			onopenuser={(userId) => void goto(`/admin/users/all/${encodeURIComponent(userId)}`)}
			onopengroup={(groupId) => void goto(`/admin/users/groups/${encodeURIComponent(groupId)}`)}
		/>
	{/key}
{/if}
