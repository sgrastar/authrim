<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import IconButton from '#lib/ui/primitives/IconButton.svelte';
	import PickerDialog from '#lib/ui/patterns/PickerDialog.svelte';
	import { bgPresetFile, bgPresetGroups, bgPresetUrl } from './bg-presets';

	/**
	 * A small folder button beside a background picture that opens the bundled presets in a
	 * large column browser (category → picture → preview). Applying one hands it to `onpick` as
	 * a File (ImageUpload checks it like a file from disk), so it waits for Save and is uploaded
	 * like any other picture.
	 */
	interface Props {
		/** The field's current picture: tells which preset, if any, is the one in use. */
		value?: string | File | null;
		disabled?: boolean;
		onpick: (file: File) => void;
	}

	let { value = null, disabled = false, onpick }: Props = $props();

	let open = $state(false);
	let loading = $state(false);
	let failed = $state(false);
	// Each fetch gets a number; closing or starting another makes an older one's result void.
	let request = 0;
	// The preset last applied here, while the picture is still that one.
	let applied = $state<{ id: string; file: File } | null>(null);
	const current = $derived(applied && value === applied.file ? applied.id : null);

	const groups = $derived(bgPresetGroups());

	function close() {
		request++;
		loading = false;
		open = false;
	}

	async function choose(id: string) {
		if (loading) return;
		const mine = ++request;
		loading = true;
		failed = false;
		try {
			const file = await bgPresetFile(id);
			if (mine !== request) return;
			applied = { id, file };
			onpick(file);
			close();
		} catch {
			if (mine === request) failed = true;
		} finally {
			if (mine === request) loading = false;
		}
	}
</script>

<IconButton
	icon="folder"
	size="sm"
	label={t('th.bg.browse')}
	{disabled}
	onclick={() => {
		failed = false;
		open = true;
	}}
/>

<PickerDialog
	{open}
	title={t('th.bg.title')}
	{groups}
	value={current}
	chooseLabel={t('th.bg.apply')}
	currentLabel={t('th.bg.current')}
	onchoose={choose}
	oncancel={close}
>
	{#snippet preview(item)}
		<div class="bg-preview" aria-busy={loading}>
			<img src={bgPresetUrl(item.value)} alt={item.label} />
		</div>
		{#if failed}<p class="bg-preview__error" role="alert">{t('th.bg.loadFailed')}</p>{/if}
	{/snippet}
</PickerDialog>

<style>
	.bg-preview {
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
		aspect-ratio: 16 / 10;
	}

	.bg-preview[aria-busy='true'] {
		opacity: 0.6;
	}

	.bg-preview img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.bg-preview__error {
		margin: 0;
		color: var(--danger);
		font-size: var(--fs-caption);
	}
</style>
