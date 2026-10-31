<script lang="ts">
	/**
	 * RuntimeScreen with the state the login route keeps for it, so a story can type, tick and
	 * click. Every callback is also reported through `onAction` (wired to the Actions panel).
	 */
	import RuntimeScreen from '$lib/components/RuntimeScreen.svelte';
	import { untrack } from 'svelte';
	import {
		allMethods,
		consentPolicy as sampleConsentPolicy,
		destinationFieldConsent,
		externalProviders as sampleProviders,
		type SampleScreen
	} from './fixtures';
	import ScreenCard from './ScreenCard.svelte';

	type RuntimeScreenProps = NonNullable<Parameters<typeof RuntimeScreen>[1]>;

	type Props = {
		screen: SampleScreen;
		mode?: 'login' | 'signup';
		/** Methods the tenant has switched off; everything else is available. */
		unavailable?: string[];
		/** Methods currently waiting on the server. */
		busy?: string[];
		providers?: boolean;
		/** How many of the sample external providers to offer. */
		providerCount?: number;
		guest?: boolean;
		guestRetention?: string;
		withConsent?: boolean;
		withDestinationFields?: boolean;
		humanVerification?: boolean;
		humanVerificationVisible?: boolean;
		values?: Record<string, string | boolean>;
		errors?: Record<string, string>;
		disabled?: boolean;
		headingOverride?: string | null;
		/** Wrap in the page container and card; off when a page shell already provides them. */
		framed?: boolean;
		onAction?: (name: string, detail?: unknown) => void;
	} & Partial<Pick<RuntimeScreenProps, 'consentReady' | 'emailVerificationProtocolEnabled'>>;

	let {
		screen,
		mode = 'login',
		unavailable = [],
		busy = [],
		providers = true,
		providerCount = sampleProviders.length,
		guest = true,
		guestRetention = '',
		withConsent = false,
		withDestinationFields = false,
		humanVerification = false,
		humanVerificationVisible = false,
		values = {},
		errors = {},
		disabled = false,
		headingOverride = null,
		framed = true,
		consentReady = true,
		emailVerificationProtocolEnabled = false,
		onAction
	}: Props = $props();

	let fieldValues = $state<Record<string, string | boolean>>(untrack(() => ({ ...values })));
	let decisions = $state<Record<string, boolean>>({});
	let destinationDecisions = $state<Record<string, boolean>>({});
	let selected = $state<Record<string, string>>({});
	let token = $state('');

	const methodAvailability = $derived(
		Object.fromEntries(
			Object.entries(allMethods).map(([method]) => [method, !unavailable.includes(method)])
		)
	);
	const methodLoading = $derived(
		Object.fromEntries(busy.map((method) => [method, true])) as Record<string, boolean>
	);

	const wide = $derived(screen.settings?.canvas_layout === 'wide');
</script>

{#snippet runtime()}
	<RuntimeScreen
		{screen}
		{disabled}
		{headingOverride}
		authMethodMode={mode}
		{methodAvailability}
		{methodLoading}
		externalProviders={providers ? sampleProviders.slice(0, providerCount) : []}
		guestEnabled={guest}
		guestRetentionDescription={guestRetention}
		onGuestLogin={() => onAction?.('guest')}
		{fieldValues}
		fieldErrors={errors}
		consentPolicy={withConsent ? sampleConsentPolicy : null}
		consentDecisions={decisions}
		destinationFieldConsent={withDestinationFields ? destinationFieldConsent : null}
		destinationFieldDecisions={destinationDecisions}
		consentSelectedValues={selected}
		{consentReady}
		humanVerificationRequired={humanVerification}
		humanVerificationSiteKey={humanVerification ? 'storybook-site-key' : null}
		{humanVerificationVisible}
		bind:humanVerificationToken={token}
		{emailVerificationProtocolEnabled}
		onFieldValueChange={(field, value) => {
			fieldValues[field] = value;
			onAction?.('field', { field, value });
		}}
		onAuthAction={(method, action) => onAction?.('auth', { method, action })}
		onExternalProviderAction={(id) => onAction?.('provider', id)}
		onConsentDecisionChange={(id, checked) => {
			decisions[id] = checked;
			onAction?.('consent', { id, checked });
		}}
		onDestinationFieldDecisionChange={(key, checked) => {
			destinationDecisions[key] = checked;
			onAction?.('destination-field', { key, checked });
		}}
		onConsentSelectedValueChange={(id, value) => {
			selected[id] = value;
			onAction?.('consent-choice', { id, value });
		}}
	/>
{/snippet}

{#if framed}
	<ScreenCard {wide}>
		{@render runtime()}
	</ScreenCard>
{:else}
	{@render runtime()}
{/if}
