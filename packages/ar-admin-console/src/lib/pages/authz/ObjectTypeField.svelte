<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';

	/**
	 * An object type: chosen from the types the tenant's definitions already use, or typed when it
	 * is a new one (and always typed while the API lists none, or the admin may not read them).
	 */
	interface Props {
		label: string;
		value?: string;
		/** The types the definitions use. */
		types: readonly string[];
		required?: boolean;
		disabled?: boolean;
		hint?: string;
		error?: string;
		placeholder?: string;
	}

	let {
		label,
		value = $bindable(''),
		types,
		required = false,
		disabled = false,
		hint,
		error,
		placeholder = 'document'
	}: Props = $props();

	const OTHER = '__other__';
	// Typing is chosen once ("Other…"), and kept while the field shows what was typed.
	let typing = $state(false);
	const listed = $derived(types.length > 0 && !typing && (value === '' || types.includes(value)));
</script>

{#if listed}
	<Select
		{label}
		{required}
		{disabled}
		{hint}
		{error}
		placeholder={t('rb.type.choose')}
		options={[
			...types.map((name) => ({ value: name, label: name })),
			{ value: OTHER, label: t('rb.type.other') }
		]}
		bind:value={
			() => value,
			(next) => {
				if (next === OTHER) {
					typing = true;
					value = '';
				} else value = next;
			}
		}
	/>
{:else}
	<TextField {label} {required} {disabled} {hint} {error} {placeholder} bind:value />
{/if}
