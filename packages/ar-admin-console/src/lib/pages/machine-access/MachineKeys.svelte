<script lang="ts">
	import type { MachineAccess } from '#lib/access/access.js';
	import {
		MACHINE_KEY_ALGORITHMS,
		type MachineAccessClient,
		type MachineKey,
		type MachinePrincipal
	} from '#lib/api/machine-access.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ConfirmDialog from '#lib/ui/patterns/ConfirmDialog.svelte';
	import DataTable from '#lib/ui/patterns/DataTable.svelte';
	import Disclosure from '#lib/ui/patterns/Disclosure.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FormDialog from '#lib/ui/patterns/FormDialog.svelte';
	import Badge from '#lib/ui/primitives/Badge.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import NumberField from '#lib/ui/primitives/NumberField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import DateTime from '#lib/ui/time/DateTime.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { machineErrorKey } from './machine-errors';
	import {
		checkPublicJwk,
		keyExpiry,
		keyNotYetValid,
		keyUsable,
		type JwkProblem
	} from './machine-model';

	/**
	 * The keys a machine signs in with. A machine proves itself by signing a short statement with
	 * its private key (private_key_jwt); Authrim keeps only the public key. Adding a key takes the
	 * key's id and the pasted public key; everything else is under "Advanced settings". A key is
	 * replaced by adding the new one and then revoking the old one.
	 */
	interface Props {
		client: MachineAccessClient;
		principal: MachinePrincipal;
		access: MachineAccess;
		onchanged: () => void;
	}

	let { client, principal, access, onchanged }: Props = $props();

	let adding = $state(false);
	let busy = $state(false);
	let kid = $state('');
	let jwkText = $state('');
	let alg = $state('');
	let keyName = $state('');
	let days = $state<number | null>(null);
	let daysInvalid = $state(false);
	let advancedOpen = $state(false);
	let kidError = $state('');
	let jwkError = $state('');
	let advancedError = $state('');
	let error = $state('');
	let formKey = $state(0);
	let revoking = $state<MachineKey | null>(null);

	function openAdd() {
		kid = jwkText = alg = keyName = '';
		days = null;
		daysInvalid = false;
		advancedOpen = false;
		kidError = jwkError = advancedError = error = '';
		formKey += 1;
		adding = true;
	}

	const JWK_PROBLEM: Record<JwkProblem, Parameters<typeof t>[0]> = {
		empty: 'mc.key.jwk.empty',
		notJson: 'mc.key.jwk.notJson',
		notObject: 'mc.key.jwk.notObject',
		private: 'mc.key.jwk.private',
		keyType: 'mc.key.jwk.keyType',
		algorithm: 'mc.key.jwk.algorithm',
		use: 'mc.key.jwk.use',
		keyOps: 'mc.key.jwk.keyOps'
	};

	async function add() {
		kidError = jwkError = advancedError = error = '';
		if (!kid.trim()) kidError = t('mc.key.kidRequired');
		const checked = checkPublicJwk(jwkText, alg as '' | (typeof MACHINE_KEY_ALGORITHMS)[number]);
		if (!checked.ok) {
			jwkError = t(JWK_PROBLEM[checked.problem]);
			// A key that does not fit the chosen algorithm is fixed in the folded part.
			if (checked.problem === 'algorithm' && alg) {
				advancedError = t('mc.key.jwk.algorithm');
				advancedOpen = true;
			}
		}
		if (daysInvalid) {
			advancedError = t('mc.key.daysInvalid');
			advancedOpen = true;
		}
		if (kidError || jwkError || advancedError || !checked.ok) return;
		busy = true;
		try {
			const expiresAt = keyExpiry(days);
			await client.addKey(principal.id, {
				kid,
				displayName: keyName.trim() || kid.trim(),
				alg: checked.alg,
				publicJwk: checked.jwk,
				...(expiresAt !== undefined ? { expiresAt } : {})
			});
			adding = false;
			toast.success(t('mc.toast.keyAdded', { kid: kid.trim() }));
			onchanged();
		} catch (failure) {
			const key = machineErrorKey(failure);
			error = t(key === 'mc.error.conflict' ? 'mc.key.kidTaken' : key);
		} finally {
			busy = false;
		}
	}

	async function revoke() {
		const key = revoking;
		if (!key) return;
		busy = true;
		try {
			await client.revokeKey(principal.id, key.id);
			revoking = null;
			toast.success(t('mc.toast.keyRevoked', { kid: key.kid }));
			onchanged();
		} catch (failure) {
			revoking = null;
			toast.error(t(machineErrorKey(failure)));
			onchanged();
		} finally {
			busy = false;
		}
	}

	const columns = $derived([
		{ key: 'kid', label: t('mc.key.col.kid') },
		{ key: 'alg', label: t('mc.key.col.alg'), width: '12%' },
		{ key: 'status', label: t('mc.key.col.status'), width: '16%' },
		{ key: 'expires', label: t('mc.key.col.expires'), width: '20%' },
		{ key: 'actions', label: t('mc.key.col.actions'), width: '14%', hideLabel: true }
	]);

	const algOptions = $derived([
		{ value: '', label: t('mc.key.algAuto') },
		...MACHINE_KEY_ALGORITHMS.map((value) => ({ value, label: value }))
	]);

	function statusLabel(key: MachineKey): { text: string; tone: 'success' | 'neutral' | 'warning' } {
		if (key.status === 'revoked') return { text: t('mc.key.status.revoked'), tone: 'neutral' };
		if (keyNotYetValid(key)) return { text: t('mc.key.status.notYet'), tone: 'warning' };
		if (key.status === 'expired' || !keyUsable(key)) {
			return { text: t('mc.key.status.expired'), tone: 'neutral' };
		}
		if (key.status === 'rotating') return { text: t('mc.key.status.rotating'), tone: 'warning' };
		return { text: t('mc.key.status.active'), tone: 'success' };
	}
