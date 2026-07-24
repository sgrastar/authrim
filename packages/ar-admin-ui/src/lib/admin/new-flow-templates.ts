export type NewFlowTemplateId =
	| 'saml-attribute-release'
	| 'default-registration'
	| 'default-registration-no-consent'
	| 'academic-saml-login'
	| 'default-login'
	| 'default-login-no-consent'
	| 'saml-sp-oidc-rp'
	| 'oidc-authorization-consent';

export interface FlowLink {
	label: string;
	href: string;
}

export interface FlowNodePreview {
	id: string;
	label: string;
	description: string;
	icon: string;
	settings: string[];
	links?: FlowLink[];
}

export interface FlowContractSummaryItem {
	label: string;
	value: string;
}

export interface NewFlowTemplate {
	id: NewFlowTemplateId;
	title: string;
	subtitle: string;
	protocol: 'SAML' | 'OIDC' | 'SAML / OIDC';
	destinationType: string;
	flowKind: string;
	status: 'planning' | 'preview';
	description: string;
	primaryEntry: string;
	primaryOutput: string;
	mappingSet: string;
	consentPolicy: string;
	consentStatement: string;
	userAction: string;
	recordedState: string;
	nodes: FlowNodePreview[];
	contractSummary: FlowContractSummaryItem[];
	contract: Record<string, unknown>;
}

export interface LoginUiRuntimeContractPreview {
	schema_version: 'authrim.login_ui.contract.v1';
	mode: 'preview';
	runtime: {
		flow_kind: string;
		flow_id: string;
		runtime_bindings: {
			authentication_method_profile?: string;
			consent_policy_ref?: string;
			field_mapping_set_ref?: string;
			consent_statement_ref?: string;
		};
		protocol_context: {
			protocol: string;
			preview: true;
			destination: {
				type: string;
				display_name?: string;
			};
		};
		ui: {
			steps: Array<{
				id: string;
				source_node_id: string;
				component: string;
				render: boolean;
				config: Record<string, unknown>;
				content: {
					title: string;
					description: string;
					settings: string[];
					links?: FlowLink[];
				};
			}>;
		};
		capabilities: unknown[];
		submit: unknown;
		output: unknown;
	};
	preview: {
		contract_id: string;
		interaction_id: string;
		flow: {
			id: NewFlowTemplateId;
			kind: string;
			protocol: string;
			status: NewFlowTemplate['status'];
			title: string;
			entry: string;
			output: string;
		};
	};
	editor: {
		nodes: Array<{
			id: string;
			type: string;
			title: string;
			position: { x: number; y: number };
			config: Record<string, unknown>;
		}>;
		edges: Array<{
			id: string;
			source: string;
			source_handle?: string;
			target: string;
		}>;
		viewport: { x: number; y: number; zoom: number };
	};
}

