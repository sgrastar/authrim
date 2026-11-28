<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthzAccess } from '#lib/access/access.js';
	import type { AdminUsersClient } from '#lib/api/admin-users.js';
	import type { EndUserGroupsClient } from '#lib/api/end-user-groups.js';
	import type { EndUserRebacClient } from '#lib/api/end-user-rebac.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import Tabs from '#lib/ui/patterns/Tabs.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import RebacCheckPanel from './RebacCheckPanel.svelte';
	import RebacDefinitionsTab from './RebacDefinitionsTab.svelte';
	import RebacTuplesTab from './RebacTuplesTab.svelte';
	import type { RelationshipsTab } from './rebac-model';

	/**
	 * Access → Relationships: who has which relation on which object, and how a relation is
	 * computed. Three areas: tuples (the facts), definitions (the rules that combine them) and a
	 * check that asks the engine one question. Relationships only count while “Relationships” is on
	 * in Settings → Authorization. Reading needs `admin:roles:read`; changing and checking
	 * `admin:roles:write` and a tenant administrator.
	 */
	interface Props {
		client: EndUserRebacClient;
		users: Pick<AdminUsersClient, 'list'>;
		groups: Pick<EndUserGroupsClient, 'list'>;
		access: AuthzAccess;
		newDefinitionHref: string;
		onopendefinition: (definitionId: string) => void;
		/** The area shown first (the page remembers it in its address). */
		tab?: RelationshipsTab;
		ontabchange?: (tab: RelationshipsTab) => void;
	}

	let {
		client,
		users,
		groups,
		access,
		newDefinitionHref,
		onopendefinition,
		tab = 'tuples',
		ontabchange
	}: Props = $props();

	let current = $state<string>(untrack(() => tab));
	let objectTypes = $state<string[]>([]);

	$effect(() => {
		untrack(() => {
			client
				.objectTypes()
				.then((found) => (objectTypes = found.map((entry) => entry.name)))
				// Without the list the fields are typed in.
				.catch(() => (objectTypes = []));
		});
	});

	const tabs = $derived([
		{ id: 'tuples', label: t('rb.tab.tuples') },
		{ id: 'definitions', label: t('rb.tab.definitions') },
		{ id: 'check', label: t('rb.tab.check') }
	]);
</script>

<Page>
	<PageHeader title={t('nav.access.relationships')} description={t('rb.page.desc')} />

	{#if !access.rebacRead}
		<EmptyState icon="lock" title={t('rb.noAccess')} />
	{:else}
		<Callout icon="info">{t('rb.scope.note')}</Callout>
		{#if !access.rebacWrite}
			<Callout icon="lock">{t('rb.readOnly')}</Callout>
		{/if}

		<Tabs
			label={t('nav.access.relationships')}
			items={tabs}
			bind:value={current}
			onchange={(id) => ontabchange?.(id as RelationshipsTab)}
		>
			{#snippet panel(id)}
				<div class="panel">
					{#if id === 'tuples'}
						<RebacTuplesTab {client} {users} {groups} {access} {objectTypes} />
					{:else if id === 'definitions'}
						<RebacDefinitionsTab
							{client}
							{access}
							{objectTypes}
							newHref={newDefinitionHref}
							onopen={onopendefinition}
						/>
					{:else}
						<RebacCheckPanel {client} {users} {access} {objectTypes} />
					{/if}
				</div>
			{/snippet}
		</Tabs>
	{/if}
</Page>

<style>
	.panel {
		display: grid;
		gap: var(--space-related);
		padding-top: var(--space-related);
	}
</style>
