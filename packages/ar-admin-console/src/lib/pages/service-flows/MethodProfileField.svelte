<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type {
		AuthenticationMethodProfile,
		AuthenticationMethodValues
	} from '#lib/api/authentication-method-profiles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AuthenticationMethodFields from '#lib/pages/authentication/AuthenticationMethodFields.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { useFlowResources } from './flow-resources-context';

	/**
	 * Choosing the sign-in method profile a flow uses. The chosen profile is shown below, as it is
	 * (it is shared, so it is changed on its own page, not here). A new one can be made in place;
	 * it is saved as a profile straight away, so other flows can use it too, and it is chosen.
	 */
	interface Props {
		label: string;
		hint?: string;
		required?: boolean;
		/** The id of the chosen profile; empty when none is. */
		value: string;
		onchange: (id: string) => void;
	}

	let { label, hint, required = false, value, onchange }: Props = $props();

	const { methodProfiles: client, canCreateProfile: canCreate } = useFlowResources();
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let profiles = $state<AuthenticationMethodProfile[]>([]);
	let gone = false;
	onDestroy(() => (gone = true));

	async function load() {
		phase = 'loading';
		try {
			const list = await client.list();
			if (gone) return;
			profiles = list;
			phase = 'ready';
		} catch {
			if (!gone) phase = 'failed';
		}
	}
	onMount(() => void load());

	const chosen = $derived(profiles.find((profile) => profile.id === value));
	// A platform profile is named as one (a native select cannot hold a badge).
	const options = $derived(
		profiles.map((profile) => ({
			value: profile.id,
			label:
				profile.layer?.scope === 'platform'
					? t('pl.optionPlatform', { name: profile.name })
					: profile.name
		}))
	);

	// Making a new profile in place.
	let creating = $state(false);
	let name = $state('');
	let nameError = $state('');
	let values = $state<AuthenticationMethodValues>({});
	let busy = $state(false);
	let form = $state<HTMLElement>();
	const focusName = () => form?.querySelector<HTMLInputElement>('input')?.focus();

	async function startCreating() {
		busy = true;
		try {
			// A new profile starts from the tenant's default one, as on the profile page.
			const base = await client.get('default');
			if (gone) return;
			values = structuredClone(base.values);
		} catch {
			if (gone) return;
			values = {};
		} finally {
			busy = false;
		}
		name = '';
		nameError = '';
		creating = true;
		await tick();
		focusName();
	}

	async function create() {
		if (busy) return;
		const trimmed = name.trim();
		if (!trimmed) {
			nameError = t('am.page.nameRequired');
			focusName();
			return;
		}
		busy = true;
		try {
			const profile = await client.create({
				name: trimmed,
				values: structuredClone($state.snapshot(values))
			});
			if (gone) return;
			profiles = [...profiles, profile];
			creating = false;
			onchange(profile.id);
			toast.success(t('af.profile.created'));
		} catch (error) {
			if (gone) return;
			if (error instanceof ApiError && error.body.error === 'profile_name_taken') {
				nameError = t('am.page.nameTaken');
				focusName();
				return;
			}
			if (error instanceof ApiError && error.code === 'profile_creation_not_allowed') {
				toast.error(t('pl.creationNotAllowed'));
				return;
			}
			toast.error(t('am.page.saveFailed'));
		} finally {
			busy = false;
		}
	}
</script>

{#if phase === 'loading'}
	<LoadingState label={t('common.loading')} />
{:else if phase === 'failed'}
	<Callout tone="warning">
		{t('af.profile.loadFailed')}
		<Button size="sm" onclick={load}>{t('common.retry')}</Button>
	</Callout>
{:else}
	<SelectRow
		{label}
		{required}
		{hint}
		placeholder={t('af.choose')}
		{value}
		onchange={(id) => onchange(id)}
		{options}
		disabled={creating}
	/>
	{#if creating}
		<section class="profile" aria-labelledby="new-method-profile" bind:this={form}>
			<h3 class="profile__title" id="new-method-profile">{t('af.profile.newTitle')}</h3>
			<TextRow
				label={t('am.page.name')}
				required
				maxlength={80}
				bind:value={name}
				error={nameError || undefined}
				oninput={() => (nameError = '')}
			/>
			<AuthenticationMethodFields
				{values}
				canWrite
				level={3}
				describe={false}
				onchange={(key, checked) => (values = { ...values, [key]: checked })}
			/>
			<div class="profile__actions">
				<Button variant="primary" size="sm" disabled={busy} onclick={create}
					>{t('af.profile.saveAndChoose')}</Button
				>
				<Button variant="ghost" size="sm" disabled={busy} onclick={() => (creating = false)}
					>{t('common.cancel')}</Button
				>
			</div>
		</section>
	{:else}
		{#if canCreate()}
			<div>
				<Button icon="plus" size="sm" disabled={busy} onclick={startCreating}
					>{t('af.profile.create')}</Button
				>
			</div>
		{/if}
		{#if chosen}
			<section class="profile" aria-labelledby="chosen-method-profile">
				<h3 class="profile__title" id="chosen-method-profile">
					{t('af.profile.chosen', { name: chosen.name })}
				</h3>
				<AuthenticationMethodFields
					values={chosen.values}
					canWrite={false}
					level={3}
					describe={false}
					onchange={() => {}}
				/>
			</section>
		{/if}
	{/if}
{/if}

<style>
	.profile {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
	}

	.profile__title {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.profile__actions {
		display: flex;
		gap: var(--space-related);
	}
</style>
