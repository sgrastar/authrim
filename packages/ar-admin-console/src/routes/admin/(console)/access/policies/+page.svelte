<script lang="ts">
	import { goto } from '$app/navigation';
	import { authzAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAdminUsers } from '#lib/api/admin-users.js';
	import { httpEndUserGroups } from '#lib/api/end-user-groups.js';
	import { httpEndUserPolicies } from '#lib/api/end-user-policies.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import PolicyListPage from '#lib/pages/authz/PolicyListPage.svelte';

	const BASE = '/admin/access/policies';
</script>

<svelte:head>
	<title>{t('nav.access.policies')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<PolicyListPage
			client={httpEndUserPolicies(tenantScope.tenantId)}
			users={httpAdminUsers}
			groups={httpEndUserGroups(tenantScope.tenantId)}
			access={authzAccess(adminAccess.current)}
			newHref={`${BASE}/new`}
			onopen={(ruleId) => void goto(`${BASE}/${encodeURIComponent(ruleId)}`)}
		/>
	{/key}
{/if}
