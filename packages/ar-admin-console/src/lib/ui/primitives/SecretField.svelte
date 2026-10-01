<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Callout from '../patterns/Callout.svelte';
	import { useChangeMark } from '../save/save-scope';
	import Button from './Button.svelte';
	import CopyButton from './CopyButton.svelte';
	import IconButton from './IconButton.svelte';

	/**
	 * Secrets: client secrets, API keys, signing material.
	 *
	 * `mode="show"` — a value the console just created (a new client secret). Hidden until
	 * "Show" is pressed, copyable either way; with `once`, a note says it cannot be shown again.
	 *
	 * `mode="enter"` — the admin types a secret (an external IdP's client secret). The input
	 * hides what is typed until "Show" is pressed. With `stored`, a secret already exists on
	 * the server and is never sent back: the field reads "Set" until the admin chooses to
	 * replace it, and "Keep the current value" undoes that. `value` stays empty unless a new
	 * secret is typed, so saving without touching the field keeps the old one.
	 *
	 * The hidden form is a fixed row of dots, so it does not reveal the secret's length.
	 */
	interface Props {
		label: string;
		value?: string;
		mode?: 'show' | 'enter';
		/** show: the value cannot be shown again after this. */
		once?: boolean;
		/** enter: a secret is already saved on the server. */
		stored?: boolean;
		/** enter + stored: the admin is typing a replacement. */
		replacing?: boolean;
		hint?: string;
		error?: string;
		required?: boolean;
		disabled?: boolean;
		field?: string;
		changed?: boolean;
	}

	let {
		label,
		value = $bindable(''),
		mode = 'enter',
		once = false,
		stored = false,
		replacing = $bindable(false),
		hint,
		error,
		required = false,
		disabled = false,
		field,
		changed
	}: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	const changes = useChangeMark();
	const isChanged = $derived(changed ?? changes.changed(field, value));
	const off = $derived(disabled || busy());
	let visible = $state(false);
	let input = $state<HTMLInputElement>();

	const MASK = '••••••••••••';
	const editing = $derived(mode === 'enter' && (!stored || replacing));
	const describedBy = $derived(
		[hint ? `${uid}-hint` : '', error ? `${uid}-error` : ''].filter(Boolean).join(' ') || undefined
	);

	async function replace() {
		replacing = true;
		await tick();
		input?.focus();
	}

	function keep() {
		replacing = false;
		value = '';
		visible = false;
	}
</script>

<div
	class="secret"
	class:is-changed={isChanged}
	class:has-error={!!error}
	role="group"
	aria-labelledby="{uid}-label"
>
	{#snippet title()}
		{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
		{#if required}<span class="secret__req" aria-hidden="true">*</span>{/if}
	{/snippet}
	<!-- A label only where there is a field to label; otherwise the text names the group. -->
	{#if mode === 'show' || editing}
		<label class="secret__label" for="{uid}-input" id="{uid}-label">{@render title()}</label>
	{:else}
		<span class="secret__label" id="{uid}-label">{@render title()}</span>
	{/if}

	{#if mode === 'show'}
		{#if once}<Callout tone="warning">{t('secret.once')}</Callout>{/if}
		<div class="secret__row">
			<output class="secret__value" id="{uid}-input" aria-labelledby="{uid}-label"
				>{visible ? value : MASK}</output
			>
			<IconButton
				icon={visible ? 'eyeSlash' : 'eye'}
				label={t(visible ? 'secret.hide' : 'secret.show', { name: label })}
				onclick={() => (visible = !visible)}
			/>
			<CopyButton text={() => value} {label} />
		</div>
	{:else if editing}
		<div class="secret__row">
			<div class="secret__box">
				<input
					bind:this={input}
					id="{uid}-input"
					type={visible ? 'text' : 'password'}
					dir="ltr"
					bind:value
					autocomplete="new-password"
					spellcheck="false"
					{required}
					disabled={off}
					aria-invalid={error ? 'true' : undefined}
					aria-describedby={describedBy}
				/>
				<IconButton
					icon={visible ? 'eyeSlash' : 'eye'}
					label={t(visible ? 'secret.hide' : 'secret.show', { name: label })}
					disabled={off}
					onclick={() => (visible = !visible)}
				/>
			</div>
			{#if stored}
				<Button size="sm" variant="ghost" disabled={off} onclick={keep}>{t('secret.keep')}</Button>
			{/if}
		</div>
	{:else}
		<div class="secret__row">
			<p class="secret__state" id="{uid}-input">{t('secret.stored')}</p>
			<Button size="sm" variant="secondary" disabled={off} onclick={replace}>
				{t('secret.replace')}
			</Button>
		</div>
	{/if}

	{#if hint}<p class="secret__hint" id="{uid}-hint">{hint}</p>{/if}
	{#if error}<p class="secret__error" id="{uid}-error">{error}</p>{/if}
</div>

<style>
	.secret {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.secret__label {
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.secret__req {
		margin-inline-start: 3px;
		color: var(--danger);
	}

	.secret__row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-related);
	}

	/* A shown value: monospace, one line, selectable. */
	.secret__value {
		flex: 1 1 16rem;
		min-width: 0;
		padding: 7px 10px;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: var(--fs-body);
		text-overflow: ellipsis;
		white-space: nowrap;
		user-select: all;
	}

	.secret__box {
		display: flex;
		flex: 1 1 16rem;
		align-items: center;
		min-width: 0;
		height: var(--control-h);
		padding-inline-end: 2px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
	}

	.secret__box:focus-within {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
	}

	input {
		flex: 1;
		min-width: 0;
		height: 100%;
		padding: 0 10px;
		border: 0;
		background: transparent;
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: var(--fs-body);
		outline: none;
	}

	.is-changed .secret__box {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-input);
	}

	.has-error .secret__box {
		border-color: var(--danger);
	}

	.secret__state {
		flex: 1 1 12rem;
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
	}

	.secret__hint,
	.secret__error {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.secret__hint {
		color: var(--text-muted);
	}

	.secret__error {
		color: var(--danger);
	}
</style>
