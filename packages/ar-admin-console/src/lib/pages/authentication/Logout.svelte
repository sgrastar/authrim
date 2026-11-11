<script lang="ts">
	import type { AdminAccess } from '#lib/access/access.js';
	import type { SettingsClient } from '#lib/api/settings.js';
	import { LOGOUT } from '#lib/settings/placement.js';
	import SettingsPage from '#lib/settings/SettingsPage.svelte';

	/**
	 * Authentication → Logout. A settings page: what it shows and how deep is its placement
	 * (`LOGOUT`); loading, access and saving are SettingsPage's.
	 */
	interface Props {
		client: SettingsClient;
		tenantId: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, tenantId, access }: Props = $props();
</script>

<SettingsPage page={LOGOUT} {client} target={{ level: 'tenant', tenantId }} {access} />
