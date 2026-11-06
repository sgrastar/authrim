<script lang="ts">
	import { onMount } from 'svelte';
	import { setStepUpPrompt, type StepUpPromptRequest } from '#lib/api/admin-step-up.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import { stepUpAsker, stepUpPromptBody } from './step-up-prompt';

	/**
	 * Asks the admin before a step-up: "This operation is L2. It takes one passkey verification and
	 * one second-factor verification (security key or Keyring). Continue?". Mounted once by the console; every operation run
	 * through `withStepUp` asks here. `request` opens it without the registry (Storybook).
	 */
	interface Props {
		request?: StepUpPromptRequest | null;
		onanswer?: (go: boolean) => void;
	}

	let { request: shown = null, onanswer }: Props = $props();

	let asked = $state<StepUpPromptRequest | null>(null);
	const request = $derived(asked ?? shown);
	const asker = stepUpAsker((next) => (asked = next));

	onMount(() => {
		const unregister = setStepUpPrompt(asker.ask);
		return () => {
			unregister();
			// Leaving the console with the dialog open declines it, so nothing waits on it.
			asker.close();
		};
	});

	function settle(go: boolean) {
		asker.settle(go);
		onanswer?.(go);
	}
</script>

<ConfirmDialog
	open={request !== null}
	title={t('stepUp.title')}
	body={request ? stepUpPromptBody(request, t) : ''}
	confirmLabel={t('stepUp.confirm')}
	onconfirm={() => settle(true)}
	oncancel={() => settle(false)}
/>
