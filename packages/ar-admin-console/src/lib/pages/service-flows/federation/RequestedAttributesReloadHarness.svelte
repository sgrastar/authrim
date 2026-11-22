<script lang="ts">
	import type {
		FederationRequestedAttributes,
		FederationSourcesClient
	} from '#lib/api/federation-sources.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import FederationRequestedAttributesCard from './FederationRequestedAttributes.svelte';

	/**
	 * Storybook only: the card as the federation page holds it, with a button that stands for a
	 * metadata refresh (the page bumps the key). Each read answers the next of `answers`.
	 */
	interface Props {
		answers: FederationRequestedAttributes[];
	}

	let { answers }: Props = $props();
	let key = $state(0);
	let reads = 0;
	const client: Pick<FederationSourcesClient, 'requestedAttributes'> = {
		async requestedAttributes() {
			return answers[Math.min(reads++, answers.length - 1)];
		}
	};
</script>

<Button size="sm" onclick={() => key++}>Metadata refreshed</Button>
<FederationRequestedAttributesCard {client} id="test-federation" refreshKey={key} />
