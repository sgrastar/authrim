<script lang="ts">
	import { getLocale, LL } from '$i18n/i18n-svelte';
	import { useLoginUIStores } from '$lib/stores/login-ui-context';

	const { loginUIPageStore } = useLoginUIStores();
	const tagline = $derived(loginUIPageStore.getLocalizedText(getLocale(), 'tagline') ?? $LL.app_subtitle());
</script>

{tagline}
