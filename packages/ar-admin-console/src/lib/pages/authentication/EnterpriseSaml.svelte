<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import type { AdminAccess } from '#lib/access/access.js';
	import type { SamlSettingsClient } from '#lib/api/saml-settings.js';
	import type { SettingsClient } from '#lib/api/settings.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { ENTERPRISE_SAML } from '#lib/settings/placement.js';
	import SettingsPage from '#lib/settings/SettingsPage.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import LeaveConfirm from '#lib/ui/save/LeaveConfirm.svelte';
	import { leaveDecision } from '#lib/ui/save/leave-guard.js';
	import Page from '#lib/ui/templates/Page.svelte';
	import SamlLocal from './saml-local/SamlLocal.svelte';

	/**
	 * Authentication → SAML. Two parts: the SAML settings of the tenant (a settings page: what it
	 * shows is its placement `ENTERPRISE_SAML`; loading, access, saving and notices are
	 * SettingsPage's), and below them the tenant's own SAML identity (`SamlLocal`): what partners
	 * register for the IdP and SP roles, the signing certificates and their rollover, the published
	 * entity IDs, and the signing-key DR bundle.
	 *
	 * Both parts can hold unsaved work (the settings draft, the publication choice), so this page
	 * owns the one leave guard for both: one question on the way out, whichever part is dirty.
	 */
	interface Props {
		client: SettingsClient;
		saml: SamlSettingsClient;
		tenantId: string;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
	}

	let { client, saml, tenantId, access }: Props = $props();

	let settingsDirty = $state(false);
	let localDirty = $state(false);
	const dirty = $derived(settingsDirty || localDirty);

	let leaveTo = $state<URL | null>(null);
	beforeNavigate((navigation) => {
		if (navigation.shallow && navigation.type === 'goto') return;
		const decision = leaveDecision(navigation, dirty);
		if (decision === 'allow') return;
		// Cancelling an unload makes the browser show its own "leave site?" dialog.
		navigation.cancel();
		if (decision === 'ask' && navigation.to) leaveTo = navigation.to.url;
	});

	let leaving = false;
	async function leave() {
		const target = leaveTo;
		leaveTo = null;
		if (!target) return;
		// The parts keep their drafts until the page is gone; the move itself is let through.
		leaving = true;
		settingsDirty = false;
		localDirty = false;
		try {
			await goto(target);
		} finally {
			leaving = false;
		}
	}
</script>

<Page>
	<PageHeader title={t('set.page.enterprise')} description={t('set.page.enterprise.desc')} />
	<SettingsPage
		page={ENTERPRISE_SAML}
		{client}
		target={{ level: 'tenant', tenantId }}
		{access}
		framed={false}
		guardNavigation={false}
		onstate={(state) => {
			if (!leaving) settingsDirty = state.dirty;
		}}
	/>
	{#key tenantId}
		<SamlLocal
			client={saml}
			{access}
			onstate={(state) => {
				if (!leaving) localDirty = state.dirty;
			}}
		/>
	{/key}
</Page>

<LeaveConfirm open={leaveTo !== null} onleave={leave} onstay={() => (leaveTo = null)} />
