<script lang="ts">
	import type { KeyringFactorClient } from '#lib/api/keyring-factor.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import KeyringPresentationPanel from '../KeyringPresentationPanel.svelte';
	import { KeyringPresentationFlow } from '../presentation-flow.svelte.js';

	/** Storybook: one Keyring presentation against a fake, started on mount. */
	interface Props {
		client: KeyringFactorClient;
		/** Through the browser: how the browser's dialog ends (it is never really opened here). */
		browser?: 'answers' | 'waits' | 'cancelled';
	}

	let { client, browser }: Props = $props();

	const browserDialog = (outcome: 'answers' | 'waits' | 'cancelled') => () =>
		new Promise<unknown>((resolve, reject) => {
			if (outcome === 'waits') return;
			setTimeout(() => {
				if (outcome === 'answers') resolve({ response: 'jwe' });
				else reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }));
			}, 2_000);
		});

	// Read once: the demo is built for one fake and one browser outcome.
	// svelte-ignore state_referenced_locally
	const outcome = browser;
	const flow = new KeyringPresentationFlow({
		start: () => client.startStepUp(),
		progress: (id) => client.stepUpProgress(id),
		...(outcome
			? {
					browser: {
						start: () => client.startStepUpInBrowser(),
						submit: (id: string, data: unknown) => client.submitStepUp(id, data),
						get: browserDialog(outcome)
					}
				}
			: {})
	});
	void flow.start();
</script>

<Card title="Authrim Keyring">
	<KeyringPresentationPanel
		{flow}
		onretry={() => void flow.start()}
		onqr={() => void flow.start({ qr: true })}
	/>
</Card>
