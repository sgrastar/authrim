<script lang="ts">
	import { goto } from '$app/navigation';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAuthenticationMethodProfiles } from '#lib/api/authentication-method-profiles.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AuthenticationMethodProfileList from '#lib/pages/authentication/AuthenticationMethodProfileList.svelte';

	const BASE = '/admin/authentication/methods';
	const canWrite = $derived(hasPermission(adminAccess.current, 'admin:settings:write'));
	const hrefOf = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
</script>

<svelte:head><title>{t('am.list.title')} — {t('app.brand')}</title></svelte:head>

{#key tenantScope.tenantId}
	<AuthenticationMethodProfileList
		client={httpAuthenticationMethodProfiles}
		{canWrite}
		{hrefOf}
		onopen={(id) => goto(hrefOf(id))}
	/>
{/key}
