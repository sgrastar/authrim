<script lang="ts">
	import { goto } from '$app/navigation';
	import { authzAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpEndUserGroups } from '#lib/api/end-user-groups.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import GroupListPage from '#lib/pages/authz/GroupListPage.svelte';

	const BASE = '/admin/users/groups';
</script>

<svelte:head>
	<title>{t('nav.users.groups')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<GroupListPage
			client={httpEndUserGroups(tenantScope.tenantId)}
			access={authzAccess(adminAccess.current)}
			onopen={(groupId) => void goto(`${BASE}/${encodeURIComponent(groupId)}`)}
		/>
	{/key}
{/if}
