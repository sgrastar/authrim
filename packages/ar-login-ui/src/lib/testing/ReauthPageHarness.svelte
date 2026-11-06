<script lang="ts">
	// The reauth route as the layout mounts it: with the Login UI stores in context.
	import ReauthPage from '../../routes/(main)/reauth/+page.svelte';
	import { initializeLoginUIStores } from '#lib/stores/login-ui-context.js';

	initializeLoginUIStores();
</script>

<ReauthPage />
