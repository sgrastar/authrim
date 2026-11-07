<script lang="ts">
	import { untrack } from 'svelte';
	import type { TeamAccess } from '#lib/access/access.js';
	import type {
		AdminTeamClient,
		GroupChoice,
		InvitationInput,
		RoleChoice
	} from '#lib/api/admin-team.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CheckboxRow from '#lib/ui/patterns/CheckboxRow.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import FieldRow from '#lib/ui/patterns/FieldRow.svelte';
	import Form from '#lib/ui/patterns/Form.svelte';
	import ListField from '#lib/ui/patterns/ListField.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import PageHeader from '#lib/ui/patterns/PageHeader.svelte';
	import RowStack from '#lib/ui/patterns/RowStack.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import TextRow from '#lib/ui/patterns/TextRow.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import BackLink from '#lib/ui/primitives/BackLink.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import RadioGroup from '#lib/ui/primitives/RadioGroup.svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { timePreference } from '#lib/ui/time/time-preference.svelte.js';
	import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import { teamErrorKey } from './team-errors';
	import {
		inputTimeToMs,
		invitableRoles,
		invitationProblems,
		scopeFor,
		SUPER_ADMIN_ROLE
	} from './team-model';

	/**
	 * Settings → Administrators → Invite: who to invite, what they get (a role, where it applies,
	 * until when, the admin groups they join) and how the invitation may be accepted (its time
	 * limit, the addresses allowed). Sending checks the fields first; the API checks again and
	 * its refusals are shown above the buttons, with everything typed kept.
	 */
	interface Props {
		client: AdminTeamClient;
		access: TeamAccess;
		/** The tenant the invited admin will belong to (the one selected). */
		tenantId: string;
		/** The team page, where the invitation is listed. */
		listHref: string;
		/** Sent (delivered or not): back to the invitations. */
		onsent: () => void;
		/** Override the zone the role's end is typed in (tests; normally the admin's choice). */
		zone?: TimeZoneMode;
	}

	let { client, access, tenantId, listHref, onsent, zone }: Props = $props();

	let roles = $state<RoleChoice[]>([]);
	let groups = $state<GroupChoice[]>([]);
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	/**
	 * A role for every tenant can be given here: the admin may give one, and the invited admin
	 * will belong to the deployment's default tenant (known to be: when it cannot be read, not).
	 */
	let globalHere = $state(false);

	let email = $state('');
	let name = $state('');
	let roleId = $state('');
	let scope = $state<InvitationInput['scope_type']>('tenant');
	let roleEnds = $state('');
	let groupIds = $state<string[]>([]);
	let expiresIn = $state('24');
	let ipRestricted = $state(false);
	let ipRanges = $state<string[]>([]);

	let sending = $state(false);
	let tried = $state(false);
	let refusal = $state('');

	async function load() {
		phase = 'loading';
		try {
			const [allRoles, allGroups, home] = await Promise.all([
				client.listRoles(),
				client.listGroups(),
				access.global ? client.defaultTenantId() : Promise.resolve(null)
			]);
			globalHere = access.global && home === tenantId;
			roles = invitableRoles(allRoles, globalHere);
			groups = allGroups;
			phase = 'ready';
		} catch {
			phase = 'failed';
		}
	}

	$effect(() => {
		untrack(() => void load());
	});

	const role = $derived(roles.find((item) => item.id === roleId));
	const superAdmin = $derived(role?.name === SUPER_ADMIN_ROLE);
	// The zone the role's end is typed in, fixed when the page opens: changing the display zone
	// meanwhile does not move a time already typed. The field says which zone it is.
	const inZone = untrack(() => zone ?? timePreference.zone);
	/** The field holds something the browser cannot read as a time yet (a date without a time). */
	let roleEndsIncomplete = $state(false);
	const readRoleEnds = (event: Event & { currentTarget: HTMLInputElement }) =>
		(roleEndsIncomplete = event.currentTarget.validity.badInput);

	const input = $derived<InvitationInput>({
		email,
		name,
		role_id: roleId,
		scope_type: scopeFor(role, globalHere ? scope : 'tenant'),
		role_expires_at: inputTimeToMs(roleEnds, inZone),
		expires_in_hours: Number(expiresIn),
		ip_restriction_enabled: ipRestricted,
		allowed_ip_ranges: ipRanges,
		group_ids: groupIds
	});
	const problems = $derived(
		invitationProblems(input, Date.now(), roleEndsIncomplete ? 'incomplete' : roleEnds)
	);
	const shownProblem = (key: keyof typeof problems) =>
		tried && problems[key] ? t(problems[key]) : undefined;

	async function send(event: SubmitEvent) {
		event.preventDefault();
		tried = true;
		refusal = '';
		if (Object.keys(problems).length > 0) return;
		sending = true;
		try {
			const { delivered } = await client.createInvitation(input);
			const done = delivered ? 'tm.toast.invited' : 'tm.toast.invitedNotDelivered';
			(delivered ? toast.success : toast.warning)(t(done, { email: input.email.trim() }));
			onsent();
		} catch (error) {
			refusal = t(teamErrorKey(error));
		} finally {
			sending = false;
		}
	}

	const roleOptions = $derived(
		roles.map((item) => ({
			value: item.id,
			label: item.display_name ? `${item.display_name} (${item.name})` : item.name
		}))
	);
	const scopeOptions = $derived([
		{
			value: 'tenant',
			label: t('tm.new.scope.tenant'),
			description: t('tm.new.scope.tenantBody'),
			disabled: superAdmin
		},
		{ value: 'global', label: t('tm.new.scope.global'), description: t('tm.new.scope.globalBody') }
	]);
	const groupOptions = $derived(
		groups.map((group) => ({
			value: group.id,
			label: group.display_name,
			description: t('tm.new.groupMeta', {
				members: group.member_count,
				grants: group.grant_count
			})
		}))
	);
	const expiryOptions = $derived(
		(['24', '72', '168'] as const).map((hours) => ({
			value: hours,
			label: t(`tm.new.expires.${hours}`)
		}))
	);