const allNewFlowTemplates: NewFlowTemplate[] = [
	{
		id: 'saml-attribute-release',
		title: 'SAML Attribute Release',
		subtitle: 'SAML SPへの属性送信確認',
		protocol: 'SAML',
		destinationType: 'SAML Service Provider',
		flowKind: 'release_confirmation',
		status: 'preview',
		description:
			'SAML AuthnRequestからSP、Field Mapping Set、同意文、ユーザー選択、SAML Responseまでを一直線で確認します。',
		primaryEntry: 'SAML AuthnRequest',
		primaryOutput: 'SAML Response / Assertion',
		mappingSet: 'GakuNin application standard Field Mapping Set',
		consentPolicy: 'SAML attribute release policy',
		consentStatement: 'saml_attribute_release_uapprove',
		userAction: '送信属性を確認し、今回のみ許可または今後も許可を選択',
		recordedState: 'tenant + user + SAML SP + statement/version + User Decision',
		nodes: [
			{
				id: 'request',
				label: 'Protocol Request',
				description: 'SAML AuthnRequestを受け取り、対象SPと要求コンテキストを解決します。',
				icon: 'i-ph-arrows-left-right',
				settings: ['SAML SP', 'AuthnContext', '署名検証'],
				links: [{ label: 'SAML SP設定', href: '/admin/saml' }]
			},
			{
				id: 'mapping',
				label: 'Schema Mapping',
				description: 'Identity SchemaからSPへ送る属性セットを決定します。',
				icon: 'i-ph-graph',
				settings: ['Destination Field Mapping Set', '送信対象フィールド', '属性名変換'],
				links: [
					{
						label: 'Field Mapping Set',
						href: '/admin/field-mapping/field-mapping-sets'
					}
				]
			},
			{
				id: 'consent',
				label: 'Consent',
				description: '送信属性と同意文をLoginUIで表示し、ユーザーの選択を受け取ります。',
				icon: 'i-ph-handshake',
				settings: ['Consent Policy', 'Consent Statement', 'User Decision'],
				links: [
					{ label: '同意ポリシー', href: '/admin/consent-policies' },
					{ label: '同意文', href: '/admin/consent-statements' }
				]
			},
			{
				id: 'output',
				label: 'Output',
				description: '選択結果を記録し、許可された属性でSAML Responseを生成します。',
				icon: 'i-ph-paper-plane-tilt',
				settings: ['監査証跡', '送信属性', 'SAML Assertion']
			}
		],
		contractSummary: [
			{ label: 'Flow kind', value: 'release_confirmation' },
			{ label: 'Protocol', value: 'SAML' },
			{ label: 'Destination', value: 'SAML SP' },
			{ label: 'Field Mapping Set', value: 'GakuNin application standard' },
			{ label: 'Required user action', value: 'User Decision' },
			{ label: 'Continuation', value: 'SAML Response generation' }
		],
		contract: {
			contract_version: '2026-06-29',
			interaction_id: 'preview_saml_attribute_release',
			flow_kind: 'release_confirmation',
			protocol: 'saml',
			destination: {
				type: 'saml_sp',
				display_name: 'Example Academic Publisher'
			},
			capabilities: [
				{
					type: 'release_confirmation',
					required: true,
					localized_content: {
						ja: 'このサービスに以下の属性を送信します。',
						en: 'The following attributes will be released to this service.'
					},
					i18n_key: 'flow.saml.release_confirmation',
					options: [
						{ value: 'once', label: { ja: '今回のみ許可', en: 'Allow once' } },
						{ value: 'always', label: { ja: '今後も許可', en: 'Always allow' } }
					],
					fields: ['display_name', 'email', 'affiliation']
				}
			],
			submit: {
				method: 'POST',
				url: '/api/flow/interactions/preview_saml_attribute_release/submit'
			},
			output: {
				continuation: 'saml_response',
				records: ['user_decision', 'audit_event']
			}
		}
	},
	{
		id: 'oidc-authorization-consent',
		title: 'OIDC Authorization Consent',
		subtitle: 'OIDC Clientへのscope/claim送信確認',
		protocol: 'OIDC',
		destinationType: 'OIDC Client',
		flowKind: 'authorization',
		status: 'planning',
		description:
			'OIDC authorization requestからclient、scope/claim、同意文、承認結果、authorization responseまでを確認します。',
		primaryEntry: 'OIDC Authorization Request',
		primaryOutput: 'Authorization Response / UserInfo grant',
		mappingSet: 'OIDC standard claims',
		consentPolicy: 'OIDC authorization consent policy',
		consentStatement: 'oidc_authorization_consent',
		userAction: 'scopeとclaimの提供内容を確認して許可',
		recordedState: 'tenant + user + OIDC Client + statement/version + User Decision',
		nodes: [
			{
				id: 'request',
				label: 'Protocol Request',
				description: 'OIDC authorization requestを受け取り、clientと要求scopeを解決します。',
				icon: 'i-ph-monitor',
				settings: ['OIDC Client', 'redirect_uri', 'scope / prompt / max_age'],
				links: [{ label: 'OIDC Client設定', href: '/admin/clients' }]
			},
			{
				id: 'mapping',
				label: 'Schema Mapping',
				description: '要求scopeとclaimに対して、実際に返せるユーザー属性を決定します。',
				icon: 'i-ph-graph',
				settings: ['Identity Schema', 'Destination Field Mapping Set', 'claim policy'],
				links: [
					{
						label: 'Field Mapping Set',
						href: '/admin/field-mapping/field-mapping-sets'
					}
				]
			},
			{
				id: 'consent',
				label: 'Consent',
				description: 'LoginUIでscope/claim提供内容を表示し、承認結果を受け取ります。',
				icon: 'i-ph-handshake',
				settings: ['Consent Policy', 'Consent Statement', 'User Decision'],
				links: [
					{ label: '同意ポリシー', href: '/admin/consent-policies' },
					{ label: '同意文', href: '/admin/consent-statements' }
				]
			},
			{
				id: 'output',
				label: 'Output',
				description: '承認結果を記録し、許可されたscope/claimを後続レスポンスへ反映します。',
				icon: 'i-ph-key',
				settings: ['authorization code', 'ID Token claims', 'UserInfo claims']
			}
		],
		contractSummary: [
			{ label: 'Flow kind', value: 'authorization' },
			{ label: 'Protocol', value: 'OIDC' },
			{ label: 'Destination', value: 'OIDC Client' },
			{ label: 'Field Mapping Set', value: 'OIDC standard claims' },
			{ label: 'Required user action', value: 'Consent approval' },
			{ label: 'Continuation', value: 'Authorization response' }
		],
		contract: {
			contract_version: '2026-06-29',
			interaction_id: 'preview_oidc_authorization_consent',
			flow_kind: 'authorization',
			protocol: 'oidc',
			destination: {
				type: 'oidc_client',
				display_name: 'Example Web App'
			},
			capabilities: [
				{
					type: 'release_confirmation',
					required: true,
					localized_content: {
						ja: 'このアプリケーションに以下の情報を提供します。',
						en: 'The following information will be shared with this application.'
					},
					i18n_key: 'flow.oidc.authorization_consent',
					options: [{ value: 'approve', label: { ja: '許可する', en: 'Approve' } }],
					fields: ['sub', 'email', 'profile']
				}
			],
			submit: {
				method: 'POST',
				url: '/api/flow/interactions/preview_oidc_authorization_consent/submit'
			},
			output: {
				continuation: 'authorization_response',
				records: ['user_decision', 'audit_event']
			}
		}
	},
	{
		id: 'default-registration',
		title: 'Registration',
		subtitle: 'アプリケーション向け新規登録',
		protocol: 'OIDC',
		destinationType: 'OIDC Client',
		flowKind: 'registration',
		status: 'planning',
		description:
			'OIDC authorization requestから新規登録、プロフィール入力、同意、アカウント作成、authorization responseまでを確認します。',
		primaryEntry: 'OIDC Authorization Request / Sign-up entry',
		primaryOutput: 'Authorization Response / New Account Session',
		mappingSet: 'OIDC registration profile fields',
		consentPolicy: 'Registration consent policy',
		consentStatement: 'terms_of_service / privacy_policy',
		userAction: '登録方法を選び、プロフィールを入力し、利用規約とプライバシーポリシーに同意',
		recordedState: 'tenant + user + OIDC Client + registration screen + consent statements',
		nodes: [
			{
				id: 'request',
				label: 'Registration Request',
				description:
					'OIDC authorization requestを受け取り、clientと登録開始コンテキストを解決します。',
				icon: 'i-ph-monitor',
				settings: ['Application context', 'redirect_uri', 'prompt=create / screen=signup'],
				links: [{ label: 'OIDC Client設定', href: '/admin/clients' }]
			},
			{
				id: 'registration-method',
				label: 'Registration Method',
				description: 'Passkey、メール、ソーシャルなど、登録時に使える認証方式を提示します。',
				icon: 'i-ph-sign-in',
				settings: ['Passkey', 'Email OTP', 'Social account'],
				links: [{ label: '認証方法', href: '/admin/authentication-methods' }]
			},
			{
				id: 'profile-input',
				label: 'Profile Input',
				description:
					'登録に必要なIdentity Schema項目を入力させ、検証結果をアカウント作成に渡します。',
				icon: 'i-ph-identification-card',
				settings: ['Identity Schema', 'required fields', 'validation'],
				links: [{ label: 'スキーマ設定', href: '/admin/custom-claims' }]
			},
			{
				id: 'consent',
				label: 'Consent',
				description: '利用規約、プライバシーポリシー、任意の登録同意をLoginUIで表示します。',
				icon: 'i-ph-handshake',
				settings: ['Terms of Service', 'Privacy Policy', 'Registration consent'],
				links: [
					{ label: '同意ポリシー', href: '/admin/consent-policies' },
					{ label: '同意文', href: '/admin/consent-statements' }
				]
			},
			{
				id: 'account-create',
				label: 'Account Creation',
				description: 'ユーザー、認証手段、同意履歴、監査イベントを作成します。',
				icon: 'i-ph-user-plus',
				settings: ['user record', 'credential binding', 'audit event']
			},
			{
				id: 'output',
				label: 'Output',
				description: '登録後セッションを作成し、OIDC authorization responseへ接続します。',
				icon: 'i-ph-key',
				settings: ['authorization code', 'ID Token claims', 'post-registration redirect']
			}
		],
		contractSummary: [
			{ label: 'Flow kind', value: 'registration' },
			{ label: 'Protocol', value: 'OIDC' },
			{ label: 'Destination', value: 'OIDC Client' },
			{ label: 'Profile input', value: 'Registration fields' },
			{ label: 'Required user action', value: 'Create account + consent' },
			{ label: 'Continuation', value: 'Authorization response' }
		],
		contract: {
			contract_version: '2026-06-29',
			interaction_id: 'preview_oidc_registration',
			flow_kind: 'registration',
			protocol: 'oidc',
			destination: {
				type: 'oidc_client',
				display_name: 'Example Web App'
			},
			capabilities: [
				{
					type: 'authentication_method_selection',
					required: true,
					localized_content: {
						ja: 'アカウント作成に使用する方法を選択してください。',
						en: 'Choose how to create your account.'
					},
					i18n_key: 'flow.oidc.registration.method',
					methods: ['passkey', 'totp', 'email_otp', 'social']
				},
				{
					type: 'profile_input',
					required: true,
					localized_content: {
						ja: 'アカウント作成に必要な情報を入力してください。',
						en: 'Enter the information required to create your account.'
					},
					i18n_key: 'flow.oidc.registration.profile_input',
					fields: [
						{ name: 'email', required: true },
						{ name: 'name', required: true },
						{ name: 'preferred_username', required: false }
					]
				},
				{
					type: 'consent_statement',
					required: true,
					localized_content: {
						ja: '利用規約とプライバシーポリシーを確認してください。',
						en: 'Review the Terms of Service and Privacy Policy.'
					},
					i18n_key: 'flow.oidc.registration.consent',
					statements: ['terms_of_service', 'privacy_policy']
				}
			],
			submit: {
				method: 'POST',
				url: '/api/flow/interactions/preview_oidc_registration/submit'
			},
			output: {
				continuation: 'authorization_response',
				records: ['user_profile', 'credential_binding', 'consent_records', 'audit_event']
			}
		}
	},
	{
		id: 'default-registration-no-consent',
		title: 'Registration (No consent)',
		subtitle: 'プロフィール入力と登録同意なしの新規登録',
		protocol: 'OIDC',
		destinationType: 'OIDC Client',
		flowKind: 'registration',
		status: 'planning',
		description:
			'OIDC authorization requestから登録方式選択、アカウント作成、authorization responseまでを確認します。',
		primaryEntry: 'OIDC Authorization Request / Sign-up entry',
		primaryOutput: 'Authorization Response / New Account Session',
		mappingSet: 'OIDC registration profile fields',
		consentPolicy: '',
		consentStatement: '',
		userAction: '登録方法を選び、プロフィール入力と登録同意なしでアカウントを作成',
		recordedState: 'tenant + user + OIDC Client + credential binding + audit event',
		nodes: [
			{
				id: 'request',
				label: 'Registration Request',
				description:
					'OIDC authorization requestを受け取り、clientと登録開始コンテキストを解決します。',
				icon: 'i-ph-monitor',
				settings: ['Application context', 'redirect_uri', 'prompt=create / screen=signup'],
				links: [{ label: 'OIDC Client設定', href: '/admin/clients' }]
			},
			{
				id: 'registration-method',
				label: 'Registration Method',
				description: 'Passkey、メール、ソーシャルなど、登録時に使える認証方式を提示します。',
				icon: 'i-ph-sign-in',
				settings: ['Passkey', 'Email OTP', 'Social account'],
				links: [{ label: '認証方法', href: '/admin/authentication-methods' }]
			},
			{
				id: 'account-create',
				label: 'Account Creation',
				description: 'ユーザー、認証手段、監査イベントを作成します。',
				icon: 'i-ph-user-plus',
				settings: ['user record', 'credential binding', 'audit event']
			},
			{
				id: 'output',
				label: 'Complete',
				description: '登録後セッションを作成し、OIDC authorization responseへ接続します。',
				icon: 'i-ph-key',
				settings: ['authorization code', 'ID Token claims', 'post-registration redirect']
			}
		],
		contractSummary: [
			{ label: 'Flow kind', value: 'registration' },
			{ label: 'Protocol', value: 'OIDC' },
			{ label: 'Destination', value: 'OIDC Client' },
			{ label: 'Profile input', value: 'Skipped' },
			{ label: 'Required user action', value: 'Create account' },
			{ label: 'Continuation', value: 'Authorization response' }
		],
		contract: {
			contract_version: '2026-06-29',
			interaction_id: 'preview_oidc_registration_no_consent',
			flow_kind: 'registration',
			protocol: 'oidc',
			destination: {
				type: 'oidc_client',
				display_name: 'Example Web App'
			},
			capabilities: [
				{
					type: 'authentication_method_selection',
					required: true,
					localized_content: {
						ja: 'アカウント作成に使用する方法を選択してください。',
						en: 'Choose how to create your account.'
					},
					i18n_key: 'flow.oidc.registration.method',
					methods: ['passkey', 'totp', 'email_otp', 'social']
				}
			],
			submit: {
				method: 'POST',
				url: '/api/flow/interactions/preview_oidc_registration_no_consent/submit'
			},
			output: {
				continuation: 'authorization_response',
				records: ['credential_binding', 'audit_event']
			}
		}
	},
	{
		id: 'academic-saml-login',
		title: 'Academic SAML Login',
		subtitle: '学術出版社・図書館系SP向けログイン',
		protocol: 'SAML',
		destinationType: 'SAML Service Provider',
		flowKind: 'login',
		status: 'planning',
		description:
			'SAML AuthnRequestからセッション確認、認証方式選択、属性送信確認、SAML Responseまでを確認します。',
		primaryEntry: 'SAML AuthnRequest',
		primaryOutput: 'SAML Response / Assertion',
		mappingSet: 'GakuNin application standard Field Mapping Set',
		consentPolicy: 'SAML attribute release policy',
		consentStatement: 'saml_attribute_release_uapprove',
		userAction: '既存アカウントでログインし、SPへ送信する属性を確認して許可',
		recordedState: 'tenant + user + SAML SP + statement/version + User Decision',
		nodes: [
			{
				id: 'request',
				label: 'Entry',
				description:
					'Flowの開始点です。Academic SAML LoginではSAML AuthnRequestとSPコンテキストを受け取ります。',
				icon: 'i-ph-arrows-left-right',
				settings: ['SAML AuthnRequest', 'RelayState', 'SAML SP'],
				links: [{ label: 'SAML SP設定', href: '/admin/saml' }]
			},
			{
				id: 'session-check',
				label: 'Session Check',
				description: '既存セッション、ForceAuthn、AuthnContext要求を見て再認証が必要か判断します。',
				icon: 'i-ph-clock',
				settings: ['existing session', 'ForceAuthn', 'AuthnContext']
			},
			{
				id: 'authentication',
				label: 'Authentication Method',
				description: '利用可能なログイン方式を提示し、選択された方式で認証します。',
				icon: 'i-ph-sign-in',
				settings: ['Passkey', 'Email OTP', 'Directory / external IdP'],
				links: [{ label: '認証方法', href: '/admin/authentication-methods' }]
			},
			{
				id: 'saml-attribute-release-consent',
				label: 'Consent',
				description:
					'SAML SPへ送信する属性を表示し、今回のみ許可または今後も許可のユーザー選択を受け取ります。',
				icon: 'i-ph-handshake',
				settings: ['SAML attribute release policy', 'masked attribute values', 'User Decision'],
				links: [
					{ label: '同意ポリシー', href: '/admin/consent-policies' },
					{ label: '同意文', href: '/admin/consent-statements' },
					{
						label: 'Field Mapping Set',
						href: '/admin/field-mapping/field-mapping-sets'
					}
				]
			},
			{
				id: 'saml-attribute-release-complete',
				label: 'Complete',
				description: '許可された属性でSAML Responseを生成し、SPへ戻します。',
				icon: 'i-ph-paper-plane-tilt',
				settings: ['SAML Response', 'AttributeStatement', 'audit event']
			}
		],
		contractSummary: [
			{ label: 'Flow kind', value: 'login' },
			{ label: 'Protocol', value: 'SAML' },
			{ label: 'Destination', value: 'Academic SAML SP' },
			{ label: 'Field Mapping Set', value: 'GakuNin application standard' },
			{ label: 'Required user action', value: 'Authenticate + attribute release decision' },
			{ label: 'Continuation', value: 'SAML Response generation' }
		],
		contract: {
			contract_version: '2026-07-02',
			interaction_id: 'preview_academic_saml_login',
			flow_kind: 'login',
			protocol: 'saml',
			destination: {
				type: 'saml_sp',
				display_name: 'Example Academic Publisher'
			},
			capabilities: [
				{
					type: 'authentication',
					required: true,
					localized_content: {
						ja: 'ログイン方法を選択してください。',
						en: 'Choose a sign-in method.'
					},
					i18n_key: 'flow.academic_saml.login.authentication',
					methods: ['passkey', 'totp', 'email_otp', 'directory_password', 'external_idp']
				},
				{
					type: 'release_confirmation',
					required: true,
					localized_content: {
						ja: 'このSAML SPに送信する属性を確認してください。',
						en: 'Review the attributes released to this SAML service provider.'
					},
					i18n_key: 'flow.academic_saml.login.attribute_release',
					options: [
						{ value: 'once', label: { ja: '今回のみ許可', en: 'Allow this time only' } },
						{ value: 'always', label: { ja: '今後も許可', en: 'Always allow' } }
					],
					fields: ['displayName', 'mail', 'eduPersonScopedAffiliation']
				}
			],
			submit: {
				method: 'POST',
				url: '/api/flow/interactions/preview_academic_saml_login/submit'
			},
			output: {
				continuation: 'saml_response',
				records: ['session_event', 'authentication_event', 'user_decision', 'audit_event']
			}
		}
	},
	{
		id: 'default-login',
		title: 'Login',
		subtitle: 'アプリケーション向けログイン',
		protocol: 'OIDC',
		destinationType: 'OIDC Client',
		flowKind: 'login',
		status: 'planning',
		description:
			'OIDC authorization requestからセッション確認、認証方式選択、ログイン、必要な同意、authorization responseまでを確認します。',
		primaryEntry: 'OIDC Authorization Request / Login entry',
		primaryOutput: 'Authorization Response / Existing Account Session',
		mappingSet: 'OIDC login/session claims',
		consentPolicy: 'Login and authorization consent policy',
		consentStatement: 'oidc_authorization_consent',
		userAction: '既存アカウントでログインし、必要に応じてscope/claim提供を確認',
		recordedState: 'tenant + user + OIDC Client + session/authentication event + User Decision',
		nodes: [
			{
				id: 'request',
				label: 'Login Request',
				description:
					'OIDC authorization requestを受け取り、client、redirect_uri、要求scopeを解決します。',
				icon: 'i-ph-monitor',
				settings: ['Application context', 'redirect_uri', 'scope / prompt / max_age'],
				links: [{ label: 'OIDC Client設定', href: '/admin/clients' }]
			},
			{
				id: 'session-check',
				label: 'Session Check',
				description: '既存セッション、prompt、max_age、acr要求を見て再認証が必要か判断します。',
				icon: 'i-ph-clock',
				settings: ['existing session', 'authentication required', 'fresh authentication']
			},
			{
				id: 'authentication',
				label: 'Authentication Method',
				description: '利用可能なログイン方式を提示し、選択された方式で認証します。',
				icon: 'i-ph-sign-in',
				settings: ['Passkey', 'Password / OTP', 'Social login'],
				links: [{ label: '認証方法', href: '/admin/authentication-methods' }]
			},
			{
				id: 'consent',
				label: 'Consent',
				description: '必要な場合にscope/claim提供内容を表示し、ユーザーの承認を受け取ります。',
				icon: 'i-ph-handshake',
				settings: ['Consent Policy', 'scope / claims', 'User Decision'],
				links: [
					{ label: '同意ポリシー', href: '/admin/consent-policies' },
					{ label: '同意文', href: '/admin/consent-statements' }
				]
			},
			{
				id: 'output',
				label: 'Output',
				description: 'ログイン済みセッションと承認結果を使ってOIDC responseを生成します。',
				icon: 'i-ph-key',
				settings: ['authorization code', 'ID Token claims', 'UserInfo claims']
			}
		],
		contractSummary: [
			{ label: 'Flow kind', value: 'login' },
			{ label: 'Protocol', value: 'OIDC' },
			{ label: 'Destination', value: 'OIDC Client' },
			{ label: 'Authentication', value: 'Configured login methods' },
			{ label: 'Required user action', value: 'Authenticate + optional consent' },
			{ label: 'Continuation', value: 'Authorization response' }
		],
		contract: {
			contract_version: '2026-06-29',
			interaction_id: 'preview_oidc_login',
			flow_kind: 'login',
			protocol: 'oidc',
			destination: {
				type: 'oidc_client',
				display_name: 'Example Web App'
			},
			capabilities: [
				{
					type: 'authentication',
					required: true,
					localized_content: {
						ja: 'ログイン方法を選択してください。',
						en: 'Choose a sign-in method.'
					},
					i18n_key: 'flow.oidc.login.authentication',
					methods: ['passkey', 'totp', 'password', 'email_otp', 'social']
				},
				{
					type: 'release_confirmation',
					required: false,
					localized_content: {
						ja: 'このアプリケーションに提供する情報を確認してください。',
						en: 'Review the information shared with this application.'
					},
					i18n_key: 'flow.oidc.login.release_confirmation',
					fields: ['sub', 'email', 'profile']
				}
			],
			submit: {
				method: 'POST',
				url: '/api/flow/interactions/preview_oidc_login/submit'
			},
			output: {
				continuation: 'authorization_response',
				records: ['session_event', 'authentication_event', 'user_decision', 'audit_event']
			}
		}
	},
	{
		id: 'default-login-no-consent',
		title: 'Login (No consent)',
		subtitle: '同意確認なしのログイン',
		protocol: 'OIDC',
		destinationType: 'OIDC Client',
		flowKind: 'login',
		status: 'planning',
		description:
			'OIDC authorization requestからセッション確認、認証方式選択、ログイン、completion responseまでを確認します。',
		primaryEntry: 'OIDC Authorization Request / Login entry',
		primaryOutput: 'Authorization Response / Existing Account Session',
		mappingSet: 'OIDC login/session claims',
		consentPolicy: '',
		consentStatement: '',
		userAction: '既存アカウントでログイン',
		recordedState: 'tenant + user + OIDC Client + session/authentication event + audit event',
		nodes: [
			{
				id: 'request',
				label: 'Login Request',
				description:
					'OIDC authorization requestを受け取り、client、redirect_uri、要求scopeを解決します。',
				icon: 'i-ph-monitor',
				settings: ['Application context', 'redirect_uri', 'scope / prompt / max_age'],
				links: [{ label: 'OIDC Client設定', href: '/admin/clients' }]
			},
			{
				id: 'session-check',
				label: 'Session Check',
				description: '既存セッション、prompt、max_age、acr要求を見て再認証が必要か判断します。',
				icon: 'i-ph-clock',
				settings: ['existing session', 'authentication required', 'fresh authentication']
			},
			{
				id: 'authentication',
				label: 'Authentication Method',
				description: '利用可能なログイン方式を提示し、選択された方式で認証します。',
				icon: 'i-ph-sign-in',
				settings: ['Passkey', 'Password / OTP', 'Social login'],
				links: [{ label: '認証方法', href: '/admin/authentication-methods' }]
			},
			{
				id: 'saml-attribute-release-complete',
				label: 'Complete',
				description: 'ログイン済みセッションを使ってSAML Responseを生成します。',
				icon: 'i-ph-paper-plane-tilt',
				settings: ['SAML Response', 'AttributeStatement', 'audit event']
			},
			{
				id: 'oidc-authorization-complete',
				label: 'Complete',
				description: 'ログイン済みセッションを使ってOIDC responseを生成します。',
				icon: 'i-ph-key',
				settings: ['authorization code', 'ID Token claims', 'UserInfo claims']
			}
		],
		contractSummary: [
			{ label: 'Flow kind', value: 'login' },
			{ label: 'Protocol', value: 'OIDC' },
			{ label: 'Destination', value: 'OIDC Client' },
			{ label: 'Authentication', value: 'Configured login methods' },
			{ label: 'Required user action', value: 'Authenticate' },
			{ label: 'Continuation', value: 'Authorization response' }
		],
		contract: {
			contract_version: '2026-06-29',
			interaction_id: 'preview_oidc_login_no_consent',
			flow_kind: 'login',
			protocol: 'oidc',
			destination: {
				type: 'oidc_client',
				display_name: 'Example Web App'
			},
			capabilities: [
				{
					type: 'authentication',
					required: true,
					localized_content: {
						ja: 'ログイン方法を選択してください。',
						en: 'Choose a sign-in method.'
					},
					i18n_key: 'flow.oidc.login.authentication',
					methods: ['passkey', 'totp', 'password', 'email_otp', 'social']
				}
			],
			submit: {
				method: 'POST',
				url: '/api/flow/interactions/preview_oidc_login_no_consent/submit'
			},
			output: {
				continuation: 'authorization_response',
				records: ['session_event', 'authentication_event', 'audit_event']
			}
		}
	},
	{
		id: 'saml-sp-oidc-rp',
		title: 'SAML SP/OIDC RP Flow',
		subtitle: 'SAML SP・OIDC RP向けログイン',
		protocol: 'SAML / OIDC',
		destinationType: 'SAML SP / OIDC RP',
		flowKind: 'login',
		status: 'planning',
		description:
			'Login (No consent) と同じログイン処理を行い、認証後にリクエスト元のプロトコルを判定してSAML ResponseまたはOIDC authorization responseへ進みます。',
		primaryEntry: 'SAML AuthnRequest / OIDC Authorization Request',
		primaryOutput: 'SAML Response / OIDC Authorization Response',
		mappingSet: '',
		consentPolicy: '',
		consentStatement: '',
		userAction: '既存アカウントでログイン',
		recordedState: 'tenant + user + protocol target + session/authentication event + audit event',
		nodes: [
			{
				id: 'request',
				label: 'Login Request',
				description: 'SAML AuthnRequestまたはOIDC authorization requestを受け取ります。',
				icon: 'i-ph-monitor',
				settings: ['Trusted protocol context', 'SAML SP / OIDC RP']
			},
			{
				id: 'session-check',
				label: 'Session Check',
				description: '既存セッションを確認し、認証が必要か判断します。',
				icon: 'i-ph-clock',
				settings: ['existing session', 'authentication required']
			},
			{
				id: 'authentication',
				label: 'Authentication Method',
				description: 'Login (No consent) と同じ認証方法でログインします。',
				icon: 'i-ph-sign-in',
				settings: ['Passkey', 'Authenticator app', 'Email OTP'],
				links: [{ label: '認証方法', href: '/admin/authentication-methods' }]
			},
			{
				id: 'protocol-condition',
				label: 'Protocol Branch',
				description: 'リクエスト元がSAMLかOIDCかを判定します。',
				icon: 'i-ph-git-branch',
				settings: ['SAML', 'OIDC']
			},
			{
				id: 'saml-complete',
				label: 'SAML End',
				description: 'SAML Responseの生成処理へ戻します。',
				icon: 'i-ph-paper-plane-tilt',
				settings: ['SAML Response', 'AttributeStatement', 'audit event']
			},
			{
				id: 'oidc-complete',
				label: 'OIDC End',
				description: 'OIDC authorization responseの生成処理へ戻します。',
				icon: 'i-ph-key',
				settings: ['authorization code', 'ID Token claims', 'audit event']
			}
		],
		contractSummary: [
			{ label: 'Flow kind', value: 'login' },
			{ label: 'Protocol', value: 'SAML / OIDC' },
			{ label: 'Destination', value: 'SAML SP / OIDC RP' },
			{ label: 'Authentication', value: 'Configured login methods' },
			{ label: 'Required user action', value: 'Authenticate' },
			{ label: 'Continuation', value: 'SAML or OIDC response' }
		],
		contract: {
			contract_version: '2026-06-29',
			interaction_id: 'preview_saml_sp_oidc_rp',
			flow_kind: 'login',
			protocol: 'custom:saml-oidc',
			destination: {
				type: 'protocol_target',
				display_name: 'Resolved from the request'
			},
			capabilities: [
				{
					type: 'authentication',
					required: true,
					localized_content: {
						ja: 'ログイン方法を選択してください。',
						en: 'Choose a sign-in method.'
					},
					i18n_key: 'flow.login.authentication',
					methods: ['passkey', 'totp', 'email_otp']
				}
			],
			submit: {
				method: 'POST',
				url: '/api/flow/interactions/preview_saml_sp_oidc_rp/submit'
			},
			output: {
				continuation: 'protocol_response',
				records: ['session_event', 'authentication_event', 'audit_event']
			}
		}
	}
];

