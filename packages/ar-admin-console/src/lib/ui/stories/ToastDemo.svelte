<script lang="ts">
	import Button from '../primitives/Button.svelte';
	import Toaster from '../toast/Toaster.svelte';
	import { toast } from '../toast/toast.svelte';
	import { sample } from './sample';

	/** Storybook demo: trigger each tone; hover the stack to pause the timers. */
</script>

<div style="display:flex;flex-wrap:wrap;gap:8px">
	<Button icon="checkCircle" onclick={() => toast.success(sample('savedToast'))}
		>{sample('showSuccess')}</Button
	>
	<Button icon="warningCircle" onclick={() => toast.error(sample('errorToast'))}
		>{sample('showError')}</Button
	>
	<Button icon="warning" onclick={() => toast.warning(sample('warningToast'))}
		>{sample('showWarning')}</Button
	>
	<Button icon="info" onclick={() => toast.info(sample('infoToast'))}>{sample('showInfo')}</Button>
	<Button variant="ghost" onclick={() => toast.dismissAll()}>{sample('dismissAll')}</Button>
</div>
<Toaster />
