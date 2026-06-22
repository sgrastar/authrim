<script lang="ts">
	import { goto } from '$app/navigation';
	import { adminClientsAPI, type Client } from '$lib/api/admin-clients';
	import {
		adminConsentPoliciesAPI,
		type ClientTrustPolicy,
		type ClientTrustPolicyTargetType,
		type ConsentPolicy,
		type ConsentPolicyAssignment,
		type ConsentPolicyAssignmentType,
		type ConsentPolicyItem
	} from '$lib/api/admin-consent-policies';
	import type {
		SignInConfirmationMode,
		SignInConfirmationPolicy
	} from '$lib/api/admin-consent-policies';
	import {
		adminConsentStatementsAPI,
		type ConsentStatement
	} from '$lib/api/admin-consent-statements';
	import { adminSAMLAPI, type SAMLProvider } from '$lib/api/admin-saml';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';
	import { ToggleSwitch } from '$lib/components';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { onMount } from 'svelte';

	type EditorMode = 'new' | 'edit';
	type PolicyItemDraft = Omit<ConsentPolicyItem, 'checkbox_default_checked'> & {
		_key: string;
		checkbox_default_checked: boolean;
	};

	interface Props {
		mode: EditorMode;
		policyId?: string | null;
	}

	let { mode, policyId = null }: Props = $props();

	let loading = $state(true);
	let saving = $state(false);
	let deleting = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let policy = $state<ConsentPolicy | null>(null);
	let statements = $state<ConsentStatement[]>([]);
	let clients = $state<Client[]>([]);
	let samlProviders = $state<SAMLProvider[]>([]);
	let assignments = $state<ConsentPolicyAssignment[]>([]);
	let clientTrustPolicies = $state<ClientTrustPolicy[]>([]);
	let signInPolicies = $state<SignInConfirmationPolicy[]>([]);
	let policyForm = $state({
		id: '',
		display_name: '',
		description: '',
		is_active: true
	});
	let itemDrafts = $state<PolicyItemDraft[]>([]);
	let assignmentForm = $state<{
		assignment_type: ConsentPolicyAssignmentType;
		target_id: string;
	}>({
		assignment_type: 'registration',
		target_id: ''
	});
	let trustForm = $state<{
		target_type: ClientTrustPolicyTargetType;
		target_id: string;
		display_name: string;
		description: string;
		first_party: boolean;
		trusted: boolean;
		skip_authorization_consent: boolean;
		is_active: boolean;
	}>({
		target_type: 'oidc_client',
		target_id: '',
		display_name: '',
		description: '',
		first_party: false,
		trusted: false,
		skip_authorization_consent: false,
		is_active: true
	});
	let signInForm = $state<{
		mode: SignInConfirmationMode;
		remember_duration_days: number;
		show_application_context: boolean;
		show_tenant_context: boolean;
		is_active: boolean;
	}>({
		mode: 'disabled',
		remember_duration_days: 30,
		show_application_context: true,
		show_tenant_context: true,
		is_active: true
	});

	const isNew = $derived(mode === 'new');
	const pageTitle = $derived(
		isNew
			? $LL.admin_consent_policies_new_title()
			: policy?.display_name || $LL.admin_consent_policies_detail_fallback_title()
	);
	const pageDescription = $derived(
		isNew
			? $LL.admin_consent_policies_new_description()
			: $LL.admin_consent_policies_detail_description()
	);
	const samlSpProviders = $derived(
		samlProviders.filter((provider) => provider.providerType === 'saml_sp')
	);
	const currentPolicyAssignments = $derived(
		assignments.filter((assignment) => assignment.policy_id === policyForm.id)
	);
	const canWriteSettings = $derived(adminAuth.hasPermission('admin:settings:write'));
	const writeDisabled = $derived(!canWriteSettings || saving || deleting);
	let trustDisplayNameInitialized = $state(false);

	onMount(() => {
		loadEditor();
	});

	$effect(() => {
		if (!trustDisplayNameInitialized && !trustForm.display_name) {
			trustForm = {
				...trustForm,
				display_name: $LL.admin_consent_policies_default_client_trust_name()
			};
			trustDisplayNameInitialized = true;
		}
	});

	async function loadEditor() {
		loading = true;
		error = '';
		try {
			const [
				statementResult,
				clientResult,
				samlResult,
				assignmentResult,
				trustResult,
				signInResult
			] = await Promise.all([
				adminConsentStatementsAPI.listStatements(),
				adminClientsAPI.list({ limit: 500 }),
				adminSAMLAPI.listProviders(),
				adminConsentPoliciesAPI.listAssignments(),
				adminConsentPoliciesAPI.listClientTrustPolicies(),
				adminConsentPoliciesAPI.listSignInConfirmationPolicies()
			]);
			statements = statementResult.statements || [];
			clients = clientResult.clients || [];
			samlProviders = samlResult.providers || [];
			assignments = assignmentResult.assignments || [];
			clientTrustPolicies = trustResult.policies || [];
			signInPolicies = signInResult.policies || [];
			const loginPolicy = signInPolicies.find((candidate) => candidate.trigger_type === 'login');
			if (loginPolicy) {
				signInForm = {
					mode: loginPolicy.mode,
					remember_duration_days: loginPolicy.remember_duration_days,
					show_application_context: Boolean(loginPolicy.show_application_context),
					show_tenant_context: Boolean(loginPolicy.show_tenant_context),
					is_active: Boolean(loginPolicy.is_active)
				};
			}
			if (!isNew && policyId) {
				const policyResult = await adminConsentPoliciesAPI.getPolicy(policyId);
				policy = policyResult.policy;
				policyForm = {
					id: policyResult.policy.id,
					display_name: policyResult.policy.display_name,
					description: policyResult.policy.description || '',
					is_active: Boolean(policyResult.policy.is_active)
				};
				itemDrafts = (policyResult.items || []).map(toItemDraft);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_policies_load_detail_error();
		} finally {
			loading = false;
		}
	}

	function toItemDraft(item: ConsentPolicyItem): PolicyItemDraft {
		return {
			...item,
			_key: item.id || crypto.randomUUID(),
			checkbox_default_checked: Boolean(item.checkbox_default_checked)
		};
	}

	async function savePolicy() {
		if (!canWriteSettings) {
			error = $LL.admin_consent_policies_permission_change();
			return;
		}
		saving = true;
		error = '';
		successMessage = '';
		try {
			if (policyForm.id) {
				const result = await adminConsentPoliciesAPI.updatePolicy(policyForm.id, {
					display_name: policyForm.display_name,
					description: policyForm.description,
					is_active: policyForm.is_active ? 1 : 0
				});
				policy = result.policy;
				policyForm = {
					...policyForm,
					id: result.policy.id,
					display_name: result.policy.display_name,
					description: result.policy.description || '',
					is_active: Boolean(result.policy.is_active)
				};
				successMessage = $LL.admin_consent_policies_saved();
			} else {
				const result = await adminConsentPoliciesAPI.createPolicy({
					display_name: policyForm.display_name,
					description: policyForm.description,
					is_active: policyForm.is_active
				});
				successMessage = $LL.admin_consent_policies_created();
				await goto(`/admin/consent-policies/${encodeURIComponent(result.policy.id)}`);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_policies_save_error();
		} finally {
			saving = false;
		}
	}

	async function deletePolicy() {
		if (!canWriteSettings) {
			error = $LL.admin_consent_policies_permission_delete();
			return;
		}
		if (!policy) return;
		if (!confirm($LL.admin_consent_policies_delete_confirm({ name: policy.display_name }))) return;
		deleting = true;
		error = '';
		successMessage = '';
		try {
			await adminConsentPoliciesAPI.deletePolicy(policy.id);
			await goto('/admin/consent-policies');
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_policies_delete_error();
		} finally {
			deleting = false;
		}
	}

	function addItem() {
		if (!canWriteSettings) return;
		const statement = statements[0];
		itemDrafts = [
			...itemDrafts,
			{
				_key: crypto.randomUUID(),
				statement_id: statement?.id || '',
				statement_slug: statement?.slug,
				statement_category: statement?.category,
				requirement: 'required',
				version_mode: 'current',
				version_id: '',
				min_version: '',
				checkbox_mode: 'required',
				checkbox_default_checked: false,
				binding_type: null,
				binding_value: '',
				evidence_profile: '',
				language_fallback: '',
				display_order: itemDrafts.length * 10
			}
		];
	}

	function removeItem(key: string) {
		if (!canWriteSettings) return;
		itemDrafts = itemDrafts.filter((item) => item._key !== key);
	}

	async function saveItems() {
		if (!canWriteSettings) {
			error = $LL.admin_consent_policies_permission_statements();
			return;
		}
		if (!policyForm.id) {
			error = $LL.admin_consent_policies_save_statements_first();
			return;
		}
		saving = true;
		error = '';
		successMessage = '';
		try {
			const items = itemDrafts.map(({ _key, ...item }) => ({
				...item,
				checkbox_default_checked: Boolean(item.checkbox_default_checked)
			}));
			const result = await adminConsentPoliciesAPI.replaceItems(policyForm.id, items);
			itemDrafts = (result.items || []).map(toItemDraft);
			successMessage = $LL.admin_consent_policies_statements_saved();
		} catch (err) {
			error =
				err instanceof Error ? err.message : $LL.admin_consent_policies_statements_save_error();
		} finally {
			saving = false;
		}
	}

	async function saveAssignment() {
		if (!canWriteSettings) {
			error = $LL.admin_consent_policies_permission_assignments();
			return;
		}
		if (!policyForm.id) {
			error = $LL.admin_consent_policies_save_assignment_first();
			return;
		}
		if (
			(assignmentForm.assignment_type === 'oidc_client' ||
				assignmentForm.assignment_type === 'saml_sp') &&
			!assignmentForm.target_id
		) {
			error = $LL.admin_consent_policies_target_id_required();
			return;
		}
		saving = true;
		error = '';
		successMessage = '';
		try {
			const result = await adminConsentPoliciesAPI.upsertAssignment({
				assignment_type: assignmentForm.assignment_type,
				target_id: assignmentForm.target_id,
				policy_id: policyForm.id
			});
			assignments = result.assignments || [];
			successMessage = $LL.admin_consent_policies_assignment_saved();
		} catch (err) {
			error =
				err instanceof Error ? err.message : $LL.admin_consent_policies_assignment_save_error();
		} finally {
			saving = false;
		}
	}

	async function saveClientTrustPolicy() {
		if (!canWriteSettings) {
			error = $LL.admin_consent_policies_permission_trust();
			return;
		}
		if (!trustForm.target_id) {
			error = $LL.admin_consent_policies_target_id_required();
			return;
		}
		saving = true;
		error = '';
		successMessage = '';
		try {
			const result = await adminConsentPoliciesAPI.upsertClientTrustPolicy(trustForm);
			clientTrustPolicies = result.policies || [];
			successMessage = $LL.admin_consent_policies_trust_saved();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_policies_trust_save_error();
		} finally {
			saving = false;
		}
	}

	async function saveSignInPolicy() {
		if (!canWriteSettings) {
			error = $LL.admin_consent_policies_permission_signin();
			return;
		}
		saving = true;
		error = '';
		successMessage = '';
		try {
			const result = await adminConsentPoliciesAPI.upsertSignInConfirmationPolicy(signInForm);
			signInPolicies = result.policies || [];
			successMessage = $LL.admin_consent_policies_signin_saved();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_policies_signin_save_error();
		} finally {
			saving = false;
		}
	}

	function statementLabel(statementId: string) {
		const statement = statements.find((candidate) => candidate.id === statementId);
		if (!statement) return statementId || $LL.admin_consent_policies_select_statement();
		return `${statement.slug} (${statement.category})`;
	}

	function assignmentLabel(type: ConsentPolicyAssignmentType) {
		if (type === 'registration') return $LL.admin_consent_policies_registration();
		if (type === 'login') return $LL.admin_consent_policies_login();
		if (type === 'oidc_client') return $LL.admin_consent_policies_oidc_client();
		return $LL.admin_consent_policies_saml_sp();
	}

	function targetName(
		type: ConsentPolicyAssignmentType | ClientTrustPolicyTargetType,
		targetId: string
	) {
		if (type === 'registration' || type === 'login') return assignmentLabel(type);
		if (type === 'oidc_client') {
			const client = clients.find((candidate) => candidate.client_id === targetId);
			return client ? client.client_name : targetId;
		}
		if (type === 'saml_sp') {
			const provider = samlProviders.find((candidate) => candidate.id === targetId);
			return provider ? provider.name : targetId;
		}
		return targetId || $LL.admin_consent_policies_tenant_account_flow();
	}

	function formatBool(value: number | boolean) {
		return value ? $LL.admin_consent_policies_enabled() : $LL.admin_consent_policies_disabled();
	}

	function formatSignInMode(mode: SignInConfirmationMode) {
		if (mode === 'first_time') return $LL.admin_consent_policies_mode_first_time();
		if (mode === 'every_time') return $LL.admin_consent_policies_mode_every_time();
		return $LL.admin_consent_policies_mode_disabled();
	}

	function formatDate(timestamp: number) {
		if (!timestamp) return '-';
		const millis = timestamp > 100000000000 ? timestamp : timestamp * 1000;
		return new Date(millis).toLocaleDateString();
	}

	function setAssignmentType(event: Event) {
		assignmentForm = {
			...assignmentForm,
			assignment_type: (event.currentTarget as HTMLSelectElement)
				.value as ConsentPolicyAssignmentType,
			target_id: ''
		};
	}

	function setTrustTargetType(event: Event) {
		trustForm = {
			...trustForm,
			target_type: (event.currentTarget as HTMLSelectElement).value as ClientTrustPolicyTargetType,
			target_id: ''
		};
	}
</script>

<svelte:head>
	<title>{$LL.admin_consent_policies_detail_page_title({ title: pageTitle })}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader title={pageTitle} description={pageDescription}>
		{#snippet actions()}
			<a href="/admin/consent-policies" class="btn btn-secondary">
				<i class="i-ph-arrow-left" aria-hidden="true"></i>
				{$LL.admin_consent_policies_back_to_list()}
			</a>
			<button class="btn btn-primary" type="button" onclick={savePolicy} disabled={writeDisabled}>
				<i class="i-ph-floppy-disk" aria-hidden="true"></i>
				{policyForm.id
					? $LL.admin_consent_policies_save_policy()
					: $LL.admin_consent_policies_create_policy()}
			</button>
		{/snippet}
	</AdminPageHeader>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner" aria-hidden="true"></i>
			<p>{$LL.admin_consent_policies_loading_detail()}</p>
		</div>
	{:else}
		{#if error}
			<div class="alert alert-error">{error}</div>
		{/if}
		{#if successMessage}
			<div class="alert alert-success">{successMessage}</div>
		{/if}
		{#if !canWriteSettings}
			<div class="alert alert-info">
				{$LL.admin_consent_policies_readonly_notice()}
			</div>
		{/if}

		<AdminSection title={$LL.admin_consent_policies_policy_details()}>
			{#snippet actions()}
				<ToggleSwitch
					id="policy-active"
					bind:checked={policyForm.is_active}
					disabled={!canWriteSettings}
					label={$LL.admin_consent_policies_active()}
					ariaLabel={$LL.admin_consent_policies_active()}
					size="sm"
				/>
			{/snippet}
			<div class="form-grid">
				<div class="admin-field">
					<label for="policy-display-name" class="admin-field__label"
						>{$LL.admin_consent_policies_policy_name_label()}</label
					>
					<input
						id="policy-display-name"
						class="admin-input"
						bind:value={policyForm.display_name}
						disabled={!canWriteSettings}
					/>
				</div>
				<div class="admin-field admin-field--full">
					<label for="policy-description" class="admin-field__label"
						>{$LL.admin_consent_policies_description_label()}</label
					>
					<textarea
						id="policy-description"
						class="admin-input"
						rows="3"
						bind:value={policyForm.description}
						disabled={!canWriteSettings}
					></textarea>
				</div>
			</div>
		</AdminSection>

		<AdminSection
			title={$LL.admin_consent_policies_statements()}
			description={policyForm.id
				? $LL.admin_consent_policies_statements_description()
				: $LL.admin_consent_policies_statements_create_first()}
		>
			{#snippet actions()}
				<button
					class="btn btn-secondary"
					type="button"
					onclick={addItem}
					disabled={!policyForm.id || statements.length === 0 || writeDisabled}
				>
					<i class="i-ph-plus" aria-hidden="true"></i>
					{$LL.admin_consent_policies_add_statement()}
				</button>
			{/snippet}

			{#if itemDrafts.length === 0}
				<div class="empty-panel">
					<p>{$LL.admin_consent_policies_no_statements()}</p>
				</div>
			{:else}
				<div class="statement-stack">
					{#each itemDrafts as item (item._key)}
						<section class="statement-editor">
							<header class="statement-editor__header">
								<div>
									<h3>{statementLabel(item.statement_id)}</h3>
									<p>
										{$LL.admin_consent_policies_statement_order({ order: item.display_order })}
									</p>
								</div>
								<button
									class="icon-button icon-button--danger"
									type="button"
									aria-label={$LL.admin_consent_policies_remove_statement()}
									title={$LL.admin_consent_policies_remove_statement()}
									onclick={() => removeItem(item._key)}
									disabled={!canWriteSettings}
								>
									<i class="i-ph-trash" aria-hidden="true"></i>
								</button>
							</header>

							<div class="statement-grid">
								<div class="admin-field">
									<label for={`statement-${item._key}`} class="admin-field__label"
										>{$LL.admin_consent_policies_statement()}</label
									>
									<select
										id={`statement-${item._key}`}
										class="admin-select"
										bind:value={item.statement_id}
										disabled={!canWriteSettings}
									>
										{#each statements as statement (statement.id)}
											<option value={statement.id}>{statement.slug} ({statement.category})</option>
										{/each}
									</select>
								</div>
								<div class="admin-field">
									<label for={`requirement-${item._key}`} class="admin-field__label"
										>{$LL.admin_consent_policies_requirement()}</label
									>
									<select
										id={`requirement-${item._key}`}
										class="admin-select"
										bind:value={item.requirement}
										disabled={!canWriteSettings}
									>
										<option value="required"
											>{$LL.admin_consent_policies_requirement_required()}</option
										>
										<option value="optional"
											>{$LL.admin_consent_policies_requirement_optional()}</option
										>
										<option value="hidden">{$LL.admin_consent_policies_requirement_hidden()}</option
										>
									</select>
								</div>
								<div class="admin-field">
									<label for={`version-mode-${item._key}`} class="admin-field__label"
										>{$LL.admin_consent_policies_version()}</label
									>
									<select
										id={`version-mode-${item._key}`}
										class="admin-select"
										bind:value={item.version_mode}
										disabled={!canWriteSettings}
									>
										<option value="current">{$LL.admin_consent_policies_version_current()}</option>
										<option value="fixed">{$LL.admin_consent_policies_version_fixed()}</option>
										<option value="minimum">{$LL.admin_consent_policies_version_minimum()}</option>
									</select>
								</div>
								<div class="admin-field">
									<label for={`version-value-${item._key}`} class="admin-field__label"
										>{$LL.admin_consent_policies_version_value()}</label
									>
									{#if item.version_mode === 'minimum'}
										<input
											id={`version-value-${item._key}`}
											class="admin-input"
											bind:value={item.min_version}
											disabled={!canWriteSettings}
										/>
									{:else}
										<input
											id={`version-value-${item._key}`}
											class="admin-input"
											bind:value={item.version_id}
											disabled={!canWriteSettings || item.version_mode === 'current'}
										/>
									{/if}
								</div>
								<div class="admin-field">
									<label for={`checkbox-${item._key}`} class="admin-field__label"
										>{$LL.admin_consent_policies_checkbox()}</label
									>
									<select
										id={`checkbox-${item._key}`}
										class="admin-select"
										bind:value={item.checkbox_mode}
										disabled={!canWriteSettings}
									>
										<option value="none">{$LL.admin_consent_policies_checkbox_none()}</option>
										<option value="required"
											>{$LL.admin_consent_policies_requirement_required()}</option
										>
										<option value="optional"
											>{$LL.admin_consent_policies_requirement_optional()}</option
										>
									</select>
								</div>
								<div class="admin-field">
									<label for={`order-${item._key}`} class="admin-field__label"
										>{$LL.admin_consent_policies_order()}</label
									>
									<input
										id={`order-${item._key}`}
										class="admin-input"
										type="number"
										bind:value={item.display_order}
										disabled={!canWriteSettings}
									/>
								</div>
								<div class="admin-field">
									<label for={`binding-type-${item._key}`} class="admin-field__label"
										>{$LL.admin_consent_policies_binding()}</label
									>
									<select
										id={`binding-type-${item._key}`}
										class="admin-select"
										bind:value={item.binding_type}
										disabled={!canWriteSettings}
									>
										<option value="">{$LL.admin_consent_policies_binding_none()}</option>
										<option value="scope">{$LL.admin_consent_policies_binding_scope()}</option>
										<option value="claim">{$LL.admin_consent_policies_binding_claim()}</option>
										<option value="saml_attribute"
											>{$LL.admin_consent_policies_binding_saml_attribute()}</option
										>
										<option value="destination_field_set"
											>{$LL.admin_consent_policies_binding_destination_field_set()}</option
										>
									</select>
								</div>
								<div class="admin-field">
									<label for={`binding-value-${item._key}`} class="admin-field__label"
										>{$LL.admin_consent_policies_binding_value()}</label
									>
									<input
										id={`binding-value-${item._key}`}
										class="admin-input"
										bind:value={item.binding_value}
										disabled={!canWriteSettings}
									/>
								</div>
								<div class="admin-field">
									<label for={`evidence-${item._key}`} class="admin-field__label"
										>{$LL.admin_consent_policies_evidence()}</label
									>
									<input
										id={`evidence-${item._key}`}
										class="admin-input"
										bind:value={item.evidence_profile}
										disabled={!canWriteSettings}
									/>
								</div>
								<div class="admin-field">
									<label for={`fallback-${item._key}`} class="admin-field__label"
										>{$LL.admin_consent_policies_fallback()}</label
									>
									<input
										id={`fallback-${item._key}`}
										class="admin-input"
										bind:value={item.language_fallback}
										disabled={!canWriteSettings}
									/>
								</div>
								<div class="admin-field admin-field--toggle">
									<ToggleSwitch
										bind:checked={item.checkbox_default_checked}
										disabled={!canWriteSettings}
										label={$LL.admin_consent_policies_checkbox_checked_default()}
									/>
								</div>
							</div>
						</section>
					{/each}
				</div>
			{/if}

			<div class="section-actions">
				<button
					class="btn btn-primary"
					type="button"
					onclick={saveItems}
					disabled={!policyForm.id || writeDisabled}
				>
					<i class="i-ph-list-checks" aria-hidden="true"></i>
					{$LL.admin_consent_policies_save_statements()}
				</button>
			</div>
		</AdminSection>

		<AdminSection
			title={$LL.admin_consent_policies_assignments()}
			description={policyForm.id
				? $LL.admin_consent_policies_assignments_description()
				: $LL.admin_consent_policies_assignments_create_first()}
		>
			<div class="inline-form">
				<div class="admin-field">
					<label for="assignment-type" class="admin-field__label">
						{$LL.admin_consent_policies_target()}
					</label>
					<select
						id="assignment-type"
						class="admin-select"
						value={assignmentForm.assignment_type}
						onchange={setAssignmentType}
						disabled={!policyForm.id || writeDisabled}
					>
						<option value="registration">{$LL.admin_consent_policies_registration()}</option>
						<option value="login">{$LL.admin_consent_policies_login()}</option>
						<option value="oidc_client">{$LL.admin_consent_policies_oidc_client()}</option>
						<option value="saml_sp">{$LL.admin_consent_policies_saml_sp()}</option>
					</select>
				</div>
				<div class="admin-field">
					<label for="assignment-target" class="admin-field__label">
						{$LL.admin_consent_policies_target_id()}
					</label>
					{#if assignmentForm.assignment_type === 'oidc_client'}
						<select
							id="assignment-target"
							class="admin-select"
							bind:value={assignmentForm.target_id}
							disabled={!policyForm.id || writeDisabled}
						>
							<option value="">{$LL.admin_consent_policies_select_client()}</option>
							{#each clients as client (client.client_id)}
								<option value={client.client_id}>{client.client_name}</option>
							{/each}
						</select>
					{:else if assignmentForm.assignment_type === 'saml_sp'}
						<select
							id="assignment-target"
							class="admin-select"
							bind:value={assignmentForm.target_id}
							disabled={!policyForm.id || writeDisabled}
						>
							<option value="">{$LL.admin_consent_policies_select_saml_sp()}</option>
							{#each samlSpProviders as provider (provider.id)}
								<option value={provider.id}>{provider.name}</option>
							{/each}
						</select>
					{:else}
						<input
							id="assignment-target"
							class="admin-input"
							value={$LL.admin_consent_policies_tenant_account_flow()}
							disabled
						/>
					{/if}
				</div>
				<button
					class="btn btn-primary align-end"
					type="button"
					onclick={saveAssignment}
					disabled={!policyForm.id ||
						writeDisabled ||
						((assignmentForm.assignment_type === 'oidc_client' ||
							assignmentForm.assignment_type === 'saml_sp') &&
							!assignmentForm.target_id)}
				>
					<i class="i-ph-floppy-disk" aria-hidden="true"></i>
					{$LL.admin_consent_policies_save_assignment()}
				</button>
			</div>

			<AdminDataTable>
				<thead>
					<tr>
						<th>{$LL.admin_consent_policies_target()}</th>
						<th>{$LL.admin_consent_policies_target_id()}</th>
						<th>{$LL.admin_consent_policies_table_updated()}</th>
					</tr>
				</thead>
				<tbody>
					{#each currentPolicyAssignments as assignment (assignment.id)}
						<tr>
							<td>{assignmentLabel(assignment.assignment_type)}</td>
							<td>{targetName(assignment.assignment_type, assignment.target_id)}</td>
							<td class="admin-muted nowrap">{formatDate(assignment.updated_at)}</td>
						</tr>
					{:else}
						<tr>
							<td colspan="3" class="empty-cell">{$LL.admin_consent_policies_no_assignments()}</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>

		<details class="advanced-details">
			<summary>
				<span>
					<strong>{$LL.admin_consent_policies_client_trust()}</strong>
					<small>{$LL.admin_consent_policies_advanced_settings()}</small>
				</span>
				<i class="i-ph-caret-down advanced-details__icon" aria-hidden="true"></i>
			</summary>
			<div class="advanced-details__body">
				<div class="form-grid">
					<div class="admin-field">
						<label for="trust-target-type" class="admin-field__label">
							{$LL.admin_consent_policies_target()}
						</label>
						<select
							id="trust-target-type"
							class="admin-select"
							value={trustForm.target_type}
							onchange={setTrustTargetType}
							disabled={!canWriteSettings}
						>
							<option value="oidc_client">{$LL.admin_consent_policies_oidc_client()}</option>
							<option value="saml_sp">{$LL.admin_consent_policies_saml_sp()}</option>
						</select>
					</div>
					<div class="admin-field">
						<label for="trust-target-id" class="admin-field__label">
							{$LL.admin_consent_policies_target_id()}
						</label>
						{#if trustForm.target_type === 'oidc_client'}
							<select
								id="trust-target-id"
								class="admin-select"
								bind:value={trustForm.target_id}
								disabled={!canWriteSettings}
							>
								<option value="">{$LL.admin_consent_policies_select_client()}</option>
								{#each clients as client (client.client_id)}
									<option value={client.client_id}>{client.client_name}</option>
								{/each}
							</select>
						{:else if trustForm.target_type === 'saml_sp'}
							<select
								id="trust-target-id"
								class="admin-select"
								bind:value={trustForm.target_id}
								disabled={!canWriteSettings}
							>
								<option value="">{$LL.admin_consent_policies_select_saml_sp()}</option>
								{#each samlSpProviders as provider (provider.id)}
									<option value={provider.id}>{provider.name}</option>
								{/each}
							</select>
						{/if}
					</div>
					<div class="admin-field">
						<label for="trust-display-name" class="admin-field__label">
							{$LL.admin_consent_policies_display_name()}
						</label>
						<input
							id="trust-display-name"
							class="admin-input"
							bind:value={trustForm.display_name}
							disabled={!canWriteSettings}
						/>
					</div>
					<div class="admin-field admin-field--full">
						<label for="trust-description" class="admin-field__label">
							{$LL.admin_consent_policies_description_label()}
						</label>
						<textarea
							id="trust-description"
							class="admin-input"
							rows="2"
							bind:value={trustForm.description}
							disabled={!canWriteSettings}
						></textarea>
					</div>
				</div>
				<div class="behavior-settings-list">
					<ToggleSwitch
						bind:checked={trustForm.first_party}
						disabled={!canWriteSettings}
						label={$LL.admin_consent_policies_first_party()}
					/>
					<ToggleSwitch
						bind:checked={trustForm.trusted}
						disabled={!canWriteSettings}
						label={$LL.admin_consent_policies_trusted()}
					/>
					<ToggleSwitch
						bind:checked={trustForm.skip_authorization_consent}
						disabled={!canWriteSettings}
						label={$LL.admin_consent_policies_skip_authorization_consent()}
					/>
					<ToggleSwitch
						bind:checked={trustForm.is_active}
						disabled={!canWriteSettings}
						label={$LL.admin_consent_policies_active()}
					/>
				</div>
				<div class="section-actions">
					<button
						class="btn btn-primary"
						type="button"
						onclick={saveClientTrustPolicy}
						disabled={writeDisabled || !trustForm.target_id}
					>
						<i class="i-ph-floppy-disk" aria-hidden="true"></i>
						{$LL.admin_consent_policies_save_trust_policy()}
					</button>
				</div>

				<AdminDataTable>
					<thead>
						<tr>
							<th>{$LL.admin_consent_policies_name()}</th>
							<th>{$LL.admin_consent_policies_target()}</th>
							<th>{$LL.admin_consent_policies_first_party()}</th>
							<th>{$LL.admin_consent_policies_trusted()}</th>
							<th>{$LL.admin_consent_policies_skip_consent()}</th>
							<th>{$LL.admin_consent_policies_table_status()}</th>
						</tr>
					</thead>
					<tbody>
						{#each clientTrustPolicies as trustPolicy (trustPolicy.id)}
							<tr>
								<td>
									<strong>{trustPolicy.display_name}</strong>
									<div class="admin-muted admin-mono">{trustPolicy.name}</div>
								</td>
								<td>{targetName(trustPolicy.target_type, trustPolicy.target_id)}</td>
								<td>{formatBool(trustPolicy.first_party)}</td>
								<td>{formatBool(trustPolicy.trusted)}</td>
								<td>{formatBool(trustPolicy.skip_authorization_consent)}</td>
								<td>{formatBool(trustPolicy.is_active)}</td>
							</tr>
						{:else}
							<tr>
								<td colspan="6" class="empty-cell">
									{$LL.admin_consent_policies_no_trust_policies()}
								</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			</div>
		</details>

		<AdminSection
			title={$LL.admin_consent_policies_signin_confirmation()}
			description={$LL.admin_consent_policies_signin_description()}
		>
			<div class="form-grid">
				<div class="admin-field">
					<label for="sign-in-mode" class="admin-field__label">
						{$LL.admin_consent_policies_mode()}
					</label>
					<select
						id="sign-in-mode"
						class="admin-select"
						bind:value={signInForm.mode}
						disabled={!canWriteSettings}
					>
						<option value="disabled">{$LL.admin_consent_policies_mode_disabled()}</option>
						<option value="first_time">{$LL.admin_consent_policies_mode_first_time()}</option>
						<option value="every_time">{$LL.admin_consent_policies_mode_every_time()}</option>
					</select>
				</div>
				<div class="admin-field">
					<label for="remember-days" class="admin-field__label">
						{$LL.admin_consent_policies_remember_days()}
					</label>
					<input
						id="remember-days"
						class="admin-input"
						type="number"
						min="0"
						max="3650"
						bind:value={signInForm.remember_duration_days}
						disabled={!canWriteSettings}
					/>
				</div>
			</div>
			<div class="behavior-settings-list">
				<ToggleSwitch
					bind:checked={signInForm.show_application_context}
					disabled={!canWriteSettings}
					label={$LL.admin_consent_policies_show_application_context()}
				/>
				<ToggleSwitch
					bind:checked={signInForm.show_tenant_context}
					disabled={!canWriteSettings}
					label={$LL.admin_consent_policies_show_tenant_context()}
				/>
				<ToggleSwitch
					bind:checked={signInForm.is_active}
					disabled={!canWriteSettings}
					label={$LL.admin_consent_policies_active()}
				/>
			</div>
			<div class="section-actions">
				<button
					class="btn btn-primary"
					type="button"
					onclick={saveSignInPolicy}
					disabled={writeDisabled}
				>
					<i class="i-ph-floppy-disk" aria-hidden="true"></i>
					{$LL.admin_consent_policies_save_signin_policy()}
				</button>
			</div>

			<AdminDataTable>
				<thead>
					<tr>
						<th>{$LL.admin_consent_policies_name()}</th>
						<th>{$LL.admin_consent_policies_mode()}</th>
						<th>{$LL.admin_consent_policies_remember_days()}</th>
						<th>{$LL.admin_consent_policies_context()}</th>
						<th>{$LL.admin_consent_policies_table_status()}</th>
					</tr>
				</thead>
				<tbody>
					{#each signInPolicies as signInPolicy (signInPolicy.id)}
						<tr>
							<td>{signInPolicy.display_name}</td>
							<td>{formatSignInMode(signInPolicy.mode)}</td>
							<td>
								{$LL.admin_consent_policies_remember_days_value({
									days: signInPolicy.remember_duration_days
								})}
							</td>
							<td>
								{$LL.admin_consent_policies_context_summary({
									app: formatBool(signInPolicy.show_application_context),
									tenant: formatBool(signInPolicy.show_tenant_context)
								})}
							</td>
							<td>{formatBool(signInPolicy.is_active)}</td>
						</tr>
					{:else}
						<tr>
							<td colspan="5" class="empty-cell">
								{$LL.admin_consent_policies_no_signin_policy()}
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>

		{#if policy && canWriteSettings}
			<AdminSection title={$LL.admin_consent_policies_danger_zone()}>
				<div class="danger-row">
					<div>
						<strong>{$LL.admin_consent_policies_delete_title()}</strong>
						<p>{$LL.admin_consent_policies_delete_description()}</p>
					</div>
					<button
						class="btn btn-danger"
						type="button"
						onclick={deletePolicy}
						disabled={writeDisabled}
					>
						<i class="i-ph-trash" aria-hidden="true"></i>
						{$LL.admin_consent_policies_delete_button()}
					</button>
				</div>
			</AdminSection>
		{/if}
	{/if}
</AdminPageShell>

<style>
	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
		max-width: 980px;
	}

	.admin-field {
		display: grid;
		gap: 6px;
	}

	.admin-field--full {
		grid-column: 1 / -1;
	}

	.admin-field--toggle {
		align-self: center;
		min-height: var(--control-height, 40px);
	}

	.admin-field__label {
		color: var(--color-text);
		font-size: 0.84rem;
		font-weight: 700;
	}

	.empty-panel {
		display: grid;
		place-items: center;
		min-height: 120px;
		border: 1px dashed var(--color-border);
		border-radius: var(--radius-panel, 8px);
		color: var(--color-text-muted);
	}

	.empty-panel p {
		margin: 0;
		font-size: 0.86rem;
	}

	.statement-stack {
		display: grid;
		gap: 14px;
	}

	.statement-editor {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, 8px);
		background: var(--color-surface);
		padding: 16px;
	}

	.statement-editor__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 14px;
		margin-bottom: 14px;
	}

	.statement-editor__header h3 {
		margin: 0;
		font-size: 0.98rem;
		line-height: 1.35;
		color: var(--color-text);
	}

	.statement-editor__header p {
		margin: 3px 0 0;
		color: var(--color-text-muted);
		font-size: 0.78rem;
	}

	.statement-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 14px;
		align-items: end;
	}

	.inline-form {
		display: grid;
		grid-template-columns: minmax(180px, 0.8fr) minmax(220px, 1fr) auto;
		gap: 14px;
		align-items: end;
		margin-bottom: 18px;
	}

	.align-end {
		align-self: end;
	}

	.empty-cell {
		padding: 18px;
		text-align: center;
		color: var(--color-text-muted);
		font-size: 0.84rem;
	}

	.advanced-details {
		margin-block: var(--section-margin-block, 22px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, 8px);
		background: var(--color-surface);
	}

	.advanced-details summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 16px;
		cursor: pointer;
		list-style: none;
	}

	.advanced-details summary::-webkit-details-marker {
		display: none;
	}

	.advanced-details summary strong {
		display: block;
		color: var(--color-text);
		font-family: var(--section-title-font, var(--font-display));
		font-size: var(--section-title-size, 1rem);
		line-height: 1.35;
	}

	.advanced-details summary small {
		display: block;
		margin-top: 3px;
		color: var(--color-text-muted);
		font-size: 0.78rem;
	}

	.advanced-details__icon {
		transition: transform 0.16s ease;
		color: var(--color-text-muted);
	}

	.advanced-details[open] .advanced-details__icon {
		transform: rotate(180deg);
	}

	.advanced-details__body {
		display: grid;
		gap: 18px;
		padding: 0 16px 16px;
		border-top: 1px solid var(--color-border);
	}

	.advanced-details__body .form-grid {
		max-width: none;
		padding-top: 16px;
	}

	.behavior-settings-list {
		display: grid;
		gap: 14px;
	}

	.icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 6px);
		background: var(--color-surface-raised);
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.icon-button:hover {
		border-color: var(--color-accent);
		color: var(--color-text);
	}

	.icon-button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.icon-button:disabled:hover {
		border-color: var(--color-border);
		color: var(--color-text-muted);
	}

	.icon-button--danger:hover {
		border-color: var(--color-danger);
		color: var(--color-danger);
	}

	.section-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 16px;
	}

	.danger-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 18px;
		padding: 16px;
		border: 1px solid color-mix(in srgb, var(--color-danger) 35%, var(--color-border));
		border-radius: var(--radius-panel, 8px);
		background: color-mix(in srgb, var(--color-danger) 6%, var(--color-surface));
	}

	.danger-row p {
		margin: 4px 0 0;
		color: var(--color-text-muted);
		font-size: 0.84rem;
	}

	@media (max-width: 760px) {
		.form-grid,
		.inline-form,
		.danger-row {
			grid-template-columns: 1fr;
		}

		.danger-row {
			display: grid;
			align-items: stretch;
		}

		.section-actions {
			justify-content: stretch;
		}
	}
</style>
