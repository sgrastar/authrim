<script lang="ts">
	import { page } from '$app/state';
	import { t } from '$lib/i18n/i18n.svelte';
	import PlaceholderPage from '$lib/shell/PlaceholderPage.svelte';

	let { data } = $props();
</script>

<svelte:head>
	<title>{t(data.location.item?.label ?? data.location.area.label)} — {t('app.brand')}</title>
</svelte:head>

{#key page.url.pathname}
	<PlaceholderPage location={data.location} />
{/key}
