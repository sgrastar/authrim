const adminTenantDiscovery = {
	admin_tenant_discovery_head_title: 'テナントディスカバリー - Authrim Admin',
	admin_tenant_discovery_title: 'テナントディスカバリー',
	admin_tenant_discovery_description_single:
		'Multi-tenant modeを有効にすると利用できます。このページではテナントディスカバリーflowを設定します。',
	admin_tenant_discovery_description_multi:
		'Tenant resolutionの動作を設定し、ディスカバリー画面をカスタマイズします。',
	admin_tenant_discovery_loading: 'テナントディスカバリー設定を読み込み中...',
	admin_tenant_discovery_single_mode_disabled:
		'このdeploymentがsingle-tenant modeで実行されている間、テナントディスカバリーは無効です。`workers.dev`から開始し、後でAPI custom domainを追加してからSetupでmulti-tenant modeを有効にできます。',
	admin_tenant_discovery_controls_title: 'ディスカバリー制御',
	admin_tenant_discovery_controls_description:
		'Common entry、tenant resolution、ディスカバリー画面overrideはmulti-tenant modeを有効にすると利用できます。',
	admin_tenant_discovery_enable_in_setup: 'Setupで有効化',
	admin_tenant_discovery_common_behavior_title: 'Common Entry Login Behavior',
	admin_tenant_discovery_common_behavior_description:
		'Tenantが選択される前のshared entry pageを制御します。現在のURL: {url}',
	admin_tenant_discovery_platform_readonly_behavior:
		'Common entry behaviorはplatform settingです。Tenant adminは確認できますが、編集はできません。',
	admin_tenant_discovery_entry_mode: 'Entry Mode',
	admin_tenant_discovery_entry_mode_tenant_only: 'テナント専用エントリのみ',
	admin_tenant_discovery_entry_mode_discovery_optional: 'ディスカバリー任意',
	admin_tenant_discovery_entry_mode_discovery_required: 'ディスカバリー必須',
	admin_tenant_discovery_entry_mode_tenant_only_description:
		'ユーザーはtenant-specific entry pointからsign inします。他のflowが送らない限り、shared discovery pageは迂回されます。',
	admin_tenant_discovery_entry_mode_tenant_only_sample:
		'すべてのappまたは招待がすでにtenantを把握している場合に使います。',
	admin_tenant_discovery_entry_mode_discovery_optional_description:
		'ユーザーはテナントディスカバリーを利用できますが、tenant-specific login URLも引き続き有効です。',
	admin_tenant_discovery_entry_mode_discovery_optional_sample:
		'Multi-tenant rolloutを段階的に進める場合の無難なdefaultです。',
	admin_tenant_discovery_entry_mode_discovery_required_description:
		'Login methodを表示する前に、ユーザーはtenantを解決する必要があります。',
	admin_tenant_discovery_entry_mode_discovery_required_sample:
		'Shared login entryで常に先にtenantを選ばせたい場合に使います。',
	admin_tenant_discovery_example: '例: {sample}',
	admin_tenant_discovery_email_resolution: 'Email Resolution',
	admin_tenant_discovery_email_resolution_exact_then_domain:
		'Exact email, then email-domain fallback',
	admin_tenant_discovery_email_resolution_exact_only: 'Exact email only',
	admin_tenant_discovery_email_resolution_disabled_description:
		'Email-based discoveryは現在無効です。',
	admin_tenant_discovery_email_resolution_disabled_sample:
		'このpolicyを使うには下のEmail addressを有効にしてください。',
	admin_tenant_discovery_email_resolution_exact_only_description:
		'Full email addressが明示的にmappingされている場合のみtenantを解決します。',
	admin_tenant_discovery_email_resolution_exact_only_sample:
		'alice@example.eduには個別mappingが必要です。',
	admin_tenant_discovery_email_resolution_exact_then_domain_description:
		'まずexact email mappingを試し、存在しなければemail domainへfallbackします。',
	admin_tenant_discovery_email_resolution_exact_then_domain_sample:
		'alice@example.eduはexample.eduへfallbackします。',
	admin_tenant_discovery_email_resolution_disabled_policy_description:
		'Email addressからtenantを解決しません。',
	admin_tenant_discovery_email_resolution_disabled_policy_sample:
		'ユーザーは別の有効なディスカバリー方法を使う必要があります。',
	admin_tenant_discovery_selection_policy: '選択ポリシー',
	admin_tenant_discovery_selection_auto_if_single: 'Auto if single',
	admin_tenant_discovery_selection_always_select: 'Always select',
	admin_tenant_discovery_selection_select_if_multiple: 'Select if multiple',
	admin_tenant_discovery_selection_manual_only: 'Manual only',
	admin_tenant_discovery_selection_auto_if_single_description:
		'ディスカバリー結果がtenant 1件だけなら自動で続行します。複数matchする場合はselection screenを表示します。',
	admin_tenant_discovery_selection_auto_if_single_sample:
		'Mappingの信頼性が高く、明確な1件matchが多い場合に適しています。',
	admin_tenant_discovery_selection_always_select_description:
		'1件だけmatchした場合でも、ディスカバリー後に常にtenant selection stepを表示します。',
	admin_tenant_discovery_selection_always_select_sample:
		'ユーザーにtenantを明示確認させたい場合に使います。',
	admin_tenant_discovery_selection_select_if_multiple_description:
		'1件matchならselection stepをskipし、複数tenantがmatchした場合だけ選択させます。',
	admin_tenant_discovery_selection_select_if_multiple_sample:
		'共有email domain向けのbalanced defaultです。',
	admin_tenant_discovery_selection_manual_only_description:
		'Email resolutionから自動選択しません。ユーザーがtenantを入力または選択する必要があります。',
	admin_tenant_discovery_selection_manual_only_sample:
		'Tenant code、tenant slug、WAYF discoveryのいずれかを有効にしておく必要があります。',
	admin_tenant_discovery_enabled_methods: '有効なディスカバリー方法',
	admin_tenant_discovery_method_email: 'Email address',
	admin_tenant_discovery_method_email_description:
		'任意のemail-domain fallbackを使って、email addressからtenantを特定できるようにします。',
	admin_tenant_discovery_method_tenant_code: 'Tenant code',
	admin_tenant_discovery_method_tenant_code_description:
		'Tenant codeでtenantを特定できるようにします。',
	admin_tenant_discovery_method_tenant_slug: 'Tenant slug',
	admin_tenant_discovery_method_tenant_slug_description:
		'Tenant slugでtenantを特定できるようにします。',
	admin_tenant_discovery_method_wayf: 'WAYF tenant chooser',
	admin_tenant_discovery_method_wayf_description:
		'Active tenantから生成したtenant-name dropdownを表示します。',
	admin_tenant_discovery_allow_manual: 'Manual tenant entryを許可',
	admin_tenant_discovery_allow_manual_description:
		'Automatic discoveryでtenantを解決できない場合にmanual entry fallbackを表示します。',
	admin_tenant_discovery_remember_last: '最後のtenantを記憶',
	admin_tenant_discovery_remember_last_description:
		'このbrowserで直近に解決されたtenantを記憶します。',
	admin_tenant_discovery_redirect_default_login: 'Default loginをディスカバリーへredirect',
	admin_tenant_discovery_redirect_default_login_description:
		'適切な場合、common-entry /login requestを/discoverへredirectします。',
	admin_tenant_discovery_require_common_before_login:
		'Tenant login前にcommon discoveryを必須にする',
	admin_tenant_discovery_require_common_before_login_common_description:
		'有効な場合、tenant-host /loginへの直接訪問は先にshared discover screenを通過する必要があります。Challenge-based OIDC loginは変更されません。',
	admin_tenant_discovery_require_common_before_login_tenant_description:
		'有効な場合、このtenantの/loginへの直接訪問は先にshared discover screenを通過する必要があります。Challenge-based OIDC loginは変更されません。',
	admin_tenant_discovery_redirect_tenant_discover: 'Tenant discoverをcommon entryへredirect',
	admin_tenant_discovery_redirect_tenant_discover_common_description:
		'tenant-hostとvanity-hostの/discoverをcommon entryへredirectします。',
	admin_tenant_discovery_redirect_tenant_discover_tenant_description:
		'このtenant hostとvanity hostの/discoverをcommon entryへredirectします。',
	admin_tenant_discovery_skip_if_one: 'テナントが1件だけならディスカバリーをスキップ',
	admin_tenant_discovery_skip_if_one_description:
		'有効な場合、active tenantが1件だけならshared /discover flowはすぐにtenant login pageへ進みます。',
	admin_tenant_discovery_save_common_behavior: 'Common Entry Behaviorを保存',
	admin_tenant_discovery_saving: '保存中...',
	admin_tenant_discovery_tenant_behavior_title_single: 'ディスカバリー動作',
	admin_tenant_discovery_tenant_behavior_title_multi: 'Tenant Entry Override',
	admin_tenant_discovery_tenant_behavior_description_single:
		'Login前にこのtenantを解決する方法を制御します。',
	admin_tenant_discovery_tenant_behavior_description_multi:
		'{tenant}のdirect entry behaviorを制御します。{url}のshared entry pageは変更しません。',
	admin_tenant_discovery_open_tenant_details: 'Tenant詳細を開く',
	admin_tenant_discovery_enable_tenant_override: 'Tenant entry overrideを有効化',
	admin_tenant_discovery_enable_tenant_override_description:
		'無効な場合、このtenantはcommon entry behaviorを使用します。既存のtenant値は保持されますが、このoverrideが有効になるまで無視されます。',
	admin_tenant_discovery_save_behavior: 'ディスカバリー動作を保存',
	admin_tenant_discovery_common_behavior_active:
		'このtenantではcommon entry behaviorが有効です。tenant-specific entry behaviorを設定するにはoverrideを有効にしてください。',
	admin_tenant_discovery_save_tenant_entry_override: 'Tenant Entry Overrideを保存',
	admin_tenant_discovery_common_screen_title: 'Common Entry Screen Content',
	admin_tenant_discovery_common_screen_description:
		'{url}のshared entry pageで使うtext、branding、themeです。',
	admin_tenant_discovery_platform_readonly_screen:
		'Common entry screen contentはplatform settingです。Tenant adminは確認できますが、編集はできません。',
	admin_tenant_discovery_common_prefill_hint:
		'空の値には、shared discovery screenで現在表示されているeffective defaultが事前入力されます。',
	admin_tenant_discovery_theme: 'Theme',
	admin_tenant_discovery_variant: 'Variant',
	admin_tenant_discovery_inherit_default: 'Inherit / default',
	admin_tenant_discovery_light: 'light',
	admin_tenant_discovery_dark: 'dark',
	admin_tenant_discovery_beige: 'beige',
	admin_tenant_discovery_blue_gray: 'blue-gray',
	admin_tenant_discovery_green: 'green',
	admin_tenant_discovery_brown: 'brown',
	admin_tenant_discovery_navy: 'navy',
	admin_tenant_discovery_slate: 'slate',
	admin_tenant_discovery_brand_name: 'Brand Name',
	admin_tenant_discovery_logo_url: 'Logo URL',
	admin_tenant_discovery_page_title: 'Page Title',
	admin_tenant_discovery_kicker_text: 'Kicker Text',
	admin_tenant_discovery_title_text: 'Title Text',
	admin_tenant_discovery_subtitle_text: 'Subtitle Text',
	admin_tenant_discovery_save_common_screen: 'Common Entry Screenを保存',
	admin_tenant_discovery_tenant_screen_title: 'Tenant Override Screen Content',
	admin_tenant_discovery_tenant_screen_description:
		'{tenant}のtenant-specific discovery screenのoverrideです。Multi-tenant modeでは、tenant host上の/discoverは通常/loginへredirectするため、これらの値は主に招待やapp-hint resolutionなど、discoveryを直接描画するflowに適用されます。',
	admin_tenant_discovery_enable_tenant_screen_override: 'Tenant screen content overrideを有効化',
	admin_tenant_discovery_enable_tenant_screen_override_description:
		'無効な場合、common discovery screen contentが適用されます。既存のtenant screen値は保持されますが、このoverrideが有効になるまで無視されます。',
	admin_tenant_discovery_tenant_prefill_hint:
		'Fieldには、このtenantで現在使用されているeffective valueが事前入力されます。保存すると明示的なtenant overrideとして書き込まれます。',
	admin_tenant_discovery_inherit_from_login_ui: 'Login UIから継承',
	admin_tenant_discovery_save_tenant_override: 'Tenant Overrideを保存',
	admin_tenant_discovery_common_screen_active:
		'このtenantではcommon discovery screen contentが有効です。tenant-specific discovery screenをカスタマイズするにはoverrideを有効にしてください。',
	admin_tenant_discovery_save_tenant_screen_override: 'Tenant Screen Overrideを保存',
	admin_tenant_discovery_validation_enable_method:
		'ディスカバリー方法を1つ以上有効にしてください。',
	admin_tenant_discovery_validation_manual_requires_method:
		'manual_onlyではtenant code、tenant slug、WAYFのいずれかを有効にしておく必要があります。',
	admin_tenant_discovery_common_url_fallback: 'shared /discover URL',
	admin_tenant_discovery_load_common_behavior_failed:
		'Common entry behaviorの読み込みに失敗しました',
	admin_tenant_discovery_load_common_screen_failed:
		'Common entry screen settingsの読み込みに失敗しました',
	admin_tenant_discovery_load_failed: 'テナントディスカバリー設定の読み込みに失敗しました',
	admin_tenant_discovery_conflict:
		'Settingsが別のユーザーにより変更されました。再読み込みしてから再試行してください。',
	admin_tenant_discovery_behavior_saved: 'ディスカバリー動作を保存しました',
	admin_tenant_discovery_behavior_save_failed: 'ディスカバリー動作の保存に失敗しました',
	admin_tenant_discovery_common_behavior_saved: 'Common entry discovery behaviorを保存しました',
	admin_tenant_discovery_common_behavior_save_failed:
		'Common entry discovery behaviorの保存に失敗しました',
	admin_tenant_discovery_common_screen_saved: 'Common entry screenを保存しました',
	admin_tenant_discovery_common_screen_save_failed: 'Common entry screenの保存に失敗しました',
	admin_tenant_discovery_tenant_screen_saved: 'テナントディスカバリー画面を保存しました',
	admin_tenant_discovery_tenant_screen_save_failed: 'テナントディスカバリー画面の保存に失敗しました'
} as const;

export default adminTenantDiscovery;
