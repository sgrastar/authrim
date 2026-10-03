<script lang="ts">
	/**
	 * A flow-runtime step that has no Admin console screen: its title and description, the consent
	 * items and destination fields to answer when it is a consent step, and Continue. Shared by the
	 * login and signup views; the route submits the answers.
	 */
	import { Alert, Button, SanitizedHtml } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import { isValidLinkUrl } from '$lib/utils/url-validation';
	import type { RuntimeStepView } from '../auth-entry-types';
	import { getRuntimeConsentItemHtml, getRuntimeConsentOptionHtml } from './runtime-consent';

	type Props = {
		step: RuntimeStepView;
		/**
		 * Draw radio-choice items as radios and display-only items as text, as the login page does.
		 * Off, every item that takes an answer is a checkbox (the signup page).
		 */
		choiceItems?: boolean;
		decisions?: Record<string, boolean>;
		destinationFieldDecisions?: Record<string, boolean>;
		selectedValues?: Record<string, string>;
		consentReady?: boolean;
		/** The step is being submitted. */
		loading?: boolean;
		/** Any action on the page is in progress. */
		busy?: boolean;
		/** Actions are unavailable (in progress, or the authorization request cannot continue). */
		disabled?: boolean;
		onDestinationFieldDecisionChange?: (fieldKey: string, checked: boolean) => void;
		onSelectedValueChange?: (statementId: string, value: string) => void;
		/** Continue on a consent step, with the answers. */
		onAccept?: () => void;
		/** Continue on any other step. */
		onComplete?: () => void;
	};

	let {
		step,
		choiceItems = false,
		decisions = $bindable({}),
		destinationFieldDecisions = {},
		selectedValues = {},
		consentReady = true,
		loading = false,
		busy = false,
		disabled = false,
		onDestinationFieldDecisionChange,
		onSelectedValueChange,
		onAccept,
		onComplete
	}: Props = $props();
</script>

<Alert variant="info" class="mb-4">
	<div class="space-y-3">
		<div>
			<p class="font-semibold">{step.title}</p>
			{#if step.description}
				<p class="text-sm mt-1" style="color: var(--text-secondary);">
					{step.description}
				</p>
			{/if}
		</div>
		{#if step.component === 'consent_policy'}
			{@const consentPolicy = step.consentPolicy}
			{@const destinationFieldConsent = step.destinationFieldConsent}
			{#if destinationFieldConsent?.fields.length}
				<div class="space-y-3">
					{#each destinationFieldConsent.fields as destinationField (destinationField.key)}
						<label class="runtime-consent-choice">
							<input
								type="checkbox"
								checked={destinationField.required ||
									destinationFieldDecisions[destinationField.key] === true}
								required={destinationField.required}
								disabled={destinationField.required}
								onchange={(event) =>
									onDestinationFieldDecisionChange?.(
										destinationField.key,
										(event.currentTarget as HTMLInputElement).checked
									)}
							/>
							<span>{destinationField.label}{destinationField.required ? ' *' : ''}</span>
						</label>
					{/each}
				</div>
			{/if}
			{#if consentPolicy?.items.length}
				<div class="space-y-3">
					{#each consentPolicy.items as item (item.statement_id)}
						<div class="runtime-consent-item">
							{#if choiceItems && item.content_mode === 'radio' && item.options?.length}
								<fieldset class="runtime-consent-options">
									<legend class="sr-only">{item.title}</legend>
									{#each item.options as option (option.id)}
										<label class="runtime-consent-choice">
											<input
												type="radio"
												name={`runtime-consent-${item.statement_id}`}
												value={option.value}
												checked={selectedValues[item.statement_id] === option.value}
												required={item.is_required}
												onchange={() => onSelectedValueChange?.(item.statement_id, option.value)}
											/>
											<SanitizedHtml
												class="runtime-consent-content"
												sanitizedHtml={getRuntimeConsentOptionHtml(option)}
											/>
										</label>
									{/each}
								</fieldset>
							{:else if item.checkbox_mode === 'none' || (choiceItems && item.content_mode === 'display_only')}
								<SanitizedHtml
									tag="div"
									class="runtime-consent-content"
									sanitizedHtml={getRuntimeConsentItemHtml(item)}
								/>
							{:else}
								<label class="runtime-consent-choice">
									<input
										type="checkbox"
										bind:checked={decisions[item.statement_id]}
										required={item.is_required || item.checkbox_mode === 'required'}
									/>
									<SanitizedHtml
										class="runtime-consent-content"
										sanitizedHtml={getRuntimeConsentItemHtml(item)}
									/>
								</label>
							{/if}
							{#if item.document_url && isValidLinkUrl(item.document_url)}
								<a
									class="runtime-consent-link"
									href={item.document_url}
									target="_blank"
									rel="noopener noreferrer"
								>
									{item.document_url}
								</a>
							{/if}
						</div>
					{/each}
				</div>
			{:else}
				<p class="text-sm" style="color: var(--text-secondary);">
					{step.description}
				</p>
			{/if}
			<Button
				variant="primary"
				class="w-full"
				{loading}
				disabled={busy || !consentReady}
				onclick={() => onAccept?.()}
			>
				{$LL.common_continue()}
			</Button>
		{:else if step.component === 'completion'}
			<Button variant="primary" class="w-full" {loading} {disabled} onclick={() => onComplete?.()}>
				{$LL.common_continue()}
			</Button>
		{:else}
			<Button
				variant="secondary"
				class="w-full"
				{loading}
				{disabled}
				onclick={() => onComplete?.()}
			>
				{$LL.common_continue()}
			</Button>
		{/if}
	</div>
</Alert>

<style>
	.runtime-consent-item {
		display: grid;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--border-color, var(--border));
		border-radius: 8px;
		background: color-mix(in srgb, var(--surface-color, var(--bg-glass)) 88%, transparent);
	}

	.runtime-consent-choice {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		font-size: 0.92rem;
		line-height: 1.45;
	}

	.runtime-consent-options {
		display: grid;
		gap: 10px;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.runtime-consent-choice input {
		margin-top: 3px;
		flex: 0 0 auto;
	}

	.runtime-consent-link {
		color: var(--accent-color, var(--primary));
		font-size: 0.82rem;
		overflow-wrap: anywhere;
	}
</style>
