<script lang="ts">
	import { goto } from '$app/navigation';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpScreens } from '#lib/api/screens.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ScreenList from '#lib/pages/customization/screens/ScreenList.svelte';

	const BASE = '/admin/customization/screens';
	const canWrite = $derived(hasPermission(adminAccess.current, 'admin:settings:write'));
	const hrefOf = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
</script>

<svelte:head>
	<title>{t('nav.custom.screens')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<ScreenList client={httpScreens} {canWrite} {hrefOf} onopen={(id) => goto(hrefOf(id))} />
{/key}
