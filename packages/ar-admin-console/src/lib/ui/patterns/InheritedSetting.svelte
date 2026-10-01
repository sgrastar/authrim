<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';
	import { useChangeMark } from '../save/save-scope';

	/**
	 * One setting whose value can come from a wider scope (the platform's default for every
	 * tenant) or be set here (this tenant only). It says which is in effect, shows the
	 * default, and offers the one action that switches:
	 *   using the default → "Override for this tenant" (the control becomes editable)
	 *   overridden        → "Use the default" (the control shows the default again)
	 *
	 * The control is the page's own (Toggle, DurationField, Select…), given `inherited` so it
	 * can show the default and be disabled while inherited. Switching is part of the page's
	 * draft (`field` marks it), saved with everything else.
	 */
	interface Props {
		/** True: this scope sets its own value. False: the default applies. */
		overridden?: boolean;
		/** The default as people read it ("1 hour", "On"). */
		defaultValue: string;
		/** Where the default comes from ("the platform"). */
		source?: string;
		/** The whole "using the default" line, when "{source}'s default" does not fit it. */
		using?: string;
		/** Where an override applies ("this tenant"). */
		target?: string;
		/** The control; `inherited` is true while the default applies. */
		children: Snippet<[{ inherited: boolean }]>;
		onchange?: (overridden: boolean) => void;
		disabled?: boolean;
		field?: string;
		changed?: boolean;
	}

	let {
		overridden = $bindable(false),
		defaultValue,
		source = t('inherit.sourcePlatform'),
		using,
		target = t('inherit.targetTenant'),
		children,
		onchange,
		disabled = false,
		field,
		changed
	}: Props = $props();

	const busy = useBusy();
	const changes = useChangeMark();
	const isChanged = $derived(changed ?? changes.changed(field, overridden));

	function toggle() {
		overridden = !overridden;
		onchange?.(overridden);
	}
</script>

<div class="inherit" class:is-overridden={overridden} class:is-changed={isChanged}>
	{@render children({ inherited: !overridden })}
	<div class="inherit__state">
		<span class="inherit__mark" aria-hidden="true">
			<Icon name={overridden ? 'pencil' : 'link'} />
		</span>
		<span class="inherit__text">
			{overridden
				? t('inherit.overridden', { target })
				: (using ?? t('inherit.usingDefault', { source }))}{#if overridden}<span
					class="inherit__default">{t('inherit.defaultIs', { value: defaultValue })}</span
				>{/if}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
		</span>
		<button type="button" class="inherit__action" disabled={disabled || busy()} onclick={toggle}>
			{overridden ? t('inherit.reset') : t('inherit.override', { target })}
		</button>
	</div>
</div>

<style>
	.inherit {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	/* One quiet line under the control: which value applies, and the way to switch. */
	.inherit__state {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		color: var(--text-secondary);
		font-size: var(--fs-caption);
	}

	.inherit__mark {
		display: inline-flex;
		color: var(--text-muted);
		--icon-size: var(--icon-xs);
	}

	.is-overridden .inherit__mark {
		color: var(--text-secondary);
	}

	.inherit__text {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0 8px;
	}

	.inherit__default {
		color: var(--text-muted);
	}

	/* Changed, not saved yet: the line takes the change colour. */
	.is-changed .inherit__state {
		margin: -2px -6px;
		padding: 2px 6px;
		border-radius: var(--radius-xs);
		background: var(--changed-bg);
	}

	.inherit__action {
		min-height: var(--control-h-xs);
		margin-inline-start: auto;
		padding: 0 6px;
		border: 0;
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--info);
		font: inherit;
		font-weight: var(--fw-semibold);
		cursor: pointer;
	}

	.inherit__action:hover:not(:disabled) {
		background: var(--bg-hover);
		text-decoration: underline;
	}

	.inherit__action:disabled {
		color: var(--text-muted);
		cursor: not-allowed;
	}
</style>
