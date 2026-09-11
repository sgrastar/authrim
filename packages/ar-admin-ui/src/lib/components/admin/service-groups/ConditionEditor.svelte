<script lang="ts">
	import type { Expression, Field, ServiceGroup } from '$lib/api/service-groups';
	import { groupFieldLabel, type GroupText } from '$lib/admin/service-groups-i18n';
	import ConditionEditor from './ConditionEditor.svelte';
	let {
		value = $bindable<Expression>({
			op: 'attribute',
			field: 'country',
			compare: 'eq',
			value: 'JP'
		}),
		fields,
		groups,
		text,
		depth = 0
	}: {
		value: Expression;
		fields: Record<string, Field>;
		groups: ServiceGroup[];
		text: GroupText;
		depth?: number;
	} = $props();
	function change(op: string) {
		if (op === value.op) return;
		if (op === 'all' || op === 'any')
			value = { op, args: value.op === 'all' || value.op === 'any' ? value.args : [value] };
		else if (op === 'not') value = { op, arg: value };
		else if (op === 'member') value = { op, groupId: groups[0]?.id ?? '' };
		else value = { op: 'attribute', field: 'country', compare: 'eq', value: 'JP' };
	}
	function fieldChange(field: string) {
		const type = fields[field]?.type ?? 'string';
		value = {
			op: 'attribute',
			field,
			compare: type.endsWith('[]') ? 'contains' : 'eq',
			value: type.startsWith('boolean') ? false : type.startsWith('number') ? 0 : ''
		};
	}
	let raw = $derived(
		value.op === 'attribute'
			? Array.isArray(value.value)
				? value.value.join('\n')
				: String(value.value)
			: ''
	);
	function setValue(raw: string) {
		if (value.op !== 'attribute') return;
		const type = fields[value.field]?.type;
		const scalar = (input: string) =>
			type?.startsWith('number')
				? input.trim() === ''
					? ''
					: Number(input)
				: type?.startsWith('boolean')
					? input === 'true'
						? true
						: input === 'false'
							? false
							: input
					: input;
		value.value = value.compare === 'in' ? raw.split('\n').map(scalar) : scalar(raw);
	}
</script>

<fieldset class="condition">
	<legend>{text.condition}</legend>
	<select
		aria-label={text.condition}
		value={value.op}
		onchange={(e) => change(e.currentTarget.value)}
	>
		<option value="attribute">{text.attribute}</option><option value="member">{text.member}</option>
		<option value="all" disabled={depth >= 11}>{text.all}</option><option
			value="any"
			disabled={depth >= 11}>{text.any}</option
		><option value="not" disabled={depth >= 11}>{text.not}</option>
	</select>
	{#if value.op === 'attribute'}
		<select
			aria-label={text.field}
			value={value.field}
			onchange={(e) => fieldChange(e.currentTarget.value)}
			>{#each Object.entries(fields) as [key, field] (key)}<option value={key}
					>{groupFieldLabel(key, text)} ({field.type})</option
				>{/each}</select
		>
		<select
			aria-label={text.compare}
			value={value.compare}
			onchange={(e) => {
				if (value.op !== 'attribute') return;
				const previous = value.value;
				value.compare = e.currentTarget.value as typeof value.compare;
				value.value =
					value.compare === 'in'
						? Array.isArray(previous)
							? previous
							: [previous]
						: Array.isArray(previous)
							? (previous[0] ?? '')
							: previous;
			}}
		>
			{#if fields[value.field]?.type.endsWith('[]')}<option value="contains">{text.contains}</option
				>{:else}<option value="eq">{text.eq}</option><option value="in">{text.in}</option
				>{#if fields[value.field]?.type === 'number'}<option value="lt">&lt;</option><option
						value="lte">≤</option
					><option value="gt">&gt;</option><option value="gte">≥</option>{/if}{/if}
		</select>
		{#if value.compare === 'in'}
			<label class="list-values"
				>{text.listHint}<textarea
					aria-label={text.value}
					value={raw}
					rows="3"
					oninput={(e) => setValue(e.currentTarget.value)}
				></textarea></label
			>
		{:else if fields[value.field]?.type.startsWith('boolean')}<select
				aria-label={text.value}
				value={String(value.value)}
				onchange={(e) => setValue(e.currentTarget.value)}
				><option value="true">{text.yes}</option><option value="false">{text.no}</option></select
			>{:else}<input
				aria-label={text.value}
				value={raw}
				oninput={(e) => setValue(e.currentTarget.value)}
			/>{/if}
	{:else if value.op === 'member'}
		<select aria-label={text.group} bind:value={value.groupId}
			><option value="">—</option>{#each groups as group (group.id)}<option value={group.id}
					>{group.displayName}</option
				>{/each}</select
		>
	{:else if value.op === 'not'}
		<ConditionEditor bind:value={value.arg} {fields} {groups} {text} depth={depth + 1} />
	{:else}
		{#each value.args as _, i (i)}<div>
				<ConditionEditor
					bind:value={value.args[i]}
					{fields}
					{groups}
					{text}
					depth={depth + 1}
				/><button
					type="button"
					onclick={() => {
						if (value.op === 'all' || value.op === 'any')
							value.args = value.args.filter((_, index) => index !== i);
					}}
					disabled={value.args.length <= 1}>{text.remove}</button
				>
			</div>{/each}
		<button
			type="button"
			disabled={depth >= 11 || value.args.length >= 32}
			onclick={() => {
				if (value.op === 'all' || value.op === 'any')
					value.args = [
						...value.args,
						{ op: 'attribute', field: 'country', compare: 'eq', value: 'JP' }
					];
			}}>{text.add}</button
		>
	{/if}
</fieldset>

<style>
	.condition {
		border: 1px solid var(--border-color, #bbb);
		border-radius: 8px;
		padding: 12px;
		margin: 8px 0;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.condition > div,
	.condition :global(fieldset) {
		flex-basis: 100%;
	}
	input,
	textarea,
	select,
	button {
		padding: 8px;
		max-width: 100%;
		border: 1px solid var(--color-border, #bbb);
		border-radius: 6px;
		background: var(--color-bg-primary, white);
		color: var(--color-text);
	}
	.list-values {
		width: 100%;
		font-size: 0.875rem;
	}
	textarea {
		display: block;
		width: 100%;
		margin-top: 6px;
	}
</style>
