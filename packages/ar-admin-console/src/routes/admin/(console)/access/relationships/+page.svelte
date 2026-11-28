<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { authzAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAdminUsers } from '#lib/api/admin-users.js';
	import { httpEndUserGroups } from '#lib/api/end-user-groups.js';
	import { httpEndUserRebac } from '#lib/api/end-user-rebac.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import RelationshipsPage from '#lib/pages/authz/RelationshipsPage.svelte';
	import { RELATIONSHIP_TABS, type RelationshipsTab } from '#lib/pages/authz/rebac-model.js';

	const BASE = '/admin/access/relationships';
	const asked = page.url.searchParams.get('tab');
	const tab: RelationshipsTab = RELATIONSHIP_TABS.find((entry) => entry === asked) ?? 'tuples';
</script>

<svelte:head>
	<title>{t('nav.access.relationships')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<RelationshipsPage
			client={httpEndUserRebac(tenantScope.tenantId)}
			users={httpAdminUsers}
			groups={httpEndUserGroups(tenantScope.tenantId)}
			access={authzAccess(adminAccess.current)}
			{tab}
			ontabchange={(next) => void goto(`${BASE}?tab=${next}`, { replaceState: true })}
			newDefinitionHref={`${BASE}/definitions/new`}
			onopendefinition={(id) => void goto(`${BASE}/definitions/${encodeURIComponent(id)}`)}
		/>
	{/key}
{/if}
