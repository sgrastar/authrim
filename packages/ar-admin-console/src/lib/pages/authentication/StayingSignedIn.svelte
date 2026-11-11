<script lang="ts">
	import type { AdminAccess } from '#lib/access/access.js';
	import type { SettingsClient } from '#lib/api/settings.js';
	import { SESSION_PROFILES } from '#lib/settings/placement.js';
	import SettingsPage from '#lib/settings/SettingsPage.svelte';

	/**
	 * Authentication → Staying signed in. A settings page: what it shows and how deep is its
	 * placement (`SESSION_PROFILES`); loading, access and saving are SettingsPage's.
	 */
	interface Props {
		client: SettingsClient;
		tenantId: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, tenantId, access }: Props = $props();
</script>

<SettingsPage page={SESSION_PROFILES} {client} target={{ level: 'tenant', tenantId }} {access} />
