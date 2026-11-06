<script lang="ts">
	import { goto } from '$app/navigation';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpLoginUiThemes } from '#lib/api/login-ui-themes.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ThemeList from '#lib/pages/customization/ThemeList.svelte';

	const BASE = '/admin/customization/branding';
	const canWrite = $derived(
		hasPermission(adminAccess.current, 'admin:settings:write') ||
			hasPermission(adminAccess.current, 'admin:settings:login_ui:update')
	);
	const hrefOf = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
</script>

<svelte:head>
	<title>{t('nav.custom.branding')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<ThemeList client={httpLoginUiThemes} {canWrite} {hrefOf} onopen={(id) => goto(hrefOf(id))} />
{/key}
