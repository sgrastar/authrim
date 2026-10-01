<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';

	/**
	 * An on/off value shown as text, for pages where it cannot be changed (a view-only
	 * setting, a detail row): a filled dot for on, an empty ring for off, then the word. The
	 * dot is only a quicker cue; the word carries the meaning.
	 */
	interface Props {
		on: boolean;
	}

	let { on }: Props = $props();
</script>

<span class="onoff"
	><span class="onoff__dot" class:is-on={on} aria-hidden="true"></span>{on
		? t('settings.value.on')
		: t('settings.value.off')}</span
>

<style>
	.onoff {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.onoff__dot {
		flex-shrink: 0;
		width: 8px;
		height: 8px;
		border: 1.5px solid var(--text-muted);
		border-radius: 50%;
	}

	.onoff__dot.is-on {
		border-color: var(--text-primary);
		background: var(--text-primary);
	}
</style>
