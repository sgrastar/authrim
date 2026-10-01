<script lang="ts" module>
	import { toast } from '../toast/toast.svelte';
	import { sample } from './sample';

	/** Puts one toast of every tone on screen, without timers. */
	export function showAllTones(): void {
		toast.dismissAll();
		const options = { duration: 0, dedupeWindow: 0 };
		toast.success(sample('savedToast'), options);
		toast.error(sample('errorToast'), options);
		toast.warning(sample('warningToast'), options);
		toast.info(sample('infoToast'), options);
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import Toaster from '../toast/Toaster.svelte';

	/** Storybook demo: every tone at once, so docs pages show the stack without a click. */
	onMount(() => {
		showAllTones();
		return () => toast.dismissAll();
	});
</script>

<Toaster />
