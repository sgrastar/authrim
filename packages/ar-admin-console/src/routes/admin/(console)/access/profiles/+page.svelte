<script lang="ts">
	import { httpDestinationProfiles } from '#lib/api/destination-profiles.js';
	import { httpSourceProfiles } from '#lib/api/source-profiles.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { hasPermission } from '#lib/access/access.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import ProfilesPage from '#lib/pages/profiles/ProfilesPage.svelte';
</script>

<svelte:head>
	<title>{t('pf.title')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#if hasPermission(adminAccess.current, 'admin:settings:read')}
		{#key tenantScope.tenantId}
			<ProfilesPage
				tenantId={tenantScope.tenantId}
				destinations={httpDestinationProfiles}
				sources={httpSourceProfiles}
				canWrite={hasPermission(adminAccess.current, 'admin:settings:write')}
			/>
		{/key}
	{:else}
		<Callout tone="warning">{t('pf.loadFailed')}</Callout>
	{/if}
{/if}
