<script lang="ts">
	import { ipAllowlistAccess } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpIpAllowlist } from '#lib/api/admin-ip-allowlist.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import IpAllowlistPage from '#lib/pages/team/IpAllowlistPage.svelte';
</script>

<svelte:head>
	<title>{t('nav.set.teamIpAllowlist')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<IpAllowlistPage
			client={httpIpAllowlist(tenantScope.tenantId)}
			access={ipAllowlistAccess(adminAccess.current)}
		/>
	{/key}
{/if}
