<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { readAppliedThemeValues } from '#lib/api/login-ui-themes.js';
	import { httpScreens } from '#lib/api/screens.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ScreenEditorPage from '#lib/pages/customization/screens/ScreenEditorPage.svelte';
	import { useSchemaChoices } from '#lib/pages/customization/screens/schema-choices.svelte.js';

	const BASE = '/admin/customization/screens';
	const id = $derived(page.params.id ?? 'new');
	const canWrite = $derived(hasPermission(adminAccess.current, 'admin:settings:write'));
	const canReadResponses = $derived(hasPermission(adminAccess.current, 'admin:users:read'));
	const schema = useSchemaChoices(() => tenantScope.tenantId);
	const hrefOf = (screenId: string) => `${BASE}/${encodeURIComponent(screenId)}`;
	// Unsaved changes are asked about by the page's SaveScope.
	const created = (screenId: string) => void goto(hrefOf(screenId), { replaceState: true });
</script>

<svelte:head>
	<title>{t('nav.custom.screens')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<ScreenEditorPage
		client={httpScreens}
		{id}
		{canWrite}
		{canReadResponses}
		loadTheme={(signal) => readAppliedThemeValues(tenantScope.tenantId, signal)}
		schemaFields={schema.fields}
		choices={schema.choices}
		requiredAtSignUp={schema.requiredAtSignUp}
		schemaHref="/admin/access/schema-setting"
		listHref={BASE}
		oncreated={created}
		onopen={(screenId) => goto(hrefOf(screenId))}
		ondeleted={() => void goto(BASE)}
	/>
{/key}
