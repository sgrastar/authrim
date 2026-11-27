<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ListField from '#lib/ui/patterns/ListField.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import TextAreaRow from '#lib/ui/patterns/TextAreaRow.svelte';
	import { permissionProblem, tierChoices, type RoleDraft } from './role-model';

	/**
	 * The editable part of a role: its description, grant tier and permissions. The tiers offered
	 * stop at the admin's ceiling (the API refuses a higher one); the permissions are free
	 * `resource:action` entries, checked as the API checks them.
	 */
	interface Props {
		draft: RoleDraft;
		ceiling: number;
		/** The tier the role had when loaded (kept on offer). */
		savedTier?: number;
		/** The permissions' problem, if any. */
		permissionsError?: string;
		/** True while an entry is not a valid permission. */
		permissionsInvalid?: boolean;
		/** The name row, for a new role (set once). */
		name?: Snippet;
	}

	let {
		draft = $bindable(),
		ceiling,
		savedTier,
		permissionsError,
		permissionsInvalid = $bindable(false),
		name
	}: Props = $props();

	const tiers = $derived(tierChoices(ceiling, savedTier));
</script>

<Card title={t('eur.d.profile')}>
	<RowStack>
		{@render name?.()}
		<TextAreaRow label={t('eur.new.description')} maxlength={500} bind:value={draft.description} />
		<SelectRow
			label={t('eur.new.tier')}
			info={t('eur.new.tierInfo')}
			hint={t('eur.ceiling', { ceiling })}
			options={tiers.map((tier) => ({
				value: String(tier),
				label: t('eur.tier.option', { tier }),
				description: t(tier === 1 ? 'eur.tier.1' : tier === 2 ? 'eur.tier.2' : 'eur.tier.3')
			}))}
			bind:value={
				() => String(draft.grant_tier), (value) => (draft.grant_tier = Number(value) || 1)
			}
		/>
	</RowStack>
</Card>

<Card
	title={t('eur.new.permissions')}
	description={permissionsError ?? t('eur.new.permissionsHint')}
>
	<ListField
		label={t('eur.new.permissions')}
		placeholder="documents:read"
		addLabel={t('eur.new.addPermission')}
		mono
		validate={(value) => {
			const problem = permissionProblem(value);
			return problem ? t(problem) : undefined;
		}}
		bind:invalid={permissionsInvalid}
		bind:values={draft.permissions}
	/>
</Card>
