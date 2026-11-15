<script lang="ts">
	import { page } from '$app/state';
	import { machineAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpMachineAccess } from '#lib/api/machine-access.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import MachineDetailPage from '#lib/pages/machine-access/MachineDetailPage.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';

	const BASE = '/admin/platform/admins/machine';
	const id = $derived(page.params.id ?? '');
	const access = $derived(machineAccess(adminAccess.current));
</script>

<svelte:head><title>{t('nav.pa.machine')} — {t('app.brand')}</title></svelte:head>

{#if !access.read}
	<EmptyState icon="lock" title={t('access.none.title')} />
{:else if tenantScope.tenantId}
	{#key `${tenantScope.tenantId}:${id}`}
		<MachineDetailPage
			client={httpMachineAccess(tenantScope.tenantId)}
			principalId={id}
			{access}
			tenants={tenantScope.tenants}
			listHref={BASE}
		/>
	{/key}
{/if}
