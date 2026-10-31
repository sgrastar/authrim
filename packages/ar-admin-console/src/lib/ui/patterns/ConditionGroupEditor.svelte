<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';
	import IconButton from '../primitives/IconButton.svelte';
	import SelectMenu from '../primitives/SelectMenu.svelte';
	import ConditionGroupEditor from './ConditionGroupEditor.svelte';
	import ConditionRuleEditor from './ConditionRuleEditor.svelte';
	import {
		newGroup,
		newRule,
		type ConditionField,
		type ConditionGroup,
		type ConditionNode,
		type RuleProblem
	} from './condition-model';

	/**
	 * A group of a ConditionBuilder. One sentence at its top says how its members combine
	 * ("Match [all ▾] of these"); the members follow, the words "and" / "or" between them as a
	 * quiet reminder rather than controls. Adding is two quiet actions at the bottom. A nested
	 * group sits in its own frame, indented, so the structure reads at a glance.
	 */
	interface Props {
		group: ConditionGroup;
		fields: readonly ConditionField[];
		depth: number;
		maxDepth: number;
		problems: ReadonlyMap<string, RuleProblem>;
		/** Id of the member just added, whose field list opens by itself. */
		fresh?: string | null;
		onchange: (group: ConditionGroup, added?: string) => void;
		/** Nested groups can be removed; the outermost cannot. */
		onremove?: () => void;
	}

	let {
		group,
		fields,
		depth,
		maxDepth,
		problems,
		fresh = null,
		onchange,
		onremove
	}: Props = $props();

	const busy = useBusy();
	const joiner = $derived(group.match === 'all' ? t('cond.and') : t('cond.or'));
	const after = $derived(t('cond.head.after'));

	function replace(index: number, node: ConditionNode, added?: string) {
		onchange({ ...group, children: group.children.map((c, i) => (i === index ? node : c)) }, added);
	}

	function remove(index: number) {
		onchange({ ...group, children: group.children.filter((_, i) => i !== index) });
	}

	function addRule() {
		const rule = newRule(fields);
		onchange({ ...group, children: [...group.children, rule] }, rule.id);
	}

	function addGroup() {
		const nested = newGroup(fields, group.match === 'all' ? 'any' : 'all');
		onchange({ ...group, children: [...group.children, nested] }, nested.children[0].id);
	}
</script>

<div
	class="cgroup"
	class:is-nested={depth > 1}
	role="group"
	aria-label={t('cond.group', { n: depth })}
>
	<div class="cgroup__head">
		<span>{t('cond.head.before')}</span>
		<SelectMenu
			label={t('cond.match')}
			hideLabel
			variant="inline"
			value={group.match}
			options={[
				{ value: 'all', label: t('cond.match.all') },
				{ value: 'any', label: t('cond.match.any') },
				{ value: 'none', label: t('cond.match.none') }
			]}
			onchange={(match) => onchange({ ...group, match: match as ConditionGroup['match'] })}
		/>
		{#if after}<span>{after}</span>{/if}
		{#if onremove}
			<span class="cgroup__remove">
				<IconButton
					icon="trash"
					label={t('cond.removeGroup')}
					disabled={busy()}
					onclick={onremove}
				/>
			</span>
		{/if}
	</div>
	<ol class="cgroup__list">
		{#each group.children as child, index (child.id)}
			<li class="cgroup__item">
				<span class="cgroup__join" aria-hidden="true">{index > 0 ? joiner : ''}</span>
				{#if child.kind === 'group'}
					<ConditionGroupEditor
						group={child}
						{fields}
						depth={depth + 1}
						{maxDepth}
						{problems}
						{fresh}
						onchange={(next, added) => replace(index, next, added)}
						onremove={() => remove(index)}
					/>
				{:else}
					<ConditionRuleEditor
						rule={child}
						{fields}
						n={index + 1}
						problem={problems.get(child.id)}
						fresh={child.id === fresh}
						onchange={(next) => replace(index, next)}
						onremove={() => remove(index)}
					/>
				{/if}
			</li>
		{/each}
	</ol>
	<div class="cgroup__add">
		<button type="button" class="cgroup__action" disabled={busy()} onclick={addRule}>
			<Icon name="plus" />{t('cond.addRule')}
		</button>
		{#if depth < maxDepth}
			<button type="button" class="cgroup__action" disabled={busy()} onclick={addGroup}>
				<Icon name="plus" />{t('cond.addGroup')}
			</button>
		{/if}
	</div>
</div>

<style>
	.cgroup {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	/* A nested group: its own quiet frame — an even border, no coloured edge. */
	.cgroup.is-nested {
		padding: 6px 8px 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
	}

	.cgroup__head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px;
		color: var(--text-secondary);
		font-size: var(--fs-body);
	}

	.cgroup__head :global(.select-menu__button) {
		font-weight: var(--fw-semibold);
	}

	/* Like a rule's, removing a group shows when it is in use; always on touch screens. */
	.cgroup__remove {
		margin-inline-start: auto;
		opacity: 0;
		transition: opacity 120ms;
	}

	.cgroup__head:hover .cgroup__remove,
	.cgroup__head:focus-within .cgroup__remove,
	.cgroup.is-nested:hover > .cgroup__head .cgroup__remove {
		opacity: 1;
	}

	@media (hover: none) {
		.cgroup__remove {
			opacity: 1;
		}
	}

	.cgroup__list {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* A narrow first column for "and" / "or", so every member starts on the same line. */
	.cgroup__item {
		display: grid;
		grid-template-columns: 3.5em minmax(0, 1fr);
		align-items: start;
	}

	.cgroup__join {
		padding-top: 6px;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.cgroup__add {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		padding-inline-start: 3.5em;
	}

	.cgroup__action {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: var(--control-h-xs);
		padding: 0 4px;
		border: 0;
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--text-secondary);
		font: inherit;
		font-size: var(--fs-caption);
		cursor: pointer;
		--icon-size: var(--icon-xs);
	}

	.cgroup__action:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}
</style>
