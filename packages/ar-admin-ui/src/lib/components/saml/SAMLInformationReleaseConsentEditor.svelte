<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import type {
		InformationReleaseAsk,
		InformationReleaseConsentSetting
	} from '#lib/api/admin-clients.js';

	interface Props {
		/** The saved setting; null/absent shows the default (ask once, show values). */
		value?: InformationReleaseConsentSetting | null;
		onChange: (next: InformationReleaseConsentSetting) => void;
		idPrefix?: string;
	}

	let { value = null, onChange, idPrefix = 'saml-information-release' }: Props = $props();

	const DEFAULT_SETTING: InformationReleaseConsentSetting = {
		enabled: true,
		ask: 'once',
		show_values: true,
		purpose_statement_id: null
	};

	const current = $derived<InformationReleaseConsentSetting>({
		...DEFAULT_SETTING,
		...(value ?? {})
	});

	function update(patch: Partial<InformationReleaseConsentSetting>) {
		onChange({ ...current, ...patch });
	}
</script>

<div class="information-release-editor">
	<span class="admin-field__label">{$LL.admin_client_detail_information_release_consent()}</span>
	<label class="information-release-editor__check">
		<input
			type="checkbox"
			checked={current.enabled}
			onchange={(event) => update({ enabled: event.currentTarget.checked })}
		/>
		{$LL.admin_client_detail_information_release_consent_enabled()}
	</label>
	{#if current.enabled}
		<label class="admin-field__label" for="{idPrefix}-ask"
			>{$LL.admin_client_detail_information_release_consent_ask()}</label
		>
		<select
			id="{idPrefix}-ask"
			class="admin-select"
			value={current.ask}
			onchange={(event) => update({ ask: event.currentTarget.value as InformationReleaseAsk })}
		>
			<option value="once">{$LL.admin_client_detail_information_release_consent_ask_once()}</option>
			<option value="every_time"
				>{$LL.admin_client_detail_information_release_consent_ask_every_time()}</option
			>
			<option value="when_items_change"
				>{$LL.admin_client_detail_information_release_consent_ask_when_items_change()}</option
			>
		</select>
		<label class="information-release-editor__check">
			<input
				type="checkbox"
				checked={current.show_values}
				onchange={(event) => update({ show_values: event.currentTarget.checked })}
			/>
			{$LL.admin_client_detail_information_release_consent_show_values()}
		</label>
		<label class="admin-field__label" for="{idPrefix}-purpose"
			>{$LL.admin_client_detail_information_release_consent_purpose()}</label
		>
		<input
			id="{idPrefix}-purpose"
			type="text"
			class="admin-input"
			value={current.purpose_statement_id ?? ''}
			oninput={(event) =>
				update({ purpose_statement_id: event.currentTarget.value.trim() || null })}
		/>
		<p class="information-release-editor__hint">
			{$LL.admin_client_detail_information_release_consent_purpose_hint()}
		</p>
	{/if}
</div>

<style>
	.information-release-editor {
		display: grid;
		gap: 8px;
	}

	.information-release-editor__check {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--color-text);
		font-size: 0.875rem;
	}

	.information-release-editor__hint {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		line-height: 1.45;
	}
</style>
