<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { authzAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpEndUserRebac } from '#lib/api/end-user-rebac.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import RelationDefinitionPage from '#lib/pages/authz/RelationDefinitionPage.svelte';

	const BASE = '/admin/access/relationships';
	const LIST = `${BASE}?tab=definitions`;
	const id = $derived(page.params.id ?? 'new');
</script>

<svelte:head>
	<title>{t('nav.access.relationships')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key `${tenantScope.tenantId}:${id}`}
		<RelationDefinitionPage
			client={httpEndUserRebac(tenantScope.tenantId)}
			definitionId={id}
			access={authzAccess(adminAccess.current)}
			listHref={LIST}
			oncreated={(definitionId) =>
				void goto(`${BASE}/definitions/${encodeURIComponent(definitionId)}`, {
					replaceState: true
				})}
			ondeleted={() => void goto(LIST)}
		/>
	{/key}
{/if}
