<script lang="ts">
	import type { AdminAccess } from '#lib/access/access.js';
	import type { SettingsClient } from '#lib/api/settings.js';
	import { TEAM } from '#lib/settings/placement.js';
	import SettingsPage from '#lib/settings/SettingsPage.svelte';

	/**
	 * Settings → Administrators → Sign-in settings: how admins sign in to this console. A settings page: what it
	 * shows is its placement (`TEAM`); the platform part (`level: 'platform'`) is read and saved
	 * for the whole deployment and shown only to platform admins. Saving a change the API guards
	 * with step-up (relaxing the step-up policy) asks for it through the settings client.
	 */
	interface Props {
		client: SettingsClient;
		tenantId: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
		/** Off inside the team page's "Sign-in settings" tab, which has the page's header. */
		framed?: boolean;
		/** Unsaved changes and a running save, for the team page's tabs. */
		onstate?: (state: { dirty: boolean; saving: boolean }) => void;
	}

	let { client, tenantId, access, framed = true, onstate }: Props = $props();
</script>

<SettingsPage
	page={TEAM}
	{client}
	target={{ level: 'tenant', tenantId }}
	{access}
	{framed}
	{onstate}
/>
