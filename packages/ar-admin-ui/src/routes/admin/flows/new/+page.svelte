<script lang="ts">
	import { goto } from '$app/navigation';
	import { LL } from '$i18n/i18n-svelte';
	import { getFlowTemplateText } from '$lib/admin/flow-i18n';
	import { adminFlowsAPI, type AdminFlowKind, type FlowEditorState } from '$lib/api/admin-flows';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { newFlowTemplates, type NewFlowTemplate } from '$lib/admin/new-flow-templates';

	let creatingTemplateId = $state('');
	let createError = $state('');

	const localizedFlows = $derived(
		newFlowTemplates.map((flow) => ({
			flow,
			text: getFlowTemplateText($LL, flow)
		}))
	);

	function getTemplateKind(flow: NewFlowTemplate): AdminFlowKind {
		if (flow.id === 'oidc-registration') return 'registration';
		if (flow.id === 'academic-saml-login') return 'login';
		if (flow.id === 'oidc-login') return 'login';
		return 'approve';
	}

	function createPosition(index: number) {
		return { x: 360, y: index * 144 };
	}

	function createTemplateEditorState(flow: NewFlowTemplate): FlowEditorState {
		if (flow.id === 'oidc-registration') {
			return {
				nodes: [
					{
						id: 'request',
						type: 'entry',
						title: $LL.admin_flows_node_registration_request(),
						position: createPosition(0),
						config: { ui_kind: 'start' }
					},
					{
						id: 'registration-method',
						type: 'registration',
						title: $LL.admin_flows_node_registration_method(),
						position: createPosition(1),
						config: {
							ui_kind: 'registration',
							authentication_profile_ref: 'default',
							profile_form_ref: 'basic_profile',
							outputs: [
								{ id: 'mail_otp', label: $LL.admin_flows_setting_email_otp() },
								{ id: 'totp', label: $LL.admin_flows_setting_totp() },
								{ id: 'passkey', label: $LL.admin_flows_setting_passkey() },
								{ id: 'facebook', label: 'Facebook' }
							]
						}
					},
					{
						id: 'profile-input',
						type: 'profile_form',
						title: $LL.admin_flows_node_profile_input(),
						position: createPosition(3),
						config: { ui_kind: 'profile', profile_form_ref: 'basic_profile' }
					},
					{
						id: 'consent',
						type: 'consent',
						title: $LL.admin_flows_setting_registration_consent(),
						position: createPosition(4),
						config: {
							ui_kind: 'consent',
							consent_policy_ref: 'registration_consent_policy'
						}
					},
					{
						id: 'account-create',
						type: 'account_action',
						title: $LL.admin_flows_node_account_creation(),
						position: createPosition(5),
						config: { ui_kind: 'account' }
					},
					{
						id: 'complete',
						type: 'complete',
						title: $LL.admin_flows_palette_end_label(),
						position: createPosition(6),
						config: { ui_kind: 'end' }
					}
				],
				edges: [
					{
						id: 'request:next->registration-method',
						source: 'request',
						source_handle: 'next',
						target: 'registration-method'
					},
					{
						id: 'registration-method:mail_otp->profile-input',
						source: 'registration-method',
						source_handle: 'mail_otp',
						target: 'profile-input'
					},
					{
						id: 'registration-method:totp->profile-input',
						source: 'registration-method',
						source_handle: 'totp',
						target: 'profile-input'
					},
					{
						id: 'registration-method:passkey->profile-input',
						source: 'registration-method',
						source_handle: 'passkey',
						target: 'profile-input'
					},
					{
						id: 'registration-method:facebook->profile-input',
						source: 'registration-method',
						source_handle: 'facebook',
						target: 'profile-input'
					},
					{
						id: 'profile-input:submitted->consent',
						source: 'profile-input',
						source_handle: 'submitted',
						target: 'consent'
					},
					{
						id: 'consent:accepted->account-create',
						source: 'consent',
						source_handle: 'accepted',
						target: 'account-create'
					},
					{
						id: 'account-create:completed->complete',
						source: 'account-create',
						source_handle: 'completed',
						target: 'complete'
					}
				],
				viewport: { x: 36, y: 36, zoom: 1 }
			};
		}

		if (flow.id === 'academic-saml-login') {
			return {
				nodes: [
					{
						id: 'request',
						type: 'entry',
						title: $LL.admin_flows_palette_start_label(),
						position: { x: 360, y: 0 },
						config: { ui_kind: 'start' }
					},
					{
						id: 'session-check',
						type: 'session_check',
						title: $LL.admin_flows_node_session_check(),
						position: { x: 360, y: 144 },
						config: { ui_kind: 'session' }
					},
					{
						id: 'authentication',
						type: 'authentication',
						title: $LL.admin_flows_node_authentication_method(),
						position: { x: 522, y: 288 },
						config: {
							ui_kind: 'authentication',
							authentication_profile_ref: 'default',
							outputs: [
								{ id: 'mail_otp', label: $LL.admin_flows_setting_email_otp() },
								{ id: 'totp', label: $LL.admin_flows_setting_totp() },
								{ id: 'passkey', label: $LL.admin_flows_setting_passkey() }
							]
						}
					},
					{
						id: 'saml-attribute-release-consent',
						type: 'consent',
						title: $LL.admin_flows_node_consent(),
						position: { x: 360, y: 468 },
						config: {
							ui_kind: 'consent',
							consent_policy_ref: 'saml_attribute_release_policy',
							completion_block: {
								id: 'saml-attribute-release-completion',
								label: $LL.admin_flows_completion_block_saml_attribute_release(),
								protocol: 'saml',
								purpose: 'attribute_release',
								role: 'consent'
							}
						}
					},
					{
						id: 'saml-attribute-release-complete',
						type: 'complete',
						title: $LL.admin_flows_palette_end_label(),
						position: { x: 360, y: 612 },
						config: {
							ui_kind: 'end',
							completion_block: {
								id: 'saml-attribute-release-completion',
								label: $LL.admin_flows_completion_block_saml_attribute_release(),
								protocol: 'saml',
								purpose: 'attribute_release',
								role: 'output'
							}
						}
					}
				],
				edges: [
					{
						id: 'request:next->session-check',
						source: 'request',
						source_handle: 'next',
						target: 'session-check'
					},
					{
						id: 'session-check:continue->saml-attribute-release-consent',
						source: 'session-check',
						source_handle: 'continue',
						target: 'saml-attribute-release-consent'
					},
					{
						id: 'session-check:authenticate->authentication',
						source: 'session-check',
						source_handle: 'authenticate',
						target: 'authentication'
					},
					{
						id: 'authentication:mail_otp->saml-attribute-release-consent',
						source: 'authentication',
						source_handle: 'mail_otp',
						target: 'saml-attribute-release-consent'
					},
					{
						id: 'authentication:totp->saml-attribute-release-consent',
						source: 'authentication',
						source_handle: 'totp',
						target: 'saml-attribute-release-consent'
					},
					{
						id: 'authentication:passkey->saml-attribute-release-consent',
						source: 'authentication',
						source_handle: 'passkey',
						target: 'saml-attribute-release-consent'
					},
					{
						id: 'saml-attribute-release-consent:accepted->saml-attribute-release-complete',
						source: 'saml-attribute-release-consent',
						source_handle: 'accepted',
						target: 'saml-attribute-release-complete'
					}
				],
				viewport: { x: 36, y: 36, zoom: 1 }
			};
		}

		if (flow.id === 'oidc-login') {
			return {
				nodes: [
					{
						id: 'request',
						type: 'entry',
						title: $LL.admin_flows_node_login_request(),
						position: { x: 360, y: 0 },
						config: { ui_kind: 'start' }
					},
					{
						id: 'session-check',
						type: 'session_check',
						title: $LL.admin_flows_node_session_check(),
						position: { x: 360, y: 144 },
						config: { ui_kind: 'session' }
					},
					{
						id: 'authentication',
						type: 'authentication',
						title: $LL.admin_flows_node_authentication_method(),
						position: { x: 522, y: 288 },
						config: {
							ui_kind: 'authentication',
							authentication_profile_ref: 'default',
							outputs: [
								{ id: 'mail_otp', label: $LL.admin_flows_setting_email_otp() },
								{ id: 'totp', label: $LL.admin_flows_setting_totp() },
								{ id: 'passkey', label: $LL.admin_flows_setting_passkey() },
								{ id: 'facebook', label: 'Facebook' }
							]
						}
					},
					{
						id: 'saml-attribute-release-consent',
						type: 'consent',
						title: $LL.admin_flows_node_consent(),
						position: { x: 108, y: 468 },
						config: {
							ui_kind: 'consent',
							consent_policy_ref: 'saml_attribute_release_policy',
							completion_block: {
								id: 'saml-attribute_release-completion',
								label: $LL.admin_flows_completion_block_saml_attribute_release(),
								protocol: 'saml',
								purpose: 'attribute_release',
								role: 'consent'
							}
						}
					},
					{
						id: 'saml-attribute-release-complete',
						type: 'complete',
						title: $LL.admin_flows_palette_end_label(),
						position: { x: 108, y: 612 },
						config: {
							ui_kind: 'end',
							completion_block: {
								id: 'saml-attribute_release-completion',
								label: $LL.admin_flows_completion_block_saml_attribute_release(),
								protocol: 'saml',
								purpose: 'attribute_release',
								role: 'output'
							}
						}
					},
					{
						id: 'oidc-authorization-consent',
						type: 'consent',
						title: $LL.admin_flows_node_consent(),
						position: { x: 594, y: 468 },
						config: {
							ui_kind: 'consent',
							consent_policy_ref: 'oidc_authorization_consent_policy',
							completion_block: {
								id: 'oidc-authorization-completion',
								label: $LL.admin_flows_completion_block_oidc_authorization(),
								protocol: 'oidc',
								purpose: 'authorization',
								role: 'consent'
							}
						}
					},
					{
						id: 'oidc-authorization-complete',
						type: 'complete',
						title: $LL.admin_flows_palette_end_label(),
						position: { x: 594, y: 612 },
						config: {
							ui_kind: 'end',
							completion_block: {
								id: 'oidc-authorization-completion',
								label: $LL.admin_flows_completion_block_oidc_authorization(),
								protocol: 'oidc',
								purpose: 'authorization',
								role: 'output'
							}
						}
					}
				],
				edges: [
					{
						id: 'request:next->session-check',
						source: 'request',
						source_handle: 'next',
						target: 'session-check'
					},
					{
						id: 'session-check:continue->saml-attribute-release-consent',
						source: 'session-check',
						source_handle: 'continue',
						target: 'saml-attribute-release-consent'
					},
					{
						id: 'session-check:continue->oidc-authorization-consent',
						source: 'session-check',
						source_handle: 'continue',
						target: 'oidc-authorization-consent'
					},
					{
						id: 'session-check:authenticate->authentication',
						source: 'session-check',
						source_handle: 'authenticate',
						target: 'authentication'
					},
					{
						id: 'authentication:mail_otp->saml-attribute-release-consent',
						source: 'authentication',
						source_handle: 'mail_otp',
						target: 'saml-attribute-release-consent'
					},
					{
						id: 'authentication:totp->saml-attribute-release-consent',
						source: 'authentication',
						source_handle: 'totp',
						target: 'saml-attribute-release-consent'
					},
					{
						id: 'authentication:mail_otp->oidc-authorization-consent',
						source: 'authentication',
						source_handle: 'mail_otp',
						target: 'oidc-authorization-consent'
					},
					{
						id: 'authentication:totp->oidc-authorization-consent',
						source: 'authentication',
						source_handle: 'totp',
						target: 'oidc-authorization-consent'
					},
					{
						id: 'authentication:passkey->saml-attribute-release-consent',
						source: 'authentication',
						source_handle: 'passkey',
						target: 'saml-attribute-release-consent'
					},
					{
						id: 'authentication:passkey->oidc-authorization-consent',
						source: 'authentication',
						source_handle: 'passkey',
						target: 'oidc-authorization-consent'
					},
					{
						id: 'authentication:facebook->saml-attribute-release-consent',
						source: 'authentication',
						source_handle: 'facebook',
						target: 'saml-attribute-release-consent'
					},
					{
						id: 'authentication:facebook->oidc-authorization-consent',
						source: 'authentication',
						source_handle: 'facebook',
						target: 'oidc-authorization-consent'
					},
					{
						id: 'saml-attribute-release-consent:accepted->saml-attribute-release-complete',
						source: 'saml-attribute-release-consent',
						source_handle: 'accepted',
						target: 'saml-attribute-release-complete'
					},
					{
						id: 'oidc-authorization-consent:accepted->oidc-authorization-complete',
						source: 'oidc-authorization-consent',
						source_handle: 'accepted',
						target: 'oidc-authorization-complete'
					}
				],
				viewport: { x: 36, y: 36, zoom: 1 }
			};
		}

		return {
			nodes: [
				{
					id: 'request',
					type: 'entry',
					title: flow.primaryEntry,
					position: createPosition(0),
					config: { ui_kind: 'start' }
				},
				{
					id: 'consent',
					type: 'consent',
					title: flow.consentPolicy,
					position: createPosition(1),
					config: {
						ui_kind: 'consent',
						consent_policy_ref:
							flow.id === 'saml-attribute-release'
								? 'saml_attribute_release_policy'
								: 'oidc_authorization_consent_policy'
					}
				},
				{
					id: 'complete',
					type: 'complete',
					title: $LL.admin_flows_palette_end_label(),
					position: createPosition(2),
					config: { ui_kind: 'end' }
				}
			],
			edges: [
				{
					id: 'request:next->consent',
					source: 'request',
					source_handle: 'next',
					target: 'consent'
				},
				{
					id: 'consent:accepted->complete',
					source: 'consent',
					source_handle: 'accepted',
					target: 'complete'
				}
			],
			viewport: { x: 36, y: 36, zoom: 1 }
		};
	}

	async function createFlow(flow: NewFlowTemplate) {
		const text = getFlowTemplateText($LL, flow);
		creatingTemplateId = flow.id;
		createError = '';
		try {
			const response = await adminFlowsAPI.create({
				slug: flow.id,
				display_name: text.title,
				description: null,
				template_id: flow.id,
				kind: getTemplateKind(flow),
				editor: createTemplateEditorState(flow)
			});
			await goto(`/admin/flows/${response.flow.id}/edit`);
		} catch (error) {
			createError = error instanceof Error ? error.message : $LL.admin_flows_save_failed();
		} finally {
			creatingTemplateId = '';
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_flows_new_page_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_flows_new_title()}
		description={$LL.admin_flows_new_description()}
	>
		{#snippet actions()}
			<a href="/admin/flows" class="btn btn-secondary">
				<i class="i-ph-arrow-left" aria-hidden="true"></i>
				{$LL.admin_flows_back_to_list()}
			</a>
		{/snippet}
	</AdminPageHeader>

	<AdminSection title={$LL.admin_flows_templates_title()}>
		{#if createError}
			<div class="create-error" role="alert">
				{$LL.admin_flows_save_failed()}
				<span>{createError}</span>
			</div>
		{/if}
		<div class="template-grid">
			{#each localizedFlows as { flow, text } (flow.id)}
				<button
					type="button"
					class="template-card"
					disabled={!!creatingTemplateId}
					onclick={() => createFlow(flow)}
				>
					<div class="template-card__icon">
						<i
							class={flow.protocol === 'SAML' ? 'i-ph-arrows-left-right' : 'i-ph-monitor'}
							aria-hidden="true"
						></i>
					</div>
					<div>
						<strong>{text.title}</strong>
						<span>{text.subtitle}</span>
						<p>{text.description}</p>
					</div>
					{#if creatingTemplateId === flow.id}
						<small>{$LL.admin_flows_saving()}</small>
					{/if}
				</button>
			{/each}
		</div>
	</AdminSection>
</AdminPageShell>

<style>
	.btn {
		min-height: var(--control-height, 36px);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 0 13px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--color-surface);
		color: var(--color-text);
		font: inherit;
		font-weight: 800;
		text-decoration: none;
	}

	.btn:hover {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.template-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
		gap: 12px;
	}

	.create-error {
		margin-bottom: 12px;
		padding: 12px;
		border: 1px solid color-mix(in srgb, var(--color-danger) 54%, var(--color-border));
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		color: var(--color-danger);
		font-size: 0.86rem;
		font-weight: 800;
	}

	.create-error span {
		display: block;
		margin-top: 4px;
		font-size: 0.78rem;
		font-weight: 600;
	}

	.template-card {
		min-height: 156px;
		display: flex;
		gap: 14px;
		width: 100%;
		padding: 18px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		color: var(--color-text);
		font: inherit;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}

	.template-card:hover:not(:disabled) {
		border-color: var(--color-accent);
		background: var(--color-surface-muted);
	}

	.template-card:disabled {
		opacity: 0.72;
		cursor: wait;
	}

	.template-card__icon {
		width: 42px;
		height: 42px;
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-accent) 12%, transparent);
		color: var(--color-accent);
		font-size: 1.3rem;
	}

	.template-card strong,
	.template-card span {
		display: block;
	}

	.template-card strong {
		font-size: 1rem;
	}

	.template-card span {
		margin-top: 5px;
		color: var(--color-text-muted);
		font-size: 0.82rem;
		font-weight: 800;
	}

	.template-card p {
		margin: 10px 0 0;
		color: var(--color-text-muted);
		font-size: 0.86rem;
		line-height: 1.6;
	}

	.template-card small {
		margin-left: auto;
		color: var(--color-text-muted);
		font-size: 0.76rem;
		font-weight: 800;
		white-space: nowrap;
	}
</style>