export const newFlowTemplates: NewFlowTemplate[] = allNewFlowTemplates.filter(
	(template) =>
		template.id === 'default-registration' ||
		template.id === 'default-registration-no-consent' ||
		template.id === 'academic-saml-login' ||
		template.id === 'default-login' ||
		template.id === 'default-login-no-consent' ||
		template.id === 'saml-sp-oidc-rp'
);

const templateIdAliases: Record<string, NewFlowTemplateId> = {
	'oidc-registration': 'default-registration',
	'oidc-login': 'default-login'
};

export function getNewFlowTemplate(id: string): NewFlowTemplate | undefined {
	const resolvedId = templateIdAliases[id] ?? id;
	return newFlowTemplates.find((template) => template.id === resolvedId);
}

export function formatFlowContract(template: NewFlowTemplate): string {
	return JSON.stringify(template.contract, null, 2);
}

export function createLoginUiRuntimeContractPreview(
	template: NewFlowTemplate
): LoginUiRuntimeContractPreview {
	const contract = template.contract;
	const destination = readRecord(contract.destination);
	const flowKind = readString(contract.flow_kind, template.flowKind);
	const protocol = readString(contract.protocol, template.protocol.toLowerCase());
	const flowId = `preview:${template.id}`;
	return {
		schema_version: 'authrim.login_ui.contract.v1',
		mode: 'preview',
		runtime: {
			flow_kind: flowKind,
			flow_id: flowId,
			runtime_bindings: createRuntimeBindings(template),
			protocol_context: {
				protocol,
				preview: true,
				destination: {
					type: readString(destination.type, template.destinationType),
					display_name: readOptionalString(destination.display_name)
				}
			},
			ui: {
				steps: template.nodes.map((node) => ({
					id: `${node.id}:step`,
					source_node_id: node.id,
					component: loginUiComponentForNode(template, node.id),
					render:
						node.id !== 'request' &&
						node.id !== 'account-create' &&
						node.id !== 'protocol-condition',
					config: runtimeConfigForNode(template, node),
					content: {
						title: node.label,
						description: node.description,
						settings: node.settings,
						...(node.links ? { links: node.links } : {})
					}
				}))
			},
			capabilities: readArray(contract.capabilities),
			submit: contract.submit ?? null,
			output: contract.output ?? null
		},
		preview: {
			contract_id: flowId,
			interaction_id: readString(contract.interaction_id, `preview_${template.id}`),
			flow: {
				id: template.id,
				kind: flowKind,
				protocol,
				status: template.status,
				title: template.title,
				entry: template.primaryEntry,
				output: template.primaryOutput
			}
		},
		editor: createPreviewEditorState(template)
	};
}

