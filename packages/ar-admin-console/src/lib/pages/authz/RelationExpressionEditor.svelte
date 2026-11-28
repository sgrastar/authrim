<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import RelationExpressionEditor from './RelationExpressionEditor.svelte';
	import {
		EXPRESSION_KINDS,
		MAX_EXPRESSION_DEPTH,
		newExpr,
		withKind,
		type ExprDraft,
		type ExprProblems,
		type ExpressionKind
	} from './rebac-model';

	/**
	 * One node of a relation expression and, below it, its children: a relation on the same object
	 * (direct), any or all of several expressions (union, intersection), one expression without
	 * another (exclusion), or a relation on the object another relation leads to
	 * (tuple_to_userset, e.g. “viewers of the parent folder”).
	 */
	interface Props {
		draft: ExprDraft;
		problems: ExprProblems;
		/** Relation names the object type declares, offered while typing a relation. */
		suggestions?: readonly string[];
		/** What this node is, when it is a part of an exclusion (“Base”, “But not”). */
		role?: string;
		depth?: number;
		disabled?: boolean;
		onremove?: () => void;
	}

	let {
		draft = $bindable(),
		problems,
		suggestions = [],
		role,
		depth = 0,
		disabled = false,
		onremove
	}: Props = $props();

	const kindOptions = EXPRESSION_KINDS.map((kind) => ({
		value: kind,
		label: t(`rb.expr.kind.${kind}` as const)
	}));
	const problemKey = $derived(problems[draft.key]);
	const problem = $derived(problemKey ? t(problemKey) : undefined);
	const hint = $derived(
		suggestions.length > 0 ? t('rb.expr.suggest', { names: suggestions.join(', ') }) : undefined
	);
	const deep = $derived(depth >= MAX_EXPRESSION_DEPTH);
</script>

<div class="node">
	<header class="head">
		{#if role}<strong class="role">{role}</strong>{/if}
		<Select
			size="sm"
			label={t('rb.expr.kind')}
			hideLabel
			{disabled}
			options={kindOptions}
			bind:value={() => draft.kind, (kind) => (draft = withKind(draft, kind as ExpressionKind))}
		/>
		{#if onremove}
			<Button size="sm" variant="ghost" icon="trash" {disabled} onclick={onremove}>
				{t('rb.expr.remove')}
			</Button>
		{/if}
	</header>
	<p class="muted">{t(`rb.expr.desc.${draft.kind}` as const)}</p>

	{#if draft.kind === 'direct'}
		<TextField
			label={t('rb.expr.relation')}
			{hint}
			{disabled}
			error={problem}
			placeholder="viewer"
			bind:value={draft.relation}
		/>
	{:else if draft.kind === 'tuple_to_userset'}
		<div class="pair">
			<TextField
				label={t('rb.expr.tupleset')}
				hint={t('rb.expr.tuplesetHint')}
				{disabled}
				error={problem}
				placeholder="parent"
				bind:value={draft.tupleset}
			/>
			<TextField
				label={t('rb.expr.computed')}
				hint={t('rb.expr.computedHint')}
				{disabled}
				placeholder="viewer"
				bind:value={draft.computed}
			/>
		</div>
	{:else if draft.kind === 'exclusion'}
		{#if draft.base && draft.subtract}
			<div class="children">
				<RelationExpressionEditor
					bind:draft={draft.base}
					{problems}
					{suggestions}
					{disabled}
					role={t('rb.expr.base')}
					depth={depth + 1}
				/>
				<RelationExpressionEditor
					bind:draft={draft.subtract}
					{problems}
					{suggestions}
					{disabled}
					role={t('rb.expr.subtract')}
					depth={depth + 1}
				/>
			</div>
		{/if}
	{:else}
		{#if problem}<p class="problem" role="alert">{problem}</p>{/if}
		<div class="children">
			{#each draft.children as child, index (child.key)}
				<RelationExpressionEditor
					bind:draft={draft.children[index]}
					{problems}
					{suggestions}
					{disabled}
					depth={depth + 1}
					onremove={() => draft.children.splice(index, 1)}
				/>
			{/each}
		</div>
		{#if !deep}
			<div>
				<Button size="sm" icon="plus" {disabled} onclick={() => draft.children.push(newExpr())}>
					{t('rb.expr.addChild')}
				</Button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.node {
		display: grid;
		gap: var(--space-related);
		padding: var(--box-pad);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-related);
	}

	.role {
		font-size: var(--fs-label);
	}

	.children {
		display: grid;
		gap: var(--space-related);
	}

	.pair {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: var(--space-related);
	}

	.muted {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-body);
	}

	.problem {
		margin: 0;
		color: var(--danger);
		font-size: var(--fs-small);
	}
</style>
