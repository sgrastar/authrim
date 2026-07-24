import type { TranslationFunctions } from '$i18n/i18n-types';
import type {
	FlowContractSummaryItem,
	FlowLink,
	FlowNodePreview,
	NewFlowTemplate,
	NewFlowTemplateId
} from '$lib/admin/new-flow-templates';
import { getNewFlowTemplate } from '$lib/admin/new-flow-templates';

type FlowEditorNodeKind =
	| 'start'
	| 'session'
	| 'registration'
	| 'authentication'
	| 'verification'
	| 'profile'
	| 'consent'
	| 'account'
	| 'end'
	| 'decision'
	| 'oidc_completion'
	| 'saml_completion';

export interface LocalizedFlowTemplateText {
	title: string;
	subtitle: string;
	description: string;
	primaryEntry: string;
	primaryOutput: string;
	mappingSet: string;
	consentPolicy: string;
	consentStatement: string;
	userAction: string;
	recordedState: string;
}

export interface FlowEditorOption {
	value: string;
	label: string;
	disabled?: boolean;
}

export interface FlowEditorAuthProfileOption extends FlowEditorOption {
	outputs: Array<{ id: string; label: string }>;
}

export interface FlowNodePaletteItem {
	kind: FlowEditorNodeKind;
	label: string;
	description: string;
}

function getAcademicSamlLoginText(LL: TranslationFunctions): LocalizedFlowTemplateText {
	if (LL.admin_flows_locale_marker() === 'ja') {
		return {
			title: 'Academic SAML Login',
			subtitle: '学術出版社・図書館系SP向けログイン',
			description:
				'SAML AuthnRequestからセッション確認、認証方式選択、属性送信確認、SAML Responseまでを確認します。',
			primaryEntry: 'SAML AuthnRequest',
			primaryOutput: 'SAML Response / Assertion',
			mappingSet: 'GakuNin application standard Field Mapping Set',
			consentPolicy: 'SAML attribute release policy',
			consentStatement: 'saml_attribute_release_uapprove',
			userAction: '既存アカウントでログインし、SPへ送信する属性を確認して許可',
			recordedState: 'tenant + user + SAML SP + statement/version + User Decision'
		};
	}
	return {
		title: 'Academic SAML Login',
		subtitle: 'Login for academic publisher and library SPs',
		description:
			'Review the path from SAML AuthnRequest, session check, authentication method selection, attribute release confirmation, and SAML Response.',
		primaryEntry: 'SAML AuthnRequest',
		primaryOutput: 'SAML Response / Assertion',
		mappingSet: 'GakuNin application standard Field Mapping Set',
		consentPolicy: 'SAML attribute release policy',
		consentStatement: 'saml_attribute_release_uapprove',
		userAction:
			'Sign in with an existing account, review the attributes released to the SP, and allow the release',
		recordedState: 'tenant + user + SAML SP + statement/version + User Decision'
	};
}

function getTemplateDefaultText(flow: NewFlowTemplate): LocalizedFlowTemplateText {
	return {
		title: flow.title,
		subtitle: flow.subtitle,
		description: flow.description,
		primaryEntry: flow.primaryEntry,
		primaryOutput: flow.primaryOutput,
		mappingSet: flow.mappingSet,
		consentPolicy: flow.consentPolicy,
		consentStatement: flow.consentStatement,
		userAction: flow.userAction,
		recordedState: flow.recordedState
	};
}

