<script lang="ts">
	import { SUPPORTED_LOCALES } from '#lib/i18n/locales.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import { languageName } from './statement-model';

	/**
	 * Adds a language a statement is written in: the languages it is not in yet, and an add button.
	 * Nothing is shown once it is in every language the console writes. Used by the content form,
	 * and above it by a statement made from a service flow.
	 */
	interface Props {
		/** The languages it is in already. */
		present: readonly string[];
		onadd: (code: string) => void;
	}

	let { present, onadd }: Props = $props();

	let adding = $state('');

	const addable = $derived(
		SUPPORTED_LOCALES.filter((code) => !present.includes(code)).map((code) => ({
			value: code,
			label: languageName(code)
		}))
	);

	function add() {
		if (!adding) return;
		onadd(adding);
		adding = '';
	}
</script>

{#if addable.length > 0}
	<div class="language-add">
		<Select
			label={t('cs.content.addLanguage')}
			size="sm"
			placeholder={t('cs.content.choose')}
			options={addable}
			bind:value={adding}
		/>
		<Button size="sm" icon="plus" disabled={!adding} onclick={add}>
			{t('cs.content.add')}
		</Button>
	</div>
{/if}

<style>
	.language-add {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-related);
	}
</style>
