<script lang="ts">
	import type { AdminAccess } from '$lib/access/access';
	import type { SettingsClient } from '$lib/api/settings';
	import { APP_DEFAULTS } from '$lib/settings/placement';
	import SettingsPage from '$lib/settings/SettingsPage.svelte';

	/**
	 * Applications → App defaults. A settings page: what it shows is its placement
	 * (`APP_DEFAULTS`); loading, access, saving and notices are SettingsPage's.
	 */
	interface Props {
		client: SettingsClient;
		tenantId: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, tenantId, access }: Props = $props();
</script>

<SettingsPage page={APP_DEFAULTS} {client} target={{ level: 'tenant', tenantId }} {access} />
