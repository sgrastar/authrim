<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import ConfirmDialog from '$lib/ui/patterns/ConfirmDialog.svelte';

	/**
	 * Asked when someone goes back from a flow's detail while it holds changes that were not saved
	 * (leaving through a link is asked by the SaveScope itself; going back in place is not a
	 * navigation, so the screen asks).
	 */
	interface Props {
		open: boolean;
		/** Go back and lose the changes. */
		onleave: () => void;
		/** Stay and keep editing. */
		onstay: () => void;
	}

	let { open, onleave, onstay }: Props = $props();
</script>

<ConfirmDialog
	{open}
	title={t('sf.unsaved.title')}
	body={t('sf.unsaved.body')}
	confirmLabel={t('sf.unsaved.confirm')}
	cancelLabel={t('sf.unsaved.keep')}
	tone="danger"
	onconfirm={onleave}
	oncancel={onstay}
/>
