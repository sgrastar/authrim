<script lang="ts">
	import type { KeyringFactorClient } from '#lib/api/keyring-factor.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import KeyringPresentationPanel from '../KeyringPresentationPanel.svelte';
	import { KeyringPresentationFlow } from '../presentation-flow.svelte.js';

	/** Storybook: one Keyring presentation against a fake, started on mount. */
	interface Props {
		client: KeyringFactorClient;
	}

	let { client }: Props = $props();

	const flow = new KeyringPresentationFlow({
		start: () => client.startStepUp(),
		progress: (id) => client.stepUpProgress(id)
	});
	void flow.start();
</script>

<Card title="Authrim Keyring">
	<KeyringPresentationPanel {flow} onretry={() => void flow.start()} />
</Card>