export function getFlowTemplateText(
	LL: TranslationFunctions,
	flow: NewFlowTemplate
): LocalizedFlowTemplateText {
	switch (flow.id) {
		case 'saml-attribute-release':
			return {
				title: LL.admin_flows_template_saml_attribute_release_title(),
				subtitle: LL.admin_flows_template_saml_attribute_release_subtitle(),
				description: LL.admin_flows_template_saml_attribute_release_description(),
				primaryEntry: LL.admin_flows_template_saml_attribute_release_primary_entry(),
				primaryOutput: LL.admin_flows_template_saml_attribute_release_primary_output(),
				mappingSet: LL.admin_flows_template_saml_attribute_release_mapping_set(),
				consentPolicy: LL.admin_flows_template_saml_attribute_release_consent_policy(),
				consentStatement: LL.admin_flows_template_saml_attribute_release_consent_statement(),
				userAction: LL.admin_flows_template_saml_attribute_release_user_action(),
				recordedState: LL.admin_flows_template_saml_attribute_release_recorded_state()
			};
		case 'oidc-authorization-consent':
			return {
				title: LL.admin_flows_template_oidc_authorization_consent_title(),
				subtitle: LL.admin_flows_template_oidc_authorization_consent_subtitle(),
				description: LL.admin_flows_template_oidc_authorization_consent_description(),
				primaryEntry: LL.admin_flows_template_oidc_authorization_consent_primary_entry(),
				primaryOutput: LL.admin_flows_template_oidc_authorization_consent_primary_output(),
				mappingSet: LL.admin_flows_template_oidc_authorization_consent_mapping_set(),
				consentPolicy: LL.admin_flows_template_oidc_authorization_consent_consent_policy(),
				consentStatement: LL.admin_flows_template_oidc_authorization_consent_consent_statement(),
				userAction: LL.admin_flows_template_oidc_authorization_consent_user_action(),
				recordedState: LL.admin_flows_template_oidc_authorization_consent_recorded_state()
			};
		case 'default-registration':
			return {
				title: LL.admin_flows_template_oidc_registration_title(),
				subtitle: LL.admin_flows_template_oidc_registration_subtitle(),
				description: LL.admin_flows_template_oidc_registration_description(),
				primaryEntry: LL.admin_flows_template_oidc_registration_primary_entry(),
				primaryOutput: LL.admin_flows_template_oidc_registration_primary_output(),
				mappingSet: LL.admin_flows_template_oidc_registration_mapping_set(),
				consentPolicy: LL.admin_flows_template_oidc_registration_consent_policy(),
				consentStatement: LL.admin_flows_template_oidc_registration_consent_statement(),
				userAction: LL.admin_flows_template_oidc_registration_user_action(),
				recordedState: LL.admin_flows_template_oidc_registration_recorded_state()
			};
		case 'default-registration-no-consent':
			return getTemplateDefaultText(flow);
		case 'academic-saml-login':
			return getAcademicSamlLoginText(LL);
		case 'default-login':
			return {
				title: LL.admin_flows_template_oidc_login_title(),
				subtitle: LL.admin_flows_template_oidc_login_subtitle(),
				description: LL.admin_flows_template_oidc_login_description(),
				primaryEntry: LL.admin_flows_template_oidc_login_primary_entry(),
				primaryOutput: LL.admin_flows_template_oidc_login_primary_output(),
				mappingSet: LL.admin_flows_template_oidc_login_mapping_set(),
				consentPolicy: LL.admin_flows_template_oidc_login_consent_policy(),
				consentStatement: LL.admin_flows_template_oidc_login_consent_statement(),
				userAction: LL.admin_flows_template_oidc_login_user_action(),
				recordedState: LL.admin_flows_template_oidc_login_recorded_state()
			};
		case 'default-login-no-consent':
		case 'saml-sp-oidc-rp':
			return getTemplateDefaultText(flow);
	}
}

export function getSavedFlowDescription(
	LL: TranslationFunctions,
	flow: { description?: string | null; template_id?: string | null; slug?: string | null }
): string {
	const explicitDescription = flow.description?.trim();
	if (explicitDescription) return explicitDescription;
	const template = flow.template_id ? getNewFlowTemplate(flow.template_id) : undefined;
	if (template) return getFlowTemplateText(LL, template).description;
	return flow.slug ?? '';
}

export function getFlowStatusLabel(
	LL: TranslationFunctions,
	status: NewFlowTemplate['status']
): string {
	return status === 'preview' ? LL.admin_flows_status_preview() : LL.admin_flows_status_planning();
}

