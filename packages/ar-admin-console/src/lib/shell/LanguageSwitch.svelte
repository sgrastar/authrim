<script lang="ts">
	import { i18n, t } from '$lib/i18n/i18n.svelte';
	import { LOCALE_LABELS, SUPPORTED_LOCALES } from '$lib/i18n/locales';
	import { useBusy } from '$lib/ui/busy/busy';
	import { changeLanguage } from './language';

	const busy = useBusy();
</script>

<div class="lang" role="group" aria-label={t('app.language')}>
	{#each SUPPORTED_LOCALES as locale (locale)}
		<button
			type="button"
			lang={locale}
			title={LOCALE_LABELS[locale].native}
			aria-label={LOCALE_LABELS[locale].native}
			aria-pressed={i18n.locale === locale}
			disabled={busy()}
			onclick={() => changeLanguage(locale)}>{LOCALE_LABELS[locale].short}</button
		>
	{/each}
</div>

<style>
	.lang {
		display: inline-flex;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
	}

	button {
		height: 30px;
		padding: 0 9px;
		border: 0;
		background: transparent;
		color: var(--text-secondary);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
	}

	button:hover {
		color: var(--text-primary);
	}

	button[aria-pressed='true'] {
		background: var(--primary);
		color: var(--text-inverse);
	}
</style>
