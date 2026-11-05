<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Themes from '#lib/pages/customization/Themes.svelte';
</script>

<svelte:head>
	<title>{t('nav.custom.branding')} — {t('app.brand')}</title>
</svelte:head>

<Themes />
