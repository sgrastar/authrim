<script lang="ts">
	import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
	import type {
		FederationEntity,
		FederationSource,
		FederationSourcesClient
	} from '#lib/api/federation-sources.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import type { FederationMappingOption } from '../federation-model';

	/**
	 * Gives one entity of the federation a connection of its own ("individual settings"), to send
	 * it other attributes or turn it off on its own. The entity may be one that is set aside. The
	 * connection starts as a draft: until it is enabled on its own page the entity is still
	 * handled through the federation, and from then on the connection wins. An entity that is both
	 * a provider and a service asks which of the two to make.
	 */
	interface Props {
		entity: FederationEntity | null;
		source: FederationSource;
		client: FederationSourcesClient;
		mappingSets: FederationMappingOption[];
		/** The connection exists: open its page. */
		oncreated: (connection: { providerId: string; providerType: 'sp' | 'idp' }) => void;
		oncancel: () => void;
	}
	let { entity, source, client, mappingSets, oncreated, oncancel }: Props = $props();

	let chosen = $state<'sp' | 'idp'>('sp');
	let name = $state('');
	let busy = $state(false);
	let failure = $state('');

	/** Which kind of connection this entity can be: its own role, or a choice when it is both. */
	const providerType = $derived(
		entity?.role === 'saml_sp' ? 'sp' : entity?.role === 'saml_idp' ? 'idp' : chosen
	);
	const defaultSet = $derived(
		providerType === 'sp' ? source.spMappingSetId : source.idpMappingSetId
	);

	/** The mapping set chosen; until one is, the federation's own for that kind. */
	let setId = $derived(defaultSet);

	// A new entity starts from the federation's own choices.
	$effect(() => {
		if (!entity) return;
		chosen = source.roles.includes('saml_sp') || !source.roles.includes('saml_idp') ? 'sp' : 'idp';
		name = entity.displayName ?? '';
		failure = '';
	});

	async function submit() {
		if (!entity || busy) return;
		busy = true;
		failure = '';
		try {
			const made = await client.materialize(source.id, {
				entityId: entity.entityId,
				providerType,
				...(setId ? { fieldMappingSetId: setId } : {}),
				...(name.trim() ? { name: name.trim() } : {})
			});
			oncreated(made);
		} catch (error) {
			failure =
				error instanceof StepUpCancelledError
					? t('settings.stepUpCancelled')
					: error instanceof Error && error.message
						? error.message
						: t('sf.fed.materialize.failed');
		} finally {
			busy = false;
		}
	}
</script>

<FormDialog
	open={entity !== null}
	title={t('sf.fed.materialize.title')}
	description={entity?.entityId}
	submitLabel={t('sf.fed.materialize.submit')}
	{busy}
	error={failure}
	onsubmit={submit}
	{oncancel}
>
	{#if entity?.excluded}<Callout tone="info">{t('sf.fed.materialize.excluded')}</Callout>{/if}
	{#if entity?.role === 'ambiguous'}
		<RadioGroup
			label={t('sf.fed.materialize.type')}
			options={[
				{ value: 'sp', label: t('sf.fed.materialize.asSp') },
				{ value: 'idp', label: t('sf.fed.materialize.asIdp') }
			]}
			value={chosen}
			onchange={(value) => (chosen = value === 'idp' ? 'idp' : 'sp')}
		/>
	{/if}
	<TextField label={t('sf.row.name')} bind:value={name} />
	<Select
		label={t('sf.row.mappingSet')}
		placeholder={t('mc.ro.choose')}
		options={mappingSets}
		bind:value={setId}
	/>
	<Callout tone="info">{t('sf.fed.materialize.draft')}</Callout>
</FormDialog>