export function getFlowKindLabel(LL: TranslationFunctions, flowKind: string): string {
	switch (flowKind) {
		case 'release_confirmation':
			return LL.admin_flows_kind_release_confirmation();
		case 'authorization':
			return LL.admin_flows_kind_authorization();
		case 'registration':
			return LL.admin_flows_kind_registration();
		case 'login':
			return LL.admin_flows_kind_login();
		default:
			return flowKind;
	}
}

export function getFlowDestinationLabel(LL: TranslationFunctions, destinationType: string): string {
	switch (destinationType) {
		case 'SAML Service Provider':
			return LL.admin_flows_destination_saml_sp();
		case 'OIDC Client':
			return LL.admin_flows_destination_oidc_client();
		default:
			return destinationType;
	}
}

export function getLocalizedFlowNodes(
	LL: TranslationFunctions,
	flow: NewFlowTemplate
): FlowNodePreview[] {
	return flow.nodes.map((node) => getLocalizedFlowNode(LL, flow.id, node));
}

export function getLocalizedFlowNode(
	LL: TranslationFunctions,
	flowId: NewFlowTemplateId,
	node: FlowNodePreview
): FlowNodePreview {
	const text = getNodeText(LL, flowId, node);
	return {
		...node,
		label: text.label,
		description: text.description,
		settings: node.settings.map((setting) => translateFlowSetting(LL, setting)),
		links: node.links?.map((link) => translateFlowLink(LL, link))
	};
}

export function getLocalizedContractSummary(
	LL: TranslationFunctions,
	items: FlowContractSummaryItem[]
): FlowContractSummaryItem[] {
	return items.map((item) => ({
		label: translateContractSummaryLabel(LL, item.label),
		value: translateContractSummaryValue(LL, item.value)
	}));
}

export function getFlowNodePalette(LL: TranslationFunctions): FlowNodePaletteItem[] {
	return [
		{
			kind: 'start',
			label: LL.admin_flows_palette_start_label(),
			description: LL.admin_flows_palette_start_description()
		},
		{
			kind: 'session',
			label: LL.admin_flows_node_session_check(),
			description: LL.admin_flows_node_oidc_login_session_description()
		},
		{
			kind: 'registration',
			label: LL.admin_flows_palette_registration_label(),
			description: LL.admin_flows_palette_registration_description()
		},
		{
			kind: 'authentication',
			label: LL.admin_flows_palette_authentication_label(),
			description: LL.admin_flows_palette_authentication_description()
		},
		{
			kind: 'verification',
			label: LL.admin_flows_palette_verification_label(),
			description: LL.admin_flows_palette_verification_description()
		},
		{
			kind: 'profile',
			label: LL.admin_flows_palette_profile_label(),
			description: LL.admin_flows_palette_profile_description()
		},
		{
			kind: 'consent',
			label: LL.admin_flows_palette_consent_label(),
			description: LL.admin_flows_palette_consent_description()
		},
		{
			kind: 'decision',
			label: LL.admin_flows_palette_condition_label(),
			description: LL.admin_flows_palette_condition_description()
		},
		{
			kind: 'account',
			label: LL.admin_flows_palette_account_label(),
			description: LL.admin_flows_palette_account_description()
		},
		{
			kind: 'end',
			label: LL.admin_flows_palette_end_label(),
			description: LL.admin_flows_palette_end_description()
		},
		{
			kind: 'oidc_completion',
			label: LL.admin_flows_completion_block_oidc_authorization(),
			description: LL.admin_flows_node_oidc_authorization_output_description()
		},
		{
			kind: 'saml_completion',
			label: LL.admin_flows_completion_block_saml_attribute_release(),
			description: LL.admin_flows_node_saml_output_description()
		}
	];
}

export function getFlowAuthProfileOptions(LL: TranslationFunctions): FlowEditorAuthProfileOption[] {
	return [
		{
			value: 'default',
			label: LL.admin_flows_auth_profile_default(),
			outputs: [
				{ id: 'mail_otp', label: LL.admin_flows_setting_email_otp() },
				{ id: 'totp', label: LL.admin_flows_setting_totp() },
				{ id: 'passkey', label: LL.admin_flows_setting_passkey() },
				{ id: 'facebook', label: 'Facebook' }
			]
		}
	];
}

