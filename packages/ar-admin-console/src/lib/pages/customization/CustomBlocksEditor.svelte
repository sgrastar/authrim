<script lang="ts">
	import {
		LOGIN_UI_CUSTOM_BLOCK_POSITIONS,
		LOGIN_UI_CUSTOM_BLOCK_TYPES
	} from '@authrim/ar-lib-core/types/login-ui-custom-blocks';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { useInvalidReport } from '#lib/ui/save/save-scope.js';
	import {
		BLOCK_CONTENT_MAX,
		BLOCK_URL_MAX,
		BLOCKS_MAX,
		blockProblem,
		fieldsOf,
		newBlock,
		type CustomBlock
	} from './login-ui-custom-blocks';

	/**
	 * The tenant's own content blocks around the sign-in screens, one row each: where it goes,
	 * what it is, and its text or address. A block the screens would leave out (nothing written,
	 * an address of the wrong kind) shows why and holds the save. At most BLOCKS_MAX.
	 */
	interface Props {
		blocks: CustomBlock[];
		/** Path of the list in the SaveScope draft (`customBlocks`): rows mark their changes. */
		field: string;
	}

	let { blocks = $bindable(), field }: Props = $props();

	// Derived, so that the console's language switch (no remount) renames the choices too.
	const positions = $derived(
		LOGIN_UI_CUSTOM_BLOCK_POSITIONS.map((value) => ({
			value,
			label: t(`lu.blocks.position.${value}`)
		}))
	);
	const types = $derived(
		LOGIN_UI_CUSTOM_BLOCK_TYPES.map((value) => ({ value, label: t(`lu.blocks.type.${value}`) }))
	);

	const problems = $derived(blocks.map(blockProblem));
	const report = useInvalidReport();
	$effect(() => {
		report(problems.some((problem) => problem !== null));
	});

	function update(i: number, patch: Partial<CustomBlock>) {
		blocks = blocks.map((block, index) => (index === i ? { ...block, ...patch } : block));
	}
	const remove = (i: number) => (blocks = blocks.filter((_, index) => index !== i));
	const add = () => (blocks = [...blocks, newBlock()]);

	const problemText = (problem: ReturnType<typeof blockProblem>, type: CustomBlock['type']) => {
		if (problem === null) return undefined;
		if (problem === 'contentLong')
			return t('lu.blocks.problem.contentLong', { max: BLOCK_CONTENT_MAX });
		if (problem === 'urlLong') return t('lu.blocks.problem.urlLong', { max: BLOCK_URL_MAX });
		if (problem === 'url') return t('lu.blocks.problem.url');
		return t(`lu.blocks.problem.content.${type}`);
	};
</script>

<div class="blocks">
	{#if blocks.length === 0}
		<p class="blocks__empty">{t('lu.blocks.none')}</p>
	{/if}
	{#each blocks as block, i (i)}
		{@const fields = fieldsOf(block.type)}
		{@const problem = problems[i]}
		{@const contentError = problem === 'content' || problem === 'contentLong'}
		<div class="blocks__row">
			<div class="blocks__where">
				<Select
					label={t('lu.blocks.position')}
					size="sm"
					field="{field}.{i}.position"
					options={positions}
					value={block.position}
					onchange={(value) => update(i, { position: value as CustomBlock['position'] })}
				/>
				<Select
					label={t('lu.blocks.type')}
					size="sm"
					field="{field}.{i}.type"
					options={types}
					value={block.type}
					onchange={(value) => update(i, { type: value as CustomBlock['type'] })}
				/>
				<div class="blocks__remove">
					<IconButton
						icon="trash"
						size="sm"
						label={t('lu.blocks.remove', { n: i + 1 })}
						onclick={() => remove(i)}
					/>
				</div>
			</div>
			{#if fields.content === 'text'}
				<TextArea
					label={t(`lu.blocks.content.${block.type}`)}
					hint={block.type === 'html' ? t('lu.blocks.content.html.hint') : undefined}
					rows={3}
					maxlength={BLOCK_CONTENT_MAX}
					field="{field}.{i}.content"
					error={contentError ? problemText(problem, block.type) : undefined}
					value={block.content}
					oninput={(event) => update(i, { content: event.currentTarget.value })}
				/>
			{:else}
				<TextField
					label={t(`lu.blocks.content.${block.type}`)}
					size="sm"
					field="{field}.{i}.content"
					error={contentError ? problemText(problem, block.type) : undefined}
					value={block.content}
					oninput={(event) => update(i, { content: event.currentTarget.value })}
				/>
			{/if}
			{#if fields.extra === 'url'}
				<TextField
					label={t('lu.blocks.url')}
					size="sm"
					inputmode="url"
					field="{field}.{i}.url"
					error={problem === 'url' || problem === 'urlLong'
						? problemText(problem, block.type)
						: undefined}
					value={block.url ?? ''}
					oninput={(event) => update(i, { url: event.currentTarget.value })}
				/>
			{:else if fields.extra === 'alt'}
				<TextField
					label={t('lu.blocks.alt')}
					hint={t('lu.blocks.alt.hint')}
					size="sm"
					field="{field}.{i}.alt"
					value={block.alt ?? ''}
					oninput={(event) => update(i, { alt: event.currentTarget.value })}
				/>
			{/if}
		</div>
	{/each}
	<div>
		<Button
			size="sm"
			variant="secondary"
			icon="plus"
			disabled={blocks.length >= BLOCKS_MAX}
			onclick={add}>{t('lu.blocks.add')}</Button
		>
		{#if blocks.length >= BLOCKS_MAX}
			<span class="blocks__limit">{t('lu.blocks.limit', { max: BLOCKS_MAX })}</span>
		{/if}
	</div>
</div>

<style>
	.blocks {
		display: grid;
		gap: var(--space-related);
	}

	.blocks__empty,
	.blocks__limit {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
	}

	.blocks__limit {
		margin-inline-start: var(--space-related);
	}

	.blocks__row {
		display: grid;
		gap: var(--space-field);
		padding: var(--space-related) 0;
		border-top: 1px solid var(--border-subtle);
	}

	.blocks__where {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
		gap: var(--space-field);
		align-items: end;
	}

	.blocks__remove {
		padding-bottom: 4px;
	}
</style>
