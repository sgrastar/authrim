<script lang="ts">
	import { goto } from '$app/navigation';
	import { settingsLevel } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAccountPages } from '#lib/api/account-pages.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { parsePagesDocument } from '#lib/pages/customization/account-pages/account-page-model.js';
	import AccountPageList from '#lib/pages/customization/account-pages/AccountPageList.svelte';

	const BASE = '/admin/customization/account-page';
	// As the settings API decides it: the account pages are the tenant's Login UI settings.
	const canWrite = $derived(settingsLevel(adminAccess.current, 'login-ui', 'tenant') === 'edit');
	const client = httpAccountPages((raw) =>
		parsePagesDocument(raw, t('ap.preset.name'), Date.now())
	);
</script>

<svelte:head>
	<title>{t('nav.custom.accountPage')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<AccountPageList
		{client}
		{canWrite}
		onopen={(id) => void goto(`${BASE}/${encodeURIComponent(id)}`)}
	/>
{/key}
