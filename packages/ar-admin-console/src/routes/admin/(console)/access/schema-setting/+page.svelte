<script lang="ts">
	import { httpSchemaSetting } from '$lib/api/schema-setting';
	import { httpSettings } from '$lib/api/settings';
	import { tenantScope } from '$lib/auth/tenant-scope.svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import SchemaSetting from '$lib/pages/schema-setting/SchemaSetting.svelte';
</script>

<svelte:head>
	<title>{t('ss.title')} — {t('app.brand')}</title>
</svelte:head>

{#if tenantScope.tenantId}
	{#key tenantScope.tenantId}
		<SchemaSetting
			client={httpSchemaSetting}
			settings={httpSettings}
			tenantId={tenantScope.tenantId}
		/>
	{/key}
{/if}