export function formatLoginUiRuntimeContractPreview(template: NewFlowTemplate): string {
	return JSON.stringify(createLoginUiRuntimeContractPreview(template), null, 2);
}

function createRuntimeBindings(
	template: NewFlowTemplate
): LoginUiRuntimeContractPreview['runtime']['runtime_bindings'] {
	return {
		...(template.nodes.some(
			(node) => node.id.includes('method') || node.id.includes('authentication')
		)
			? { authentication_method_profile: 'default' }
			: {}),
		...(template.consentPolicy ? { consent_policy_ref: template.consentPolicy } : {}),
		...(template.mappingSet ? { field_mapping_set_ref: template.mappingSet } : {}),
		...(template.consentStatement ? { consent_statement_ref: template.consentStatement } : {})
	};
}

function createPreviewEditorState(
	template: NewFlowTemplate
): LoginUiRuntimeContractPreview['editor'] {
	if (template.id === 'academic-saml-login') {
		return createAcademicSamlLoginPreviewEditorState();
	}
	if (template.id === 'default-login') {
		return createLoginPreviewEditorState();
	}
	if (template.id === 'default-login-no-consent') {
		return createLoginNoConsentPreviewEditorState();
	}
	if (template.id === 'saml-sp-oidc-rp') {
		return createSamlSpOidcRpPreviewEditorState();
	}

	const nodes = template.nodes.map((node, index) => ({
		id: node.id,
		type: flowNodeTypeForNode(node.id, template.flowKind),
		title: node.label,
		position: { x: 360, y: index * 144 },
		config: runtimeConfigForNode(template, node)
	}));

	return {
		nodes,
		edges: createPreviewEditorEdges(template),
		viewport: { x: 36, y: 36, zoom: 1 }
	};
}