export function getFlowScreenOptions(LL: TranslationFunctions): FlowEditorOption[] {
	return [
		{ value: 'basic_profile', label: LL.admin_flows_screen_basic() },
		{ value: 'email_name', label: LL.admin_flows_screen_email_name() },
		{ value: 'academic_profile', label: LL.admin_flows_screen_academic() }
	];
}

export function getFlowConsentPolicyOptions(LL: TranslationFunctions): FlowEditorOption[] {
	return [
		{ value: 'registration_consent_policy', label: LL.admin_flows_consent_policy_registration() },
		{
			value: 'oidc_authorization_consent_policy',
			label: LL.admin_flows_consent_policy_oidc_authorization()
		},
		{
			value: 'saml_attribute_release_policy',
			label: LL.admin_flows_consent_policy_saml_attribute_release()
		}
	];
}

function getNodeText(
	LL: TranslationFunctions,
	flowId: NewFlowTemplateId,
	node: FlowNodePreview
): Pick<FlowNodePreview, 'label' | 'description'> {
	const nodeKey = `${flowId}:${node.id}`;
	switch (nodeKey) {
		case 'saml-attribute-release:request':
			return {
				label: LL.admin_flows_node_protocol_request(),
				description: LL.admin_flows_node_saml_request_description()
			};
		case 'saml-attribute-release:mapping':
			return {
				label: LL.admin_flows_node_schema_mapping(),
				description: LL.admin_flows_node_saml_mapping_description()
			};
		case 'saml-attribute-release:consent':
			return {
				label: LL.admin_flows_node_consent(),
				description: LL.admin_flows_node_saml_consent_description()
			};
		case 'saml-attribute-release:contract':
			return {
				label: LL.admin_flows_node_contract(),
				description: LL.admin_flows_node_saml_contract_description()
			};
		case 'saml-attribute-release:output':
			return {
				label: LL.admin_flows_node_output(),
				description: LL.admin_flows_node_saml_output_description()
			};
		case 'oidc-authorization-consent:request':
			return {
				label: LL.admin_flows_node_protocol_request(),
				description: LL.admin_flows_node_oidc_authorization_request_description()
			};
		case 'oidc-authorization-consent:mapping':
			return {
				label: LL.admin_flows_node_schema_mapping(),
				description: LL.admin_flows_node_oidc_authorization_mapping_description()
			};
		case 'oidc-authorization-consent:consent':
			return {
				label: LL.admin_flows_node_consent(),
				description: LL.admin_flows_node_oidc_authorization_consent_description()
			};
		case 'oidc-authorization-consent:contract':
			return {
				label: LL.admin_flows_node_contract(),
				description: LL.admin_flows_node_oidc_authorization_contract_description()
			};
		case 'oidc-authorization-consent:output':
			return {
				label: LL.admin_flows_node_output(),
				description: LL.admin_flows_node_oidc_authorization_output_description()
			};
		case 'default-registration:request':
		case 'default-registration-no-consent:request':
			return {
				label: LL.admin_flows_node_registration_request(),
				description: LL.admin_flows_node_oidc_registration_request_description()
			};
		case 'default-registration:registration-method':
		case 'default-registration-no-consent:registration-method':
			return {
				label: LL.admin_flows_node_registration_method(),
				description: LL.admin_flows_node_oidc_registration_method_description()
			};
		case 'default-registration:profile-input':
			return {
				label: LL.admin_flows_node_profile_input(),
				description: LL.admin_flows_node_oidc_registration_profile_description()
			};
		case 'default-registration:consent':
			return {
				label: LL.admin_flows_node_consent(),
				description: LL.admin_flows_node_oidc_registration_consent_description()
			};
		case 'default-registration:account-create':
		case 'default-registration-no-consent:account-create':
			return {
				label: LL.admin_flows_node_account_creation(),
				description: LL.admin_flows_node_oidc_registration_account_description()
			};
		case 'default-registration:output':
		case 'default-registration-no-consent:output':
			return {
				label: LL.admin_flows_node_output(),
				description: LL.admin_flows_node_oidc_registration_output_description()
			};
		case 'default-login:request':
		case 'default-login-no-consent:request':
			return {
				label: LL.admin_flows_node_login_request(),
				description: LL.admin_flows_node_oidc_login_request_description()
			};
		case 'default-login:session-check':
		case 'default-login-no-consent:session-check':
			return {
				label: LL.admin_flows_node_session_check(),
				description: LL.admin_flows_node_oidc_login_session_description()
			};
		case 'default-login:authentication':
		case 'default-login-no-consent:authentication':
			return {
				label: LL.admin_flows_node_authentication_method(),
				description: LL.admin_flows_node_oidc_login_authentication_description()
			};
		case 'default-login:consent':
			return {
				label: LL.admin_flows_node_consent(),
				description: LL.admin_flows_node_oidc_login_consent_description()
			};
		case 'default-login:output':
		case 'default-login-no-consent:oidc-authorization-complete':
			return {
				label: LL.admin_flows_node_output(),
				description: LL.admin_flows_node_oidc_login_output_description()
			};
		case 'default-login-no-consent:saml-attribute-release-complete':
			return {
				label: LL.admin_flows_node_output(),
				description: LL.admin_flows_node_saml_output_description()
			};
		default:
			return {
				label: node.label,
				description: node.description
			};
	}
}

