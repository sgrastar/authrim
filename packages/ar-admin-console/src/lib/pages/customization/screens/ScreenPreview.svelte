<script lang="ts">
	import type { LayoutRow } from '#lib/ui/builder/layout-model.js';
	import Icon from '#lib/ui/icons/Icon.svelte';
	import {
		ACCOUNT_KINDS,
		choicesOf,
		partKind,
		type ChoiceSource,
		type DisplayCondition,
		type PartSettings
	} from './screen-model';

	/**
	 * A rough picture of a Login UI page built from layout rows: rows, columns and what each part
	 * roughly looks like (the Login UI draws the real page). Hidden parts and rows are left out;
	 * "when a feature is on" is shown as on; a hidden label is left out (the Login UI keeps it for
	 * screen readers). A choice part linked to an attribute shows the attribute's choices, from
	 * `choices` (none when not given).
	 */
	interface Props {
		rows: readonly LayoutRow[];
		settings?: Record<string, PartSettings>;
		rowSettings?: Record<string, DisplayCondition>;
		choices?: ChoiceSource;
		/** The parts read in the legacy yes/no form (see `legacyYesNoIds`). */
		legacyYesNo?: ReadonlySet<string>;
		wide?: boolean;
	}

	let {
		rows,
		settings = {},
		rowSettings = {},
		choices,
		legacyYesNo,
		wide = false
	}: Props = $props();

	const shownRows = $derived(rows.filter((row) => rowSettings[row.id]?.mode !== 'hidden'));
</script>

