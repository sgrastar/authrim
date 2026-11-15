<script lang="ts">
	import type { MachineReach } from '#lib/api/machine-access.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import CheckboxGroup from '#lib/ui/patterns/CheckboxGroup.svelte';
	import ListField from '#lib/ui/patterns/ListField.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import { permissionProblem } from './machine-model';

	/**
	 * What a machine may do and where: the permissions it holds and the tenants it reaches. Used
	 * when a principal is created and when its access is changed.
	 */
	interface Props {
		permissions: string[];
		reach: MachineReach;
		tenants: ReadonlyArray<{ id: string; name: string }>;
		/** The reach problem to show under the choice. */
		reachError?: string;
		invalid?: boolean;
	}

	let {
		permissions = $bindable(),
		reach = $bindable(),
		tenants,
		reachError,
		invalid = $bindable(false)
	}: Props = $props();

	let mode = $state<string>(reach.mode);
	let chosen = $state<string[]>(reach.mode === 'tenants' ? [...reach.tenantIds] : []);

	$effect(() => {
		reach =
			mode === 'all'
				? { mode: 'all' }
				: mode === 'tenants'
					? { mode: 'tenants', tenantIds: chosen }
					: { mode: 'none' };
	});

	const validate = (value: string) => {
		const problem = permissionProblem(value);
		return problem ? t(`mc.perm.${problem}`) : undefined;
	};
</script>

<ListField
	label={t('mc.f.permissions')}
	hint={t('mc.f.permissionsHint')}
	placeholder="admin:users:read"
	addLabel={t('mc.f.permissionAdd')}
	mono
	{validate}
	bind:values={permissions}
	bind:invalid
/>
<RadioGroup
	label={t('mc.f.reach')}
	bind:value={mode}
	options={[
		{ value: 'none', label: t('mc.reach.none'), description: t('mc.reach.noneDesc') },
		{ value: 'tenants', label: t('mc.reach.tenants'), description: t('mc.reach.tenantsDesc') },
		{ value: 'all', label: t('mc.reach.all'), description: t('mc.reach.allDesc') }
	]}
/>
{#if mode === 'tenants'}
	<CheckboxGroup
		title={t('mc.f.reachTenants')}
		options={tenants.map((tenant) => ({
			value: tenant.id,
			label: tenant.name,
			...(tenant.name !== tenant.id ? { description: tenant.id } : {})
		}))}
		bind:selected={chosen}
	/>
{/if}
{#if reachError}<p class="reach-error" role="alert">{reachError}</p>{/if}

<style>
	.reach-error {
		margin: 0;
		color: var(--danger);
		font-size: var(--fs-small);
	}
</style>