function translateFlowSetting(LL: TranslationFunctions, setting: string): string {
	switch (setting) {
		case 'SAML SP':
			return LL.admin_flows_setting_saml_sp();
		case 'AuthnContext':
			return LL.admin_flows_setting_authn_context();
		case '署名検証':
			return LL.admin_flows_setting_signature_validation();
		case 'Destination Field Mapping Set':
			return LL.admin_flows_setting_destination_field_mapping_set();
		case '送信対象フィールド':
		case '送信属性':
			return LL.admin_flows_setting_release_fields();
		case '属性名変換':
			return LL.admin_flows_setting_attribute_name_mapping();
		case 'Consent Policy':
			return LL.admin_flows_setting_consent_policy();
		case 'Consent Statement':
			return LL.admin_flows_setting_consent_statement();
		case 'User Decision':
			return LL.admin_flows_setting_user_decision();
		case 'localized_content':
			return LL.admin_flows_setting_localized_content();
		case 'required capabilities':
			return LL.admin_flows_setting_required_capabilities();
		case 'submit endpoint':
			return LL.admin_flows_setting_submit_endpoint();
		case '監査証跡':
			return LL.admin_flows_setting_audit_evidence();
		case 'SAML Assertion':
			return LL.admin_flows_setting_saml_assertion();
		case 'OIDC Client':
			return LL.admin_flows_setting_oidc_client();
		case 'redirect_uri':
			return LL.admin_flows_setting_redirect_uri();
		case 'scope / prompt / max_age':
			return LL.admin_flows_setting_scope_prompt_max_age();
		case 'Identity Schema':
			return LL.admin_flows_setting_identity_schema();
		case 'claim policy':
			return LL.admin_flows_setting_claim_policy();
		case 'authorization code':
			return LL.admin_flows_setting_authorization_code();
		case 'ID Token claims':
			return LL.admin_flows_setting_id_token_claims();
		case 'UserInfo claims':
			return LL.admin_flows_setting_userinfo_claims();
		case 'prompt=create / screen=signup':
			return LL.admin_flows_setting_prompt_create_signup();
		case 'Passkey':
			return LL.admin_flows_setting_passkey();
		case 'Email OTP':
			return LL.admin_flows_setting_email_otp();
		case 'Authenticator app':
			return LL.admin_flows_setting_totp();
		case 'Social account':
			return LL.admin_flows_setting_social_account();
		case 'required fields':
			return LL.admin_flows_setting_required_fields();
		case 'validation':
			return LL.admin_flows_setting_validation();
		case 'Terms of Service':
			return LL.admin_flows_setting_terms_of_service();
		case 'Privacy Policy':
			return LL.admin_flows_setting_privacy_policy();
		case 'Registration consent':
			return LL.admin_flows_setting_registration_consent();
		case 'user record':
			return LL.admin_flows_setting_user_record();
		case 'credential binding':
			return LL.admin_flows_setting_credential_binding();
		case 'audit event':
			return LL.admin_flows_setting_audit_event();
		case 'existing session':
			return LL.admin_flows_setting_existing_session();
		case 'prompt=login':
			return LL.admin_flows_setting_prompt_login();
		case 'max_age / acr':
			return LL.admin_flows_setting_max_age_acr();
		case 'Password / OTP':
			return LL.admin_flows_setting_password_otp();
		case 'Social login':
			return LL.admin_flows_setting_social_login();
		case 'scope / claims':
			return LL.admin_flows_setting_scope_claims();
		case 'Application context':
			return LL.admin_flows_setting_application_context();
		default:
			return setting;
	}
}

