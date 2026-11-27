<script lang="ts">
	import { goto } from '$app/navigation';
	import { authzAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpEndUserRoles } from '#lib/api/end-user-roles.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EndUserRoleListPage from '#lib/pages/authz/EndUserRoleListPage.svelte';

	const BASE = '/admin/access/roles';
</script>

<svelte:head>
	<title>{t('nav.access.roles')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<EndUserRoleListPage
			client={httpEndUserRoles(tenantScope.tenantId)}
			access={authzAccess(adminAccess.current)}
			newHref={`${BASE}/new`}
			onopen={(roleId) => void goto(`${BASE}/${encodeURIComponent(roleId)}`)}
		/>
	{/key}
{/if}
