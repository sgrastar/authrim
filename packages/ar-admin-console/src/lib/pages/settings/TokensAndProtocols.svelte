<script lang="ts">
	import type { AdminAccess } from '#lib/access/access.js';
	import type { SettingsClient } from '#lib/api/settings.js';
	import { TOKENS } from '#lib/settings/placement.js';
	import SettingsPage from '#lib/settings/SettingsPage.svelte';

	/**
	 * Applications → App defaults. A settings page: what it shows is its placement
	 * (`TOKENS`); loading, access, saving and notices are SettingsPage's.
	 */
	interface Props {
		client: SettingsClient;
		tenantId: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, tenantId, access }: Props = $props();
</script>

<SettingsPage page={TOKENS} {client} target={{ level: 'tenant', tenantId }} {access} />