</script>

<Card title={t('mc.key.title')} description={t('mc.key.desc')} flush>
	{#snippet actions()}
		{#if access.write}
			<Button size="sm" icon="plus" onclick={openAdd}>{t('mc.key.add')}</Button>
		{/if}
	{/snippet}
	<DataTable caption={t('mc.key.title')} {columns} rows={principal.keys} rowKey={(row) => row.id}>
		{#snippet cell(row, column)}
			{#if column.key === 'kid'}
				<code>{row.kid}</code>
			{:else if column.key === 'alg'}
				{row.alg}
			{:else if column.key === 'status'}
				{@const status = statusLabel(row)}
				<Badge tone={status.tone} dot>{status.text}</Badge>
				{#if keyNotYetValid(row) && row.notBefore !== null}
					<DateTime value={row.notBefore} stacked />
				{/if}
			{:else if column.key === 'expires'}
				{#if row.expiresAt === null}{t('mc.key.noEnd')}{:else}<DateTime
						value={row.expiresAt}
						stacked
					/>{/if}
			{:else if access.remove && (row.status === 'active' || row.status === 'rotating')}
				<Button size="sm" variant="danger" onclick={() => (revoking = row)}>
					{t('mc.key.revoke')}
				</Button>
			{/if}
		{/snippet}
		{#snippet empty()}
			<EmptyState icon="key" title={t('mc.key.empty')} description={t('mc.key.emptyBody')} />
		{/snippet}
	</DataTable>
</Card>

<FormDialog
	open={adding}
	title={t('mc.key.new.title')}
	submitLabel={t('mc.key.new.submit')}
	{busy}
	{error}
	onsubmit={add}
	oncancel={() => (adding = false)}
>
	{#key formKey}
		<Callout>{t('mc.key.new.note')}</Callout>
		<TextField
			label={t('mc.key.kid')}
			required
			maxlength={128}
			hint={t('mc.key.kidHint')}
			error={kidError}
			bind:value={kid}
		/>
		<TextArea
			label={t('mc.key.jwk')}
			required
			mono
			hint={t('mc.key.jwkHint')}
			error={jwkError}
			bind:value={jwkText}
		/>
		<Disclosure
			title={t('mc.advanced')}
			description={t('mc.key.advancedDesc')}
			bind:open={advancedOpen}
			boxed
		>
			<Select
				label={t('mc.key.alg')}
				hint={t('mc.key.algHint')}
				options={algOptions}
				bind:value={alg}
			/>
			<TextField
				label={t('mc.key.name')}
				maxlength={100}
				hint={t('mc.key.nameHint')}
				bind:value={keyName}
			/>
			<NumberField
				label={t('mc.key.days')}
				unit={t('mc.key.daysUnit')}
				min={1}
				hint={t('mc.key.daysHint')}
				error={advancedError}
				bind:value={days}
				bind:invalid={daysInvalid}
			/>
		</Disclosure>
	{/key}
</FormDialog>

<ConfirmDialog
	open={revoking !== null}
	title={t('mc.key.revokeTitle', { kid: revoking?.kid ?? '' })}
	body={t('mc.key.revokeBody')}
	confirmLabel={t('mc.key.revoke')}
	tone="danger"
	{busy}
	onconfirm={revoke}
	oncancel={() => (revoking = null)}
/>

<style>
	code {
		font-family: var(--font-mono);
		font-size: var(--fs-small);
	}
</style>
