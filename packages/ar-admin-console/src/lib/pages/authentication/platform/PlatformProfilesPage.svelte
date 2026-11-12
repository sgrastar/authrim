<script lang="ts">
	import type { AdminAccess } from '#lib/access/access.js';
	import type { PlatformProfileKind, PlatformProfilesClient } from '#lib/api/platform-profiles.js';
	import type { SettingsClient } from '#lib/api/settings.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SettingsPage from '#lib/settings/SettingsPage.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Tabs from '#lib/ui/patterns/Tabs.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import PlatformProfileList from './PlatformProfileList.svelte';
	import { PLATFORM_DEFAULT_PAGES } from './platform-default-pages';

	/**
	 * Platform → Authentication → method or session profiles: the platform's named profiles, and
	 * (second tab) its Default under every tenant's with the switches that say what tenants may do.
	 */
	interface Props {
		kind: PlatformProfileKind;
		profiles: PlatformProfilesClient;
		settings: SettingsClient;
		canWrite: boolean;
		hrefOf: (id: string) => string;
		onopen: (id: string) => void;
		/** Who is looking; the signed-in admin unless given (Storybook). */
		access?: AdminAccess;
		/** The tab shown first (`profiles` or `default`). */
		tab?: string;
	}
	let {
		kind,
		profiles,
		settings,
		canWrite,
		hrefOf,
		onopen,
		access,
		tab = $bindable('profiles')
	}: Props = $props();
	let dirty = $state(false);
	let saving = $state(false);
	const tabs = $derived([
		{ id: 'profiles', label: t('pp.tab.profiles') },
		{ id: 'default', label: t('pp.tab.default') }
	]);
</script>

<Page>
	<PageHeader title={t(`pp.title.${kind}`)} description={t(`pp.desc.${kind}`)}>
		{#snippet badges()}<Badge tone="info">{t('pl.platform')}</Badge>{/snippet}
	</PageHeader>
	<Tabs
		label={t(`pp.title.${kind}`)}
		items={tabs}
		bind:value={tab}
		disabled={saving}
		onbeforechange={() => !dirty}
	>
		{#snippet panel(id)}
			{#if id === 'profiles'}
				<PlatformProfileList client={profiles} {canWrite} {hrefOf} {onopen} />
			{:else}
				<SettingsPage
					page={PLATFORM_DEFAULT_PAGES[kind]}
					client={settings}
					target={{ level: 'platform' }}
					{access}
					framed={false}
					onstate={(state) => ({ dirty, saving } = state)}
				/>
			{/if}
		{/snippet}
	</Tabs>
</Page>