function translateFlowLink(LL: TranslationFunctions, link: FlowLink): FlowLink {
	switch (link.label) {
		case 'SAML SP設定':
			return { ...link, label: LL.admin_flows_link_saml_sp_settings() };
		case 'OIDC Client設定':
			return { ...link, label: LL.admin_flows_link_oidc_client_settings() };
		case 'Field Mapping Set':
			return { ...link, label: LL.admin_flows_link_field_mapping_set_title() };
		case '同意ポリシー':
			return { ...link, label: LL.admin_flows_consent_policies() };
		case '同意文':
			return { ...link, label: LL.admin_flows_link_consent_statement_title() };
		case '認証方法':
			return { ...link, label: LL.admin_flows_link_authentication_methods() };
		case 'スキーマ設定':
			return { ...link, label: LL.admin_flows_link_schema_settings() };
		default:
			return link;
	}
}

function translateContractSummaryLabel(LL: TranslationFunctions, label: string): string {
	switch (label) {
		case 'Flow kind':
			return LL.admin_flows_contract_label_flow_kind();
		case 'Protocol':
			return LL.admin_flows_contract_label_protocol();
		case 'Destination':
			return LL.admin_flows_contract_label_destination();
		case 'Field Mapping Set':
			return LL.admin_flows_contract_label_field_mapping_set();
		case 'Required user action':
			return LL.admin_flows_contract_label_required_user_action();
		case 'Continuation':
			return LL.admin_flows_contract_label_continuation();
		case 'Profile input':
			return LL.admin_flows_contract_label_profile_input();
		case 'Authentication':
			return LL.admin_flows_contract_label_authentication();
		default:
			return label;
	}
}

function translateContractSummaryValue(LL: TranslationFunctions, value: string): string {
	switch (value) {
		case 'release_confirmation':
			return LL.admin_flows_kind_release_confirmation();
		case 'authorization':
			return LL.admin_flows_kind_authorization();
		case 'registration':
			return LL.admin_flows_kind_registration();
		case 'login':
			return LL.admin_flows_kind_login();
		case 'SAML SP':
			return LL.admin_flows_contract_value_saml_sp();
		case 'OIDC Client':
			return LL.admin_flows_contract_value_oidc_client();
		case 'GakuNin application standard':
			return LL.admin_flows_contract_value_gakunin_standard();
		case 'User Decision':
			return LL.admin_flows_contract_value_user_decision();
		case 'SAML Response generation':
			return LL.admin_flows_contract_value_saml_response_generation();
		case 'Consent approval':
			return LL.admin_flows_contract_value_consent_approval();
		case 'Authorization response':
			return LL.admin_flows_contract_value_authorization_response();
		case 'Registration fields':
			return LL.admin_flows_contract_value_registration_fields();
		case 'Create account + consent':
			return LL.admin_flows_contract_value_create_account_consent();
		case 'Configured login methods':
			return LL.admin_flows_contract_value_configured_login_methods();
		case 'Authenticate + optional consent':
			return LL.admin_flows_contract_value_authenticate_optional_consent();
		default:
			return value;
	}
}