</script>

<Page>
	<PageHeader title={t('tm.new.title')} description={t('tm.new.desc')}>
		{#snippet back()}
			<BackLink href={listHref}>{t('tm.new.back')}</BackLink>
		{/snippet}
	</PageHeader>

	{#if !access.inviteForm}
		<EmptyState icon="lock" title={t('tm.new.noAccess')} />
	{:else if phase === 'loading'}
		<LoadingState label={t('common.loading')} />
	{:else if phase === 'failed'}
		<EmptyState icon="warningCircle" title={t('tm.new.loadFailed')}>
			{#snippet action()}
				<Button size="sm" onclick={load}>{t('common.retry')}</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<Form onsubmit={send} label={t('tm.new.title')} busy={sending} novalidate>
			<Card title={t('tm.new.who')}>
				<RowStack>
					<TextRow
						label={t('tm.new.email')}
						type="email"
						autocomplete="off"
						required
						maxlength={254}
						bind:value={email}
						error={shownProblem('email')}
					/>
					<TextRow
						label={t('tm.new.name')}
						hint={t('tm.new.nameHint')}
						maxlength={200}
						bind:value={name}
					/>
				</RowStack>
			</Card>

			<Card title={t('tm.new.access')}>
				<RowStack>
					<SelectRow
						label={t('tm.new.role')}
						options={roleOptions}
						placeholder
						required
						hint={t('tm.new.roleHint')}
						bind:value={roleId}
						error={shownProblem('role')}
					/>
					{#if globalHere}
						<FieldRow label={t('tm.new.scope')} plain>
							<RadioGroup
								label={t('tm.new.scope')}
								hideLabel
								options={scopeOptions}
								value={superAdmin ? 'global' : scope}
								onchange={(value) => (scope = value === 'global' ? 'global' : 'tenant')}
							/>
						</FieldRow>
					{:else if access.global}
						<Callout icon="info">{t('tm.new.globalElsewhere')}</Callout>
					{/if}
					<TextRow
						label={t('tm.new.roleEnds')}
						type="datetime-local"
						hint={`${t('range.zone', { zone: inZone === 'utc' ? 'UTC' : t('range.local') })} ${t('tm.new.roleEndsHint')}`}
						oninput={readRoleEnds}
						onblur={readRoleEnds}
						bind:value={roleEnds}
						error={shownProblem('roleEnds')}
					/>
					{#if groups.length > 0}
						<CheckboxRow
							label={t('tm.new.groups')}
							options={groupOptions}
							hint={shownProblem('groups') ?? t('tm.new.groupsHint')}
							bind:selected={groupIds}
						/>
						<Callout icon="info">{t('tm.new.groupsChanged')}</Callout>
					{:else}
						<FieldRow label={t('tm.new.groups')} align="text" plain>
							<p class="note">{t('tm.new.groupsNone')}</p>
						</FieldRow>
					{/if}
				</RowStack>
			</Card>

			<Card title={t('tm.new.limits')}>
				<RowStack>
					<SelectRow label={t('tm.new.expiresIn')} options={expiryOptions} bind:value={expiresIn} />
					<ToggleRow
						label={t('tm.new.ip')}
						description={t('tm.new.ipBody')}
						bind:checked={ipRestricted}
					/>
					{#if ipRestricted}
						<ListField
							label={t('tm.new.ipRanges')}
							hint={shownProblem('ip') ?? t('tm.new.ipRangesHint')}
							placeholder="203.0.113.0/24"
							mono
							required
							invalid={!!shownProblem('ip')}
							bind:values={ipRanges}
						/>
					{/if}
				</RowStack>
			</Card>

			{#if refusal}
				<Callout tone="danger" live>{refusal}</Callout>
			{/if}

			<div class="actions">
				<Button type="submit" variant="primary" icon="mail" loading={sending}>
					{sending ? t('tm.new.sending') : t('tm.new.submit')}
				</Button>
				<Button href={listHref} variant="ghost">{t('common.cancel')}</Button>
			</div>
		</Form>
	{/if}
</Page>

<style>
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-related);
	}

	.note {
		margin: 0;
		color: var(--text-muted);
	}
</style>
