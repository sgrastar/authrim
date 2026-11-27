<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { authzAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpEndUserGroups } from '#lib/api/end-user-groups.js';
	import { httpEndUserPolicies } from '#lib/api/end-user-policies.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import PolicyPage from '#lib/pages/authz/PolicyPage.svelte';

	const BASE = '/admin/access/policies';
	const id = $derived(page.params.id ?? 'new');
</script>

<svelte:head>
	<title>{t('nav.access.policies')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key `${tenantScope.tenantId}:${id}`}
		<PolicyPage
			client={httpEndUserPolicies(tenantScope.tenantId)}
			groups={httpEndUserGroups(tenantScope.tenantId)}
			ruleId={id}
			access={authzAccess(adminAccess.current)}
			listHref={BASE}
			oncreated={(ruleId) =>
				void goto(`${BASE}/${encodeURIComponent(ruleId)}`, { replaceState: true })}
			ondeleted={() => void goto(BASE)}
		/>
	{/key}
{/if}
