<script lang="ts">
	import { untrack } from 'svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import AccountFlowDetail from './AccountFlowDetail.svelte';
	import { emptyFlowState, sampleState, type FlowId } from './account-flow-model';

	/**
	 * An account flow on its own page, holding what is set in it, for a story to open part-way:
	 * `filled` is nothing, only what is required, or everything. A change of `flow` or `filled`
	 * (the Controls panel) starts over, with the screen too. The mock app keeps the states of
	 * both flows itself.
	 */
	interface Props {
		flow: FlowId;
		filled?: 'none' | 'required' | 'all';
	}

	let { flow, filled = 'none' }: Props = $props();

	const initial = () =>
		filled === 'none' ? emptyFlowState() : sampleState(flow, filled === 'all');

	let form = $state(untrack(initial));
	$effect.pre(() => {
		// Read both, so a change of either one restarts.
		void [flow, filled];
		untrack(() => (form = initial()));
	});
</script>

{#key `${flow}:${filled}`}
	<Page withFlow>
		<AccountFlowDetail {flow} bind:form />
	</Page>
{/key}
