<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { httpUserAudit } from '#lib/api/user-audit.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import UserAuditLog from '#lib/pages/monitoring/UserAuditLog.svelte';

	// A user's page links here with ?user=<id>; read once, the filters belong to the page after.
	const initialUserId = page.url.searchParams.get('user') ?? '';
</script>

<svelte:head>
	<title>{t('nav.mon.audit')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<UserAuditLog
			client={httpUserAudit}
			{initialUserId}
			onopenuser={(id) => void goto(`/admin/users/all/${encodeURIComponent(id)}`)}
		/>
	{/key}
{/if}
