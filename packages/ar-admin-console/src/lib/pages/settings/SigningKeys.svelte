<script lang="ts">
	import type { AdminAccess } from '$lib/access/access';
	import type { SettingsClient } from '$lib/api/settings';
	import { SIGNING_KEYS } from '$lib/settings/placement';
	import SettingsPage from '$lib/settings/SettingsPage.svelte';

	/**
	 * Settings → Signing keys. A settings page: what it shows is its placement (`SIGNING_KEYS`);
	 * loading, access, saving and notices are SettingsPage's.
	 */
	interface Props {
		client: SettingsClient;
		tenantId: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, tenantId, access }: Props = $props();
</script>

<SettingsPage page={SIGNING_KEYS} {client} target={{ level: 'tenant', tenantId }} {access} />
