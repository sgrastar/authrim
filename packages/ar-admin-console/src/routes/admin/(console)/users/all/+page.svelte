<script lang="ts">
	import { goto } from '$app/navigation';
	import { httpAdminUsers } from '#lib/api/admin-users.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import UserList from '#lib/pages/users/UserList.svelte';
</script>

<svelte:head>
	<title>{t('nav.users.all')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<UserList
			client={httpAdminUsers}
			onopen={(userId) => void goto(`/admin/users/all/${encodeURIComponent(userId)}`)}
		/>
	{/key}
{/if}