<div class="screen" class:screen--wide={wide}>
	{#each shownRows as row (row.id)}
		<div class="screen__row" style:--cols={row.columns.length}>
			{#each row.columns as column, c (c)}
				<div class="screen__col">
					{#each column.filter((p) => settings[p.id]?.condition.mode !== 'hidden') as part (part.id)}
						{@const extra = settings[part.id]}
						{#if part.kind === 'heading'}
							<h2>{part.label}</h2>
							{#if extra?.text}<p>{extra.text}</p>{/if}
						{:else if part.kind === 'text'}
							<p>{extra?.text || part.label}</p>
						{:else if part.kind === 'identity_field'}
							<span class="screen__field">
								{#if extra?.showLabel !== false}<span
										>{part.label}{extra?.required ? ' *' : ''}</span
									>{/if}
								<i>{extra?.placeholder}</i>
								{#if extra?.helpText}<small>{extra.helpText}</small>{/if}
							</span>
						{:else if part.kind === 'select'}
							<span class="screen__field">
								{#if extra?.showLabel !== false}<span
										>{part.label}{extra?.required ? ' *' : ''}</span
									>{/if}
								<i class="screen__select"
									>{extra?.placeholder || choicesOf(extra, choices)[0]?.label}</i
								>
								{#if extra?.helpText}<small>{extra.helpText}</small>{/if}
							</span>
						{:else if part.kind === 'radio'}
							<span class="screen__field">
								{#if extra?.showLabel !== false}<span
										>{part.label}{extra?.required ? ' *' : ''}</span
									>{/if}
								{#each choicesOf(extra, choices) as option (option.value)}
									<span class="screen__check"><i class="screen__dot"></i>{option.label}</span>
								{/each}
								{#if extra?.helpText}<small>{extra.helpText}</small>{/if}
							</span>
						{:else if part.kind === 'checkbox'}
							<!-- A legacy yes/no question with words of its own beside the box: the label is
							     the question above it, as the Login UI shows it. -->
							{#if legacyYesNo?.has(part.id) && extra?.linked && extra.placeholder && extra.placeholder !== part.label}
								<span class="screen__field">
									{#if extra.showLabel !== false}<span
											>{part.label}{extra.required ? ' *' : ''}</span
										>{/if}
									<span class="screen__check"><i></i>{extra.placeholder}</span>
								</span>
							{:else}
								<span class="screen__check">
									<i></i>{part.label}{extra?.required ? ' *' : ''}
								</span>
							{/if}
						{:else if part.kind === 'auth_widget'}
							<span class="screen__button">{part.label}</span>
						{:else if part.kind === 'code_input_widget'}
							<span class="screen__code"><i></i><i></i><i></i><i></i><i></i><i></i></span>
						{:else if part.kind === 'consent_widget'}
							<span class="screen__check"><i></i>{extra?.text || part.label}</span>
						{:else if part.kind === 'security_verification'}
							<span class="screen__captcha"
								><Icon name="shieldCheck" />{extra?.text || part.label}</span
							>
						{:else if part.kind === 'divider'}
							<span class="screen__divider"><span>{part.label}</span></span>
						{:else if part.kind === 'link' || part.kind === 'auth_switch_link'}
							<span class="screen__link">{part.label}</span>
						{:else if part.kind === 'guest_login_widget'}
							<span class="screen__button screen__button--quiet">{part.label}</span>
						{:else if ACCOUNT_KINDS.has(part.kind)}
							{@const def = partKind(part.kind)}
							<span class="screen__widget">
								{#if def}<Icon name={def.icon} />{/if}
								<span>{part.label}</span>
							</span>
						{:else}
							<p>{part.label}</p>
						{/if}
					{/each}
				</div>
			{/each}
		</div>
	{/each}
</div>

<style>
	.screen {
		display: grid;
		gap: 12px;
		max-width: 520px;
		margin: 0 auto;
		color: var(--ol-text, var(--text-primary));
		font-size: var(--preview-fs-body, var(--fs-body));
	}

	.screen--wide {
		max-width: 720px;
	}

	.screen__row {
		display: grid;
		grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
		gap: 10px;
	}

	.screen__col {
		display: grid;
		align-content: start;
		gap: 10px;
	}

	h2 {
		margin: 0;
		color: var(--ol-title, var(--text-primary));
		font-size: var(--preview-fs-heading, var(--fs-title-lg));
		font-weight: var(--fw-semibold);
		text-align: center;
	}

	p {
		margin: 0;
		color: var(--ol-copy, var(--text-secondary));
		text-align: center;
	}

	.screen__button {
		display: block;
		padding: 10px 12px;
		border: 1px solid var(--ol-accent, var(--border-strong));
		border-radius: var(--ol-button-radius, var(--radius-control));
		background: var(--ol-accent, var(--bg-card));
		color: var(--ol-accent-text, var(--text-primary));
		font-weight: var(--fw-semibold);
		text-align: center;
	}

	.screen__button--quiet {
		border-style: dashed;
		border-color: var(--ol-text, var(--border-strong));
		background: var(--ol-card, var(--bg-card));
		color: var(--ol-text, var(--text-primary));
	}

	.screen__divider {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--ol-copy, var(--text-muted));
		font-size: var(--fs-caption);
	}

	.screen__divider::before,
	.screen__divider::after {
		flex: 1;
		height: 1px;
		background: var(--ol-copy, var(--border));
		content: '';
	}

	.screen__field {
		display: grid;
		gap: 4px;
		color: var(--ol-text, var(--text-secondary));
		font-size: var(--fs-caption);
		font-weight: var(--fw-semibold);
	}

	.screen__field i {
		display: flex;
		align-items: center;
		height: 34px;
		padding: 0 10px;
		border: 1px solid var(--ol-text, var(--border-strong));
		border-radius: var(--ol-field-radius, var(--radius-control));
		background: var(--ol-field, var(--bg-input));
		color: var(--ol-field-text, var(--text-muted));
		font-style: normal;
		font-weight: var(--fw-regular);
	}

	.screen__field small {
		color: var(--ol-copy, var(--text-muted));
		font-weight: var(--fw-regular);
	}

	.screen__check {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--ol-text, var(--text-secondary));
	}

	.screen__check i {
		width: 16px;
		height: 16px;
		border: 1.5px solid var(--ol-text, var(--border-strong));
		border-radius: 4px;
	}

	.screen__field .screen__select::after {
		margin-inline-start: auto;
		content: '▾';
	}

	.screen__check .screen__dot {
		border-radius: 50%;
	}

	.screen__code {
		display: flex;
		justify-content: center;
		gap: 6px;
	}

	.screen__code i {
		width: 34px;
		height: 40px;
		border: 1px solid var(--ol-text, var(--border-strong));
		border-radius: var(--ol-field-radius, var(--radius-control));
		background: var(--ol-field, var(--bg-input));
	}

	.screen__captcha,
	.screen__widget {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--ol-text, var(--border));
		border-radius: var(--ol-control-radius, var(--radius-control));
		background: var(--ol-card, var(--bg-card));
		color: var(--ol-text, var(--text-secondary));
		--icon-size: var(--icon-lg);
	}

	.screen__link {
		color: var(--ol-link, var(--info));
		text-align: center;
		text-decoration: underline;
	}
</style>
