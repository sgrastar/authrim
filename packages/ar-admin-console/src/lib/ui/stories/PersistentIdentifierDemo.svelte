<script lang="ts">
	import { untrack } from 'svelte';
	import { createFakeIdentifierMaterials } from '#lib/api/fake/identifier-materials-fake.js';
	import Card from '../patterns/Card.svelte';
	import { provideIdentifierMaterials } from '../patterns/identifier-materials-context';
	import { identifierRuntimeParams, newStep, type TransformStep } from '../patterns/mapping-model';
	import PersistentIdentifierParams from '../patterns/PersistentIdentifierParams.svelte';

	/**
	 * Storybook demo: the settings of a persistent identifier step on their own, with what was
	 * imported before (a salt, a source, a store, an exception list) and the settings the
	 * runtime would receive shown under them: only those that apply.
	 */
	interface Props {
		/** Settings to start from, over the step's defaults. */
		params?: Record<string, string>;
	}

	let { params = {} }: Props = $props();

	provideIdentifierMaterials(
		createFakeIdentifierMaterials({
			salts: { 'legacy-idp': 'legacy salt', 'campus-idp': 'campus salt' },
			sources: { 'employee-number': { usr_01: 'E1001' } },
			stores: { 'legacy-ids': { usr_01: { 'https://sp.example.org': 'abc123' } } },
			exceptions: { 'exception-map': 2 }
		})
	);

	const first = newStep('persistent_identifier', 'step-1');
	// Start from the given settings (read once).
	let step = $state<TransformStep>({
		...first,
		params: { ...first.params, ...untrack(() => params) }
	});
	const sent = $derived(identifierRuntimeParams(step.params));
</script>

<div style="max-width: 520px">
	<Card title="persistent_identifier">
		<div class="params">
			<PersistentIdentifierParams
				{step}
				onchange={(name, value) => (step = { ...step, params: { ...step.params, [name]: value } })}
			/>
		</div>
		<pre class="sent" data-testid="sent">{JSON.stringify(sent, null, 1)}</pre>
	</Card>
</div>

<style>
	.params {
		display: grid;
		gap: 12px;
	}

	.sent {
		margin: 16px 0 0;
		font-family: var(--font-mono);
		font-size: var(--fs-caption);
		color: var(--text-muted);
		white-space: pre-wrap;
	}
</style>