function createAcademicSamlLoginPreviewEditorState(): LoginUiRuntimeContractPreview['editor'] {
	return {
		nodes: [
			{
				id: 'request',
				type: 'entry',
				title: 'Entry',
				position: { x: 360, y: 0 },
				config: { ui_kind: 'entry' }
			},
			{
				id: 'session-check',
				type: 'session_check',
				title: 'Session Check',
				position: { x: 360, y: 144 },
				config: { ui_kind: 'session' }
			},
			{
				id: 'authentication',
				type: 'authentication',
				title: 'Authentication Method',
				position: { x: 520, y: 288 },
				config: {
					ui_kind: 'authentication',
					authentication_profile_ref: 'default',
					screen_ref: 'login',
					outputs: [
						{ id: 'mail_otp', label: 'Email OTP' },
						{ id: 'totp', label: 'Authenticator app' },
						{ id: 'passkey', label: 'Passkey' }
					]
				}
			},
			{
				id: 'saml-attribute-release-consent',
				type: 'consent',
				title: 'Consent',
				position: { x: 360, y: 480 },
				config: {
					ui_kind: 'consent',
					consent_policy_ref: 'saml_attribute_release_policy',
					completion_block: {
						id: 'saml-attribute-release-completion',
						label: 'SAML Attribute Release Completion',
						protocol: 'saml',
						purpose: 'attribute_release',
						role: 'consent'
					}
				}
			},
			{
				id: 'saml-attribute-release-complete',
				type: 'complete',
				title: 'Complete',
				position: { x: 360, y: 624 },
				config: {
					ui_kind: 'complete',
					completion_block: {
						id: 'saml-attribute-release-completion',
						label: 'SAML Attribute Release Completion',
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

function createLoginPreviewEditorState(): LoginUiRuntimeContractPreview['editor'] {
	return {
		nodes: [
			{
				id: 'request',
				type: 'entry',
				title: 'Login Request',
				position: { x: 360, y: 0 },
				config: { ui_kind: 'entry' }
			},
			{
				id: 'session-check',
				type: 'session_check',
				title: 'Session Check',
				position: { x: 360, y: 144 },
				config: { ui_kind: 'session' }
			},
			{
				id: 'authentication',
				type: 'authentication',
				title: 'Authentication Method',
				position: { x: 520, y: 288 },
				config: {
					ui_kind: 'authentication',
					authentication_profile_ref: 'default',
					screen_ref: 'login',
					outputs: [
						{ id: 'mail_otp', label: 'Email OTP' },
						{ id: 'totp', label: 'Authenticator app' },
						{ id: 'passkey', label: 'Passkey' }
					]
				}
			},
			{
				id: 'saml-attribute-release-consent',
				type: 'consent',
				title: 'Consent',
				position: { x: 120, y: 480 },
				config: {
					ui_kind: 'consent',
					consent_policy_ref: 'saml_attribute_release_policy',
					completion_block: {
						id: 'saml-attribute-release-completion',
						label: 'SAML Attribute Release Completion',
						protocol: 'saml',
						purpose: 'attribute_release',
						role: 'consent'
					}
				}
			},
			{
				id: 'saml-attribute-release-complete',
				type: 'complete',
				title: 'Complete',
				position: { x: 120, y: 624 },
				config: {
					ui_kind: 'complete',
					completion_block: {
						id: 'saml-attribute-release-completion',
						label: 'SAML Attribute Release Completion',
						protocol: 'saml',
						purpose: 'attribute_release',
						role: 'output'
					}
				}
			},
			{
				id: 'oidc-authorization-consent',
				type: 'consent',
				title: 'Consent',
				position: { x: 600, y: 480 },
				config: {
					ui_kind: 'consent',
					consent_policy_ref: 'oidc_authorization_consent_policy',
					completion_block: {
						id: 'oidc-authorization-completion',
						label: 'OIDC Authorization Completion',
						protocol: 'oidc',
						purpose: 'authorization',
						role: 'consent'
					}
				}
			},
			{
				id: 'oidc-authorization-complete',
				type: 'complete',
				title: 'Complete',
				position: { x: 600, y: 624 },
				config: {
					ui_kind: 'complete',
					completion_block: {
						id: 'oidc-authorization-completion',
						label: 'OIDC Authorization Completion',
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

function createLoginNoConsentPreviewEditorState(): LoginUiRuntimeContractPreview['editor'] {
	const authenticationOutputs = [
		{ id: 'mail_otp', label: 'Email OTP' },
		{ id: 'totp', label: 'Authenticator app' },
		{ id: 'passkey', label: 'Passkey' },
		{ id: 'facebook', label: 'Facebook' }
	];
	return {
		nodes: [
			{
				id: 'request',
				type: 'entry',
				title: 'Login Request',
				position: { x: 360, y: 0 },
				config: { ui_kind: 'entry' }
			},
			{
				id: 'session-check',
				type: 'session_check',
				title: 'Session Check',
				position: { x: 360, y: 144 },
				config: { ui_kind: 'session' }
			},
			{
				id: 'authentication',
				type: 'authentication',
				title: 'Authentication Method',
				position: { x: 520, y: 288 },
				config: {
					ui_kind: 'authentication',
					authentication_profile_ref: 'default',
					screen_ref: 'login',
					outputs: authenticationOutputs
				}
			},
			{
				id: 'saml-attribute-release-complete',
				type: 'complete',
				title: 'Complete',
				position: { x: 120, y: 624 },
				config: {
					ui_kind: 'complete',
					completion_block: {
						id: 'saml-attribute-release-completion',
						label: 'SAML Attribute Release Completion',
						protocol: 'saml',
						purpose: 'attribute_release',
						role: 'output'
					}
				}
			},
			{
				id: 'oidc-authorization-complete',
				type: 'complete',
				title: 'Complete',
				position: { x: 600, y: 624 },
				config: {
					ui_kind: 'complete',
					completion_block: {
						id: 'oidc-authorization-completion',
						label: 'OIDC Authorization Completion',
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
				id: 'session-check:continue->saml-attribute-release-complete',
				source: 'session-check',
				source_handle: 'continue',
				target: 'saml-attribute-release-complete'
			},
			{
				id: 'session-check:continue->oidc-authorization-complete',
				source: 'session-check',
				source_handle: 'continue',
				target: 'oidc-authorization-complete'
			},
			{
				id: 'session-check:authenticate->authentication',
				source: 'session-check',
				source_handle: 'authenticate',
				target: 'authentication'
			},
			...authenticationOutputs.flatMap((output) => [
				{
					id: `authentication:${output.id}->saml-attribute-release-complete`,
					source: 'authentication',
					source_handle: output.id,
					target: 'saml-attribute-release-complete'
				},
				{
					id: `authentication:${output.id}->oidc-authorization-complete`,
					source: 'authentication',
					source_handle: output.id,
					target: 'oidc-authorization-complete'
				}
			])
		],
		viewport: { x: 36, y: 36, zoom: 1 }
	};
}

function createSamlSpOidcRpPreviewEditorState(): LoginUiRuntimeContractPreview['editor'] {
	const authenticationOutputs = [
		{ id: 'mail_otp', label: 'Email OTP' },
		{ id: 'totp', label: 'Authenticator app' },
		{ id: 'passkey', label: 'Passkey' },
		{ id: 'facebook', label: 'Facebook' }
	];
	const conditionConfig = {
		ui_kind: 'condition',
		conditions: {
			rows: [
				{
					id: 'saml',
					label: 'SAML',
					condition: { type: 'protocol', value: 'saml' },
					output_handle: 'saml'
				},
				{
					id: 'oidc',
					label: 'OIDC',
					condition: { type: 'protocol', value: 'oidc' },
					output_handle: 'oidc'
				}
			],
			otherwise: {
				terminal_error: {
					error: 'unsupported_protocol',
					message: 'This Flow accepts only SAML and OIDC login requests.'
				}
			}
		}
	};
	return {
		nodes: [
			{
				id: 'request',
				type: 'entry',
				title: 'Login Request',
				position: { x: 360, y: 0 },
				config: { ui_kind: 'entry' }
			},
			{
				id: 'session-check',
				type: 'session_check',
				title: 'Session Check',
				position: { x: 360, y: 144 },
				config: { ui_kind: 'session' }
			},
			{
				id: 'authentication',
				type: 'authentication',
				title: 'Authentication Method',
				position: { x: 520, y: 288 },
				config: {
					ui_kind: 'authentication',
					authentication_profile_ref: 'default',
					screen_ref: 'login',
					outputs: authenticationOutputs
				}
			},
			{
				id: 'protocol-condition',
				type: 'condition',
				title: 'Protocol Branch',
				position: { x: 360, y: 432 },
				config: conditionConfig
			},
			{
				id: 'saml-complete',
				type: 'complete',
				title: 'SAML End',
				position: { x: 120, y: 600 },
				config: {
					ui_kind: 'complete',
					completion_block: {
						id: 'saml-attribute-release-completion',
						label: 'SAML Attribute Release Completion',
						protocol: 'saml',
						purpose: 'attribute_release',
						role: 'output'
					}
				}
			},
			{
				id: 'oidc-complete',
				type: 'complete',
				title: 'OIDC End',
				position: { x: 600, y: 600 },
				config: {
					ui_kind: 'complete',
					completion_block: {
						id: 'oidc-authorization-completion',
						label: 'OIDC Authorization Completion',
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
				id: 'session-check:continue->protocol-condition',
				source: 'session-check',
				source_handle: 'continue',
				target: 'protocol-condition'
			},
			{
				id: 'session-check:authenticate->authentication',
				source: 'session-check',
				source_handle: 'authenticate',
				target: 'authentication'
			},
			...authenticationOutputs.map((output) => ({
				id: `authentication:${output.id}->protocol-condition`,
				source: 'authentication',
				source_handle: output.id,
				target: 'protocol-condition'
			})),
			{
				id: 'protocol-condition:saml->saml-complete',
				source: 'protocol-condition',
				source_handle: 'saml',
				target: 'saml-complete'
			},
			{
				id: 'protocol-condition:oidc->oidc-complete',
				source: 'protocol-condition',
				source_handle: 'oidc',
				target: 'oidc-complete'
			}
		],
		viewport: { x: 36, y: 36, zoom: 1 }
	};
}

function createPreviewEditorEdges(
	template: NewFlowTemplate
): LoginUiRuntimeContractPreview['editor']['edges'] {
	if (template.id === 'default-registration') {
		return [
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
				id: 'account-create:completed->output',
				source: 'account-create',
				source_handle: 'completed',
				target: 'output'
			}
		];
	}
	if (template.id === 'default-registration-no-consent') {
		return [
			{
				id: 'request:next->registration-method',
				source: 'request',
				source_handle: 'next',
				target: 'registration-method'
			},
			{
				id: 'registration-method:mail_otp->account-create',
				source: 'registration-method',
				source_handle: 'mail_otp',
				target: 'account-create'
			},
			{
				id: 'registration-method:totp->account-create',
				source: 'registration-method',
				source_handle: 'totp',
				target: 'account-create'
			},
			{
				id: 'registration-method:passkey->account-create',
				source: 'registration-method',
				source_handle: 'passkey',
				target: 'account-create'
			},
			{
				id: 'registration-method:facebook->account-create',
				source: 'registration-method',
				source_handle: 'facebook',
				target: 'account-create'
			},
			{
				id: 'account-create:completed->output',
				source: 'account-create',
				source_handle: 'completed',
				target: 'output'
			}
		];
	}
	if (template.id === 'default-login') {
		return [
			{
				id: 'request:next->session-check',
				source: 'request',
				source_handle: 'next',
				target: 'session-check'
			},
			{
				id: 'session-check:continue->consent',
				source: 'session-check',
				source_handle: 'continue',
				target: 'consent'
			},
			{
				id: 'session-check:authenticate->authentication',
				source: 'session-check',
				source_handle: 'authenticate',
				target: 'authentication'
			},
			{
				id: 'authentication:mail_otp->consent',
				source: 'authentication',
				source_handle: 'mail_otp',
				target: 'consent'
			},
			{
				id: 'authentication:totp->consent',
				source: 'authentication',
				source_handle: 'totp',
				target: 'consent'
			},
			{
				id: 'authentication:passkey->consent',
				source: 'authentication',
				source_handle: 'passkey',
				target: 'consent'
			},
			{
				id: 'authentication:facebook->consent',
				source: 'authentication',
				source_handle: 'facebook',
				target: 'consent'
			},
			{
				id: 'consent:accepted->output',
				source: 'consent',
				source_handle: 'accepted',
				target: 'output'
			}
		];
	}
	if (template.id === 'academic-saml-login') {
		return createAcademicSamlLoginPreviewEditorState().edges;
	}
	return template.nodes.slice(0, -1).map((node, index) => {
		const nextNode = template.nodes[index + 1];
		return {
			id: `${node.id}:next->${nextNode.id}`,
			source: node.id,
			source_handle: defaultSourceHandleForNode(node.id),
			target: nextNode.id
		};
	});
}

function runtimeConfigForNode(
	template: NewFlowTemplate,
	node: FlowNodePreview
): Record<string, unknown> {
	const type = flowNodeTypeForNode(node.id, template.flowKind);
	const config: Record<string, unknown> = { ui_kind: type };
	const completionBlock = completionBlockForNode(template, node.id);
	if (completionBlock) {
		config.completion_block = completionBlock;
	}
	if (type === 'registration' || type === 'authentication') {
		config.authentication_profile_ref = 'default';
		config.outputs = [
			{ id: 'mail_otp', label: 'Email OTP' },
			{ id: 'totp', label: 'Authenticator app' },
			{ id: 'passkey', label: 'Passkey' },
			{ id: 'facebook', label: 'Facebook' }
		];
		config.screen_ref = type === 'registration' ? 'registration' : 'login';
	}
	if (type === 'screen') {
		config.screen_ref = 'profile_completion';
	}
	if (type === 'consent') {
		config.consent_policy_ref =
			template.id === 'academic-saml-login' || template.id === 'saml-attribute-release'
				? 'saml_attribute_release_policy'
				: template.id === 'default-registration'
					? 'registration_consent_policy'
					: 'oidc_authorization_consent_policy';
	}
	if (type === 'condition' && node.id === 'protocol-condition') {
		config.conditions = {
			rows: [
				{
					id: 'saml',
					label: 'SAML',
					condition: { type: 'protocol', value: 'saml' },
					output_handle: 'saml'
				},
				{
					id: 'oidc',
					label: 'OIDC',
					condition: { type: 'protocol', value: 'oidc' },
					output_handle: 'oidc'
				}
			],
			otherwise: {
				terminal_error: {
					error: 'unsupported_protocol',
					message: 'This Flow accepts only SAML and OIDC login requests.'
				}
			}
		};
	}
	return config;
}

function completionBlockForNode(
	template: NewFlowTemplate,
	nodeId: string
): Record<string, string> | null {
	const role =
		nodeId === 'consent' || nodeId.endsWith('-consent')
			? 'consent'
			: nodeId === 'output' || nodeId.endsWith('-complete')
				? 'output'
				: '';
	if (!role) return null;
	const explicitBlock = completionBlockProtocolAndPurposeForNode(nodeId);
	const protocol = explicitBlock?.protocol ?? template.protocol.toLowerCase();
	const purpose =
		explicitBlock?.purpose ??
		(template.id === 'saml-attribute-release' || template.id === 'academic-saml-login'
			? 'attribute_release'
			: template.id === 'default-registration' || template.id === 'default-registration-no-consent'
				? 'registration'
				: 'authorization');
	return {
		id: `${protocol}-${purpose}-completion`,
		label: completionBlockLabel(protocol, purpose),
		protocol,
		purpose,
		role
	};
}

function completionBlockProtocolAndPurposeForNode(
	nodeId: string
): { protocol: string; purpose: string } | null {
	if (nodeId.startsWith('saml-attribute-release')) {
		return { protocol: 'saml', purpose: 'attribute_release' };
	}
	if (nodeId === 'saml-complete') {
		return { protocol: 'saml', purpose: 'attribute_release' };
	}
	if (nodeId.startsWith('oidc-authorization')) {
		return { protocol: 'oidc', purpose: 'authorization' };
	}
	if (nodeId === 'oidc-complete') {
		return { protocol: 'oidc', purpose: 'authorization' };
	}
	if (nodeId.startsWith('oidc-registration')) {
		return { protocol: 'oidc', purpose: 'registration' };
	}
	return null;
}

function completionBlockLabel(protocol: string, purpose: string): string {
	if (protocol === 'oidc' && purpose === 'registration') return 'OIDC Registration Completion';
	if (protocol === 'oidc' && purpose === 'authorization') return 'OIDC Authorization Completion';
	if (protocol === 'saml' && purpose === 'attribute_release') {
		return 'SAML Attribute Release Completion';
	}
	if (protocol === 'direct') return 'Direct Login Completion';
	return 'Completion Block';
}

function flowNodeTypeForNode(nodeId: string, flowKind: string): string {
	if (nodeId === 'request') return 'entry';
	if (nodeId === 'session-check') return 'session_check';
	if (nodeId.includes('method') && flowKind === 'registration') return 'registration';
	if (nodeId.includes('authentication')) return 'authentication';
	if (nodeId === 'protocol-condition') return 'condition';
	if (nodeId.includes('profile')) return 'screen';
	if (nodeId.includes('consent')) return 'consent';
	if (nodeId.includes('account')) return 'account_action';
	if (nodeId === 'output' || nodeId.endsWith('-complete')) return 'complete';
	return 'entry';
}

function defaultSourceHandleForNode(nodeId: string): string {
	if (nodeId.includes('profile')) return 'submitted';
	if (nodeId.includes('consent')) return 'accepted';
	if (nodeId.includes('account')) return 'completed';
	if (nodeId.includes('session')) return 'authenticate';
	return 'next';
}

function loginUiComponentForNode(template: NewFlowTemplate, nodeId: string): string {
	if (nodeId === 'request') return 'interaction_context';
	if (nodeId.includes('session')) return 'session_check';
	if (nodeId.includes('method') || nodeId.includes('authentication')) {
		return template.flowKind === 'registration'
			? 'registration_method_selector'
			: 'authentication_method_selector';
	}
	if (nodeId.includes('profile')) return 'screen';
	if (nodeId.includes('consent')) return 'consent_policy';
	if (nodeId === 'protocol-condition') return 'condition';
	if (nodeId.includes('mapping')) return 'field_mapping_preview';
	if (nodeId.includes('account')) return 'account_action';
	if (nodeId === 'output' || nodeId.endsWith('-complete')) return 'completion';
	return 'display';
}

function readRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function readArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function readString(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.trim() ? value : fallback;
}

function readOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}
