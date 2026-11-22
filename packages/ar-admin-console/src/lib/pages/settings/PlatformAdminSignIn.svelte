<script lang="ts">
	import type { AdminAccess } from '#lib/access/access.js';
	import type { SettingsClient } from '#lib/api/settings.js';
	import { PLATFORM_ADMIN_SIGN_IN } from '#lib/settings/platform-admin-sign-in.js';
	import SettingsPage from '#lib/settings/SettingsPage.svelte';

	/**
	 * Platform → Administrators → Sign-in: which kinds of second factor satisfy L2 for every
	 * tenant that sets no list of its own. A settings page read and saved at the platform scope;
	 * saving a change the API guards with step-up asks for it through the settings client.
	 */
	interface Props {
		client: SettingsClient;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, access }: Props = $props();
</script>

<SettingsPage page={PLATFORM_ADMIN_SIGN_IN} {client} target={{ level: 'platform' }} {access} />
