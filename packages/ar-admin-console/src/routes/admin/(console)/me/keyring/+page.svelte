<script lang="ts">
	import { httpWalletCredentials } from '#lib/api/wallet-credentials.js';
	import Keyring from '#lib/pages/keyring/Keyring.svelte';
</script>

<Keyring client={httpWalletCredentials} />
