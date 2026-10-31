<script lang="ts">
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';
	import { formatBytes } from '../format';
	import Button from '../primitives/Button.svelte';
	import { useChangeMark } from '../save/save-scope';
	import { describeAccept, partitionFiles, type FileRejection } from './files';

	/**
	 * Single image (logo, favicon, background) with a thumbnail. `value` is the stored image's
	 * URL, a newly chosen File, or null for none; choosing or removing only changes `value`, so
	 * inside a SaveScope a new or removed image is marked and waits for Save like any other
	 * setting. The preview uses a local object URL; nothing is uploaded until the page saves.
	 */
	interface Props {
		label: string;
		/** Stored image URL, a newly chosen file, or null. */
		value?: string | File | null;
		accept?: string;
		maxBytes?: number;
		/** Thumbnail shape: square for logos and favicons, wide for backgrounds. */
		shape?: 'square' | 'wide';
		disabled?: boolean;
		onremove?: () => void;
		/** Path in the SaveScope draft; a new or removed image is marked until saved. */
		field?: string;
		/** Mark as changed explicitly. */
		changed?: boolean;
	}

	let {
		label,
		value = $bindable(null),
		accept = 'image/png,image/jpeg,image/webp,image/svg+xml',
		maxBytes,
		shape = 'square',
		disabled = false,
		onremove,
		field,
		changed
	}: Props = $props();

	const changes = useChangeMark();
	const isChanged = $derived(changed ?? changes.changed(field, value));
	const file = $derived(value instanceof File ? value : null);

	let rejected = $state<FileRejection | null>(null);
	let dimensions = $state<string>('');
	let input = $state<HTMLInputElement>();
	const uid = $props.id();

	// Object URLs hold the file in memory until revoked; revoke whenever the file changes.
	const previewUrl = $derived(file ? URL.createObjectURL(file) : null);
	$effect(() => {
		const url = previewUrl;
		return () => {
			if (url) URL.revokeObjectURL(url);
		};
	});

	const shown = $derived(previewUrl ?? (typeof value === 'string' ? value : null));

	const limits = $derived.by(() => {
		const types = describeAccept(accept);
		return maxBytes === undefined
			? types
			: t('file.limits', { types, max: formatBytes(maxBytes, i18n.locale) });
	});

	function choose(list: FileList | null) {
		if (!list?.length) return;
		const result = partitionFiles([list[0]], { accept, maxBytes });
		rejected = result.rejected[0] ?? null;
		if (result.accepted[0]) value = result.accepted[0];
		if (input) input.value = '';
	}

	function remove() {
		value = null;
		dimensions = '';
		onremove?.();
	}
</script>

<div class="image-up" class:is-disabled={disabled} class:is-changed={isChanged}>
	<p class="image-up__label" id="{uid}-label">
		{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
	</p>
	<div class="image-up__body" role="group" aria-labelledby="{uid}-label">
		<div class="image-up__thumb image-up__thumb--{shape}">
			{#if shown}
				<img
					src={shown}
					alt={file ? t('image.preview', { name: file.name }) : t('image.current')}
					onload={(event) => {
						const img = event.currentTarget as HTMLImageElement;
						dimensions = `${img.naturalWidth} × ${img.naturalHeight}`;
					}}
				/>
			{:else}
				<Icon name="image" />
			{/if}
		</div>
		<div class="image-up__side">
			{#if file}
				<p class="image-up__name">{file.name}</p>
				<p class="image-up__meta">
					{formatBytes(file.size, i18n.locale)}{dimensions ? ` · ${dimensions}` : ''}
				</p>
			{:else if limits}
				<p class="image-up__meta">{limits}</p>
			{/if}
			<div class="image-up__actions">
				<label class="image-up__pick" class:is-disabled={disabled}>
					<Icon name="upload" />
					{shown ? t('image.replace') : t('image.choose')}
					<input
						bind:this={input}
						class="sr-only"
						type="file"
						{accept}
						{disabled}
						onchange={(event) => choose(event.currentTarget.files)}
					/>
				</label>
				{#if shown}
					<Button variant="ghost" size="sm" icon="trash" {disabled} onclick={remove}>
						{t('image.remove')}
					</Button>
				{/if}
			</div>
			{#if rejected}
				<p class="image-up__error" role="alert">
					{rejected.reason === 'size'
						? t('file.tooLarge', {
								name: rejected.name,
								max: formatBytes(maxBytes ?? 0, i18n.locale)
							})
						: t('file.wrongType', { name: rejected.name })}
				</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.image-up {
		display: grid;
		gap: 8px;
	}

	.image-up.is-disabled {
		opacity: 0.55;
	}

	.image-up__label {
		margin: 0;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
		color: var(--text-secondary);
	}

	.image-up__body {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 16px;
	}

	.image-up__thumb {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		/* Checkerboard so transparent PNG/SVG edges stay visible. */
		background:
			repeating-conic-gradient(var(--bg-hover) 0 25%, transparent 0 50%) 0 0 / 14px 14px,
			var(--bg-card);
		color: var(--text-muted);
		--icon-size: var(--icon-xl);
	}

	/* Changed, not saved yet: the thumbnail gets the change colour. */
	.is-changed .image-up__thumb {
		border-color: var(--changed-edge);
		box-shadow: 0 0 0 3px var(--changed-ring);
	}

	.image-up__thumb--square {
		width: 88px;
		height: 88px;
	}

	.image-up__thumb--wide {
		width: 176px;
		height: 99px;
	}

	.image-up__thumb img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}

	.image-up__side {
		display: grid;
		min-width: 0;
		flex: 1 1 220px;
		gap: 4px;
	}

	.image-up__name {
		margin: 0;
		overflow: hidden;
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.image-up__meta {
		margin: 0;
		font-size: var(--fs-caption);
		color: var(--text-muted);
	}

	.image-up__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 6px;
	}

	.image-up__pick {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: var(--control-h-sm);
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
		font-size: var(--fs-caption);
		font-weight: var(--fw-name);
		cursor: pointer;
		--icon-size: var(--icon-sm);
	}

	.image-up__pick:hover {
		background: var(--bg-subtle);
	}

	.image-up__pick:has(input:focus-visible) {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.image-up__pick.is-disabled {
		cursor: not-allowed;
	}

	.image-up__error {
		margin: 4px 0 0;
		font-size: var(--fs-caption);
		color: var(--danger);
	}
</style>
