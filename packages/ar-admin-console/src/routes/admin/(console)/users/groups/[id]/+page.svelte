<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { authzAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAdminUsers } from '#lib/api/admin-users.js';
	import { httpEndUserGroups } from '#lib/api/end-user-groups.js';
	import { httpEndUserRoles } from '#lib/api/end-user-roles.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import GroupPage from '#lib/pages/authz/GroupPage.svelte';

	const BASE = '/admin/users/groups';
	const id = $derived(page.params.id ?? '');
</script>

<svelte:head>
	<title>{t('nav.users.groups')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key `${tenantScope.tenantId}:${id}`}
		<GroupPage
			client={httpEndUserGroups(tenantScope.tenantId)}
			roles={httpEndUserRoles(tenantScope.tenantId)}
			users={httpAdminUsers}
			groupId={id}
			access={authzAccess(adminAccess.current)}
			listHref={BASE}
			groupHref={(groupId) => `${BASE}/${encodeURIComponent(groupId)}`}
			onopenuser={(userId) => void goto(`/admin/users/all/${encodeURIComponent(userId)}`)}
			onopenrole={(roleId) => void goto(`/admin/access/roles/${encodeURIComponent(roleId)}`)}
			ondeleted={() => void goto(BASE)}
		/>
	{/key}
{/if}
