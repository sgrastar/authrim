<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import ConfirmDialog from '../patterns/ConfirmDialog.svelte';

	/**
	 * Asked when the admin moves elsewhere in the console with unsaved changes. Staying is the
	 * safe choice (Esc, the first button); leaving discards the changes. Closing the tab or
	 * reloading is asked by the browser's own dialog instead. Placed by SaveScope.
	 */
	interface Props {
		open: boolean;
		onleave: () => void;
		onstay: () => void;
	}

	let { open, onleave, onstay }: Props = $props();
</script>

<ConfirmDialog
	{open}
	tone="danger"
	title={t('common.unsaved')}
	body={t('unsaved.leaveBody')}
	confirmLabel={t('unsaved.leave')}
	cancelLabel={t('unsaved.stay')}
	onconfirm={onleave}
	oncancel={onstay}
/>
