<script lang="ts">
	import { untrack } from 'svelte';
	import type {
		EndUserGroup,
		EndUserGroupDetail,
		EndUserGroupsClient
	} from '#lib/api/end-user-groups.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';

	/**
	 * Where a group sits: the groups above it, nearest first (their roles hold for its members
	 * too), and the groups directly below it (its roles hold for theirs). The parent is changed
	 * with "Edit".
	 */
	interface Props {
		client: Pick<EndUserGroupsClient, 'children'>;
		group: EndUserGroupDetail;
		groupHref: (groupId: string) => string;
	}

	let { client, group, groupHref }: Props = $props();

	/** Every child, all pages read; a list read only in part is not shown (failed). */
	let children = $state<EndUserGroup[] | null>(null);
	let failed = $state(false);

	async function load() {
		children = null;
		failed = false;
		try {
			children = (await client.children(group.id)).sort((a, b) =>
				a.display_name.localeCompare(b.display_name)
			);
		} catch {
			failed = true;
		}
	}

	$effect(() => {
		void group.id;
		untrack(() => void load());
	});
</script>

<Card title={t('grp.tree.parents')} description={t('grp.tree.parentsDesc')}>
	{#if group.parent_chain.length === 0}
		<p class="muted">{t('grp.tree.topLevel')}</p>
	{:else}
		<ol class="chain">
			{#each group.parent_chain as parent (parent.id)}
				<li>
					<Link href={groupHref(parent.id)}>{parent.display_name}</Link>
					<code>{parent.group_key}</code>
					{#if parent.lifecycle_state === 'inactive'}
						<Badge dot>{t('grp.state.inactive')}</Badge>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
</Card>

<Card title={t('grp.tree.children')} description={t('grp.tree.childrenDesc')}>
	{#if failed}
		<EmptyState icon="warningCircle" title={t('grp.tree.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else if children === null}
		<p class="muted">{t('common.loading')}</p>
	{:else if children.length === 0}
		<EmptyState icon="folder" title={t('grp.tree.noChildren')} />
	{:else}
		<ul class="chain">
			{#each children as child (child.id)}
				<li>
					<Link href={groupHref(child.id)}>{child.display_name}</Link>
					<code>{child.group_key}</code>
					{#if child.lifecycle_state === 'inactive'}
						<Badge dot>{t('grp.state.inactive')}</Badge>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</Card>

<style>
	.muted {
		margin: 0;
		color: var(--text-muted);
	}

	.chain {
		display: grid;
		gap: var(--space-related);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.chain li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-related);
	}

	code {
		color: var(--text-muted);
	}
</style>
