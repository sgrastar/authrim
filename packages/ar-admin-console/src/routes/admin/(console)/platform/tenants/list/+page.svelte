<script lang="ts">
	import { goto } from '$app/navigation';
	import { tenantsAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpTenants } from '#lib/api/tenants.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import TenantListPage from '#lib/pages/tenants/TenantListPage.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';

	const BASE = '/admin/platform/tenants/list';
	const access = $derived(tenantsAccess(adminAccess.current));
	const client = httpTenants();
</script>

<svelte:head><title>{t('nav.pt.list')} — {t('app.brand')}</title></svelte:head>

{#if !access.read}
	<EmptyState icon="lock" title={t('access.none.title')} />
{:else}
	<TenantListPage
		{client}
		{access}
		onopen={(id) => void goto(`${BASE}/${encodeURIComponent(id)}`)}
		onchanged={() => void tenantScope.reload()}
	/>
{/if}
