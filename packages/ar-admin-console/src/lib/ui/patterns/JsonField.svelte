<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';
	import Button from '../primitives/Button.svelte';
	import CodeField from '../code/CodeField.svelte';
	import { checkJson, formatJson } from './json';

	/**
	 * Paste-in JSON (metadata, claims mappings, policies), syntax-highlighted. Checked as you type,
	 * with the line and column of the first error; Format re-indents valid input.
	 */
	interface Props {
		label: string;
		value?: string;
		hint?: string;
		required?: boolean;
		rows?: number;
		/** Parsed value while the text is valid JSON, otherwise undefined. */
		parsed?: unknown;
	}

	let {
		label,
		value = $bindable(''),
		hint,
		required = false,
		rows = 10,
		parsed = $bindable()
	}: Props = $props();

	const check = $derived(checkJson(value));

	$effect(() => {
		parsed = check.state === 'valid' ? check.value : undefined;
	});

	const error = $derived(
		check.state === 'invalid'
			? t('json.invalidAt', { line: check.line, column: check.column })
			: undefined
	);
</script>

<CodeField
	{label}
	language="json"
	bind:value
	{rows}
	{required}
	{error}
	placeholder={'{ "key": "value" }'}
>
	{#snippet actions()}
		<Button
			size="sm"
			variant="ghost"
			icon="braces"
			disabled={check.state !== 'valid'}
			onclick={() => (value = formatJson(value))}>{t('json.format')}</Button
		>
	{/snippet}
	{#snippet status()}
		{#if check.state === 'valid'}
			<span class="json-ok"><Icon name="checkCircle" />{t('json.valid')}</span>
		{:else if hint}
			{hint}
		{/if}
	{/snippet}
</CodeField>

<style>
	.json-ok {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: var(--success);
		font-weight: var(--fw-semibold);
		--icon-size: var(--icon-sm);
	}
</style>
