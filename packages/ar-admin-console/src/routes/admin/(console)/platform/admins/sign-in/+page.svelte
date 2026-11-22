<script lang="ts">
	import { httpSettings } from '#lib/api/settings.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import PlatformAdminSignIn from '#lib/pages/settings/PlatformAdminSignIn.svelte';
</script>

<svelte:head><title>{t('nav.pa.signIn')} — {t('app.brand')}</title></svelte:head>

<PlatformAdminSignIn client={httpSettings} />
