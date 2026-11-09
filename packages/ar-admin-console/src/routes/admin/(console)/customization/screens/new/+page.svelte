<script lang="ts">
	import { goto } from '$app/navigation';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { readAppliedThemeValues } from '#lib/api/login-ui-themes.js';
	import { httpScreens } from '#lib/api/screens.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ScreenCreatePage from '#lib/pages/customization/screens/ScreenCreatePage.svelte';

	const BASE = '/admin/customization/screens';
	const canWrite = $derived(hasPermission(adminAccess.current, 'admin:settings:write'));
</script>

<svelte:head>
	<title>{t('sc.list.create')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<ScreenCreatePage
		client={httpScreens}
		{canWrite}
		loadTheme={(signal) => readAppliedThemeValues(tenantScope.tenantId, signal)}
		oncancel={() => goto(BASE)}
		oncreated={(id) => goto(`${BASE}/${encodeURIComponent(id)}`, { replace: true })}
	/>
{/key}
