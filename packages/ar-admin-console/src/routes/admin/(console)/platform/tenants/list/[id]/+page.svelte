<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tenantsAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpTenantDomains } from '#lib/api/tenant-domains.js';
	import { httpTenants } from '#lib/api/tenants.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import TenantDetailPage from '#lib/pages/tenants/TenantDetailPage.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';

	const BASE = '/admin/platform/tenants/list';
	const id = $derived(page.params.id ?? '');
	const access = $derived(tenantsAccess(adminAccess.current));
	const client = httpTenants();
	const domains = httpTenantDomains();
</script>

<svelte:head><title>{t('nav.pt.list')} — {t('app.brand')}</title></svelte:head>

{#if !access.read}
	<EmptyState icon="lock" title={t('access.none.title')} />
{:else}
	{#key id}
		<TenantDetailPage
			{client}
			{domains}
			tenantId={id}
			{access}
			listHref={BASE}
			onopen={(next) => void goto(`${BASE}/${encodeURIComponent(next)}`)}
			ondeleted={() => void goto(BASE)}
			onchanged={() => void tenantScope.reload()}
		/>
	{/key}
{/if}
