<script lang="ts">
	import type { AdminAccess } from '$lib/access/access';
	import type { SettingsClient } from '$lib/api/settings';
	import { STAYING_SIGNED_IN } from '$lib/settings/placement';
	import SettingsPage from '$lib/settings/SettingsPage.svelte';

	/**
	 * Authentication → Staying signed in. A settings page: what it shows and how deep is its
	 * placement (`STAYING_SIGNED_IN`); loading, access and saving are SettingsPage's.
	 */
	interface Props {
		client: SettingsClient;
		tenantId: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, tenantId, access }: Props = $props();
</script>

<SettingsPage page={STAYING_SIGNED_IN} {client} target={{ level: 'tenant', tenantId }} {access} />
