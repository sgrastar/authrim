<script lang="ts">
	import { untrack } from 'svelte';
	import type { Answers } from './connection-model';
	import { testBasis } from './connection-settings';
	import InSettings from './InSettings.svelte';
	import RpSettings from './RpSettings.svelte';
	import SpSettings from './SpSettings.svelte';

	/** One of a connection's settings (see `SETTINGS_PARTS`), by its id. */
	interface Props {
		part: string;
		answers: Answers;
	}

	let { part, answers = $bindable() }: Props = $props();

	let last = untrack(() => JSON.parse(testBasis(answers)));
	$effect(() => {
		const now = JSON.parse(testBasis(answers));
		untrack(() => {
			for (const kind of ['sp', 'op', 'idp'] as const)
				if (JSON.stringify(now[kind]) !== JSON.stringify(last[kind])) answers[kind].tested = false;
			last = now;
		});
	});
</script>

{#if part.startsWith('rp-')}
	<RpSettings {part} bind:settings={answers.settings.rp} appType={answers.rp.appType} />
{:else if part.startsWith('sp-')}
	<SpSettings
		{part}
		bind:settings={answers.settings.sp}
		bind:nameIdFormat={answers.sp.nameIdFormat}
	/>
{:else}
	<InSettings
		{part}
		bind:op={answers.settings.op}
		bind:idp={answers.settings.idp}
		bind:opForm={answers.op}
	/>
{/if}
