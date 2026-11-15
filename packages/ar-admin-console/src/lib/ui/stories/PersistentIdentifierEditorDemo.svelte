<script lang="ts">
	import { untrack } from 'svelte';
	import MappingEditor from '../patterns/MappingEditor.svelte';
	import type { Mapping, MappingField } from '../patterns/mapping-model';

	/**
	 * Storybook demo: the mapping editor with one empty attribute (the identifier released to an
	 * app), where a persistent identifier step is picked and set up. No source attribute is
	 * needed: the step makes the value from the account.
	 */
	/** Start with an ordinary mapping from "mail", to be switched to the identifier step. */
	interface Props {
		withSource?: boolean;
	}
	let { withSource = false }: Props = $props();

	const sources: MappingField[] = [{ key: 'mail', type: 'string', example: 'taro@example.edu' }];
	const targets: MappingField[] = [
		{ key: 'persistent_id', label: 'Persistent ID', type: 'string' }
	];
	let mappings = $state<Mapping[]>(
		untrack(() => withSource)
			? [{ id: 'm1', target: 'persistent_id', sources: ['mail'], steps: [] }]
			: []
	);
</script>

<div style="max-width: 900px">
	<MappingEditor label="Attributes" {sources} {targets} bind:mappings />
</div>
