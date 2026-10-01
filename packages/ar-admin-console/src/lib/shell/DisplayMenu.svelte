<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import type { IconName } from '$lib/ui/icons/icons';
	import Popover from '$lib/ui/patterns/Popover.svelte';
	import { theme, type ThemeLook, type ThemeMode } from '$lib/ui/theme/theme.svelte';
	import TimeSettings from '$lib/ui/time/TimeSettings.svelte';

	const MODES: Array<{
		id: ThemeMode;
		icon: IconName;
		label: 'theme.mode.system' | 'theme.mode.light' | 'theme.mode.dark';
	}> = [
		{ id: 'system', icon: 'device', label: 'theme.mode.system' },
		{ id: 'light', icon: 'sun', label: 'theme.mode.light' },
		{ id: 'dark', icon: 'moon', label: 'theme.mode.dark' }
	];

	const LOOKS: Array<{
		id: ThemeLook;
		label: 'theme.look.standard' | 'theme.look.swissGrid' | 'theme.look.frosted';
	}> = [
		{ id: 'standard', label: 'theme.look.standard' },
		{ id: 'swiss-grid', label: 'theme.look.swissGrid' },
		{ id: 'frosted', label: 'theme.look.frosted' }
	];

	const modeIcon = $derived(MODES.find((m) => m.id === theme.mode)?.icon ?? 'device');
</script>

<Popover label={t('theme.settings')} align="end" variant="icon" width="320px">
	{#snippet trigger()}<Icon name={modeIcon} />{/snippet}
	<fieldset class="group">
		<legend>{t('theme.mode')}</legend>
		<div class="modes">
			{#each MODES as mode (mode.id)}
				<button
					type="button"
					class="mode"
					aria-pressed={theme.mode === mode.id}
					onclick={() => theme.setMode(mode.id)}
				>
					<Icon name={mode.icon} />
					<span>{t(mode.label)}</span>
				</button>
			{/each}
		</div>
	</fieldset>
	<fieldset class="group">
		<legend>{t('theme.look')}</legend>
		{#each LOOKS as look (look.id)}
			<label class="look">
				<input
					type="radio"
					name="console-look"
					value={look.id}
					checked={theme.look === look.id}
					onchange={() => theme.setLook(look.id)}
				/>
				<span class="look__swatch look__swatch--{look.id}" aria-hidden="true"></span>
				<span>{t(look.label)}</span>
			</label>
		{/each}
	</fieldset>
	<fieldset class="group">
		<legend>{t('time.title')}</legend>
		<TimeSettings />
	</fieldset>
</Popover>

<style>
	.group {
		margin: 0;
		padding: 6px 6px 8px;
		border: 0;
	}

	.group + .group {
		border-top: 1px solid var(--border-subtle);
	}

	legend {
		padding: 4px 2px 8px;
		color: var(--text-muted);
		font-size: var(--fs-overline);
		font-weight: var(--fw-bold);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.modes {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 4px;
		padding: 2px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
	}

	.mode {
		display: grid;
		justify-items: center;
		gap: 3px;
		padding: 7px 4px;
		border: 0;
		border-radius: calc(var(--radius-control) - 2px);
		background: transparent;
		color: var(--text-secondary);
		font-size: var(--fs-small);
		--icon-size: var(--icon-md);
	}

	.mode[aria-pressed='true'] {
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	.look {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 7px 4px;
		border-radius: var(--radius-control);
		font-size: var(--fs-body);
		cursor: pointer;
	}

	.look:hover {
		background: var(--bg-hover);
	}

	.look input {
		margin: 0;
		accent-color: var(--primary);
	}

	/* Swatches preview each look regardless of the active theme. */
	.look__swatch {
		width: 22px;
		height: 16px;
		border: 1px solid var(--border-strong);
	}

	.look__swatch--standard {
		border-radius: 5px;
		background: linear-gradient(135deg, var(--swatch-standard-a) 50%, var(--swatch-standard-b) 50%);
	}

	.look__swatch--swiss-grid {
		border-radius: 0;
		background: linear-gradient(135deg, var(--swatch-swiss-a) 50%, var(--swatch-swiss-b) 50%);
	}

	.look__swatch--frosted {
		border-radius: 6px;
		background: linear-gradient(135deg, var(--swatch-frosted-a) 45%, var(--swatch-frosted-b));
	}
</style>
