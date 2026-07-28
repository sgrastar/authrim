<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { LL } from '$i18n/i18n-svelte';
	import {
		getFlowAuthProfileOptions,
		getFlowConsentPolicyOptions,
		getFlowNodePalette,
		getFlowScreenOptions,
		getFlowTemplateText,
		getLocalizedFlowNode,
		getSavedFlowDescription,
		type FlowEditorAuthProfileOption,
		type FlowEditorOption
	} from '$lib/admin/flow-i18n';
	import { getNewFlowTemplate, type NewFlowTemplate } from '$lib/admin/new-flow-templates';
	import {
		adminAuthenticationMethodsAPI,
		type AuthenticationMethodSettingsResponse
	} from '$lib/api/admin-authentication-methods';
	import { adminConsentPoliciesAPI, type ConsentPolicy } from '$lib/api/admin-consent-policies';
	import { adminScreensAPI, type Screen, type ScreenKind } from '$lib/api/admin-screens';
	import {
		adminFlowsAPI,
		type AdminFlow,
		type AdminFlowKind,
		type FlowEditorState,
		type FlowValidationIssue
	} from '$lib/api/admin-flows';
	import { Modal } from '$lib/components';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import FlowEditorEdge, {
		type FlowEditorEdgeData
	} from '$lib/components/flow-editor/FlowEditorEdge.svelte';
	import FlowEditorGroupNode, {
		type FlowEditorGroupData
	} from '$lib/components/flow-editor/FlowEditorGroupNode.svelte';
	import FlowEditorNode, {
		type FlowEditorCompletionBlock,
		type FlowEditorNodeData,
		type FlowEditorNodeKind,
		type FlowEditorNodeOutput
	} from '$lib/components/flow-editor/FlowEditorNode.svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { themeStore } from '$lib/stores/theme.svelte';
	import { toast } from '$lib/toast';
	import {
		Background,
		BackgroundVariant,
		ConnectionLineType,
		ConnectionMode,
		MarkerType,
		Position,
		SvelteFlow,
		type Connection,
		type Edge,
		type EdgeTypes,
		type Node,
		type NodeTypes
	} from '@xyflow/svelte';
	import { onMount } from 'svelte';
	import '@xyflow/svelte/dist/style.css';

	type EditorNode = Node<FlowEditorNodeData, 'editor'>;
	type CompletionGroupNode = Node<FlowEditorGroupData, 'completionGroup'>;
	type FlowNode = EditorNode | CompletionGroupNode;
	type EditorEdge = Edge<FlowEditorEdgeData, 'editor'>;
	type ConditionDraftType =
		| 'always'
		| 'protocol'
		| 'authenticated'
		| 'first_login'
		| 'client_id'
		| 'saml_sp_id'
		| 'flow_kind'
		| 'requested_scope'
		| 'authentication_method';
	type ConditionOtherwiseMode = 'output' | 'terminal_error';

	interface ConditionRowDraft {
		id: string;
		label: string;
		type: ConditionDraftType;
		value: string;
		outputHandle: string;
	}

	const COMPACT_NODE_Y_GAP = 145;
	const DEFAULT_NODE_X = 360;
	const DEFAULT_NODE_WIDTH = 226;
	const DEFAULT_NODE_HEIGHT = 58;
	const FLOW_SNAP_GRID_SIZE = 18;
	const FLOW_SNAP_GRID: [number, number] = [FLOW_SNAP_GRID_SIZE, FLOW_SNAP_GRID_SIZE];
	const FLOW_CANVAS_BOTTOM_PADDING = 260;
	const CONFIGURE_NODE_EVENT = 'authrim-flow-configure-node';
	const DELETE_EDGE_EVENT = 'authrim-flow-delete-edge';

	interface NodeDraft {
		title: string;
		description: string;
		settingsText: string;
		authProfile: string;
		screen: string;
		consentPolicy: string;
		conditionType: ConditionDraftType;
		conditionValue: string;
		conditionOutputHandle: string;
		conditionOutputLabel: string;
		conditionRows: ConditionRowDraft[];
		conditionOtherwiseMode: ConditionOtherwiseMode;
		conditionOtherwiseOutputHandle: string;
		conditionOtherwiseOutputLabel: string;
		conditionTerminalError: string;
		conditionTerminalMessage: string;
	}

	const nodeTypes: NodeTypes = {
		editor: FlowEditorNode,
		completionGroup: FlowEditorGroupNode
	};

	const edgeTypes: EdgeTypes = {
		editor: FlowEditorEdge
	};

	const flowId = $derived($page.params.id ?? '');
	const flow = $derived(getNewFlowTemplate(flowId));
	const flowText = $derived(flow ? getFlowTemplateText($LL, flow) : null);
	const localeMarker = $derived($LL.admin_flows_locale_marker());
	const fallbackAuthProfileOptions = $derived(getFlowAuthProfileOptions($LL));
	const fallbackScreenOptions = $derived(getFlowScreenOptions($LL));
	const fallbackConsentPolicyOptions = $derived(getFlowConsentPolicyOptions($LL));
	const nodePalette = $derived(getFlowNodePalette($LL));
	const currentTenantId = $derived(settingsContext.tenantId);
	let initializedFlowId = $state('');
	let initializedLocaleMarker = $state('');
	let initializedOptionsTenantId = $state('');
	let nextNodeIndex = $state(0);
	let loadedAuthProfileOptions = $state<FlowEditorAuthProfileOption[]>([]);
	let loadedScreens = $state<Screen[]>([]);
	let loadedScreenOptions = $state<FlowEditorOption[]>([]);
	let loadedConsentPolicyOptions = $state<FlowEditorOption[]>([]);
	let screensLoaded = $state(false);
	let consentPoliciesLoaded = $state(false);
	let savedFlow = $state<AdminFlow | null>(null);
	let flowLoading = $state(true);
	let flowLoadError = $state('');
	let saving = $state(false);
	let saveStatus = $state('');
	let flowSlug = $state('');
	let flowDisplayName = $state('');
	let flowDescription = $state('');
	let deleteFlowModalOpen = $state(false);
	let deletingFlow = $state(false);
	let validating = $state(false);
	let validationIssues = $state<FlowValidationIssue[]>([]);
	let validationRan = $state(false);
	let flowSettingsError = $state('');
	let invalidConnectionMessage = $state('');
	let editorNodes = $state<Node[]>([]);
	let editorEdges = $state<EditorEdge[]>([]);
	let hoveredEditorNodeId = $state<string | null>(null);
	let editingNodeId = $state<string | null>(null);
	let draft = $state<NodeDraft>(createEmptyDraft());
	let flowCanvasElement = $state<HTMLDivElement | null>(null);
	const pageTitle = $derived(savedFlow?.display_name || flowText?.title || flowId);
	const pageDescription = $derived(
		savedFlow
			? getSavedFlowDescription($LL, savedFlow)
			: $LL.admin_flows_editor_header_description()
	);
	const pageEyebrow = $derived(
		savedFlow ? getAdminFlowKindLabel(savedFlow.kind) : (flow?.protocol ?? '')
	);
	const authProfileOptions = $derived(
		loadedAuthProfileOptions.length > 0 ? loadedAuthProfileOptions : fallbackAuthProfileOptions
	);
	const screenOptions = $derived.by(() => {
		if (!screensLoaded) return fallbackScreenOptions;
		if (loadedScreenOptions.length > 0) return loadedScreenOptions;
		return fallbackScreenOptions;
	});
	const consentPolicyOptions = $derived.by(() => {
		if (!consentPoliciesLoaded) return fallbackConsentPolicyOptions;
		if (loadedConsentPolicyOptions.length > 0) return loadedConsentPolicyOptions;
		return [
			{
				value: '',
				label: $LL.admin_flows_consent_policy_none_available(),
				disabled: true
			}
		];
	});
	const editingNode = $derived(
		editingNodeId ? (getEditorNodes().find((node) => node.id === editingNodeId) ?? null) : null
	);
	const flowCanvasHeight = $derived.by(() => {
		const maxNodeY = getEditorNodes().reduce((value, node) => Math.max(value, node.position.y), 0);
		const desiredHeight = maxNodeY + DEFAULT_NODE_HEIGHT + FLOW_CANVAS_BOTTOM_PADDING;
		return `${Math.max(720, snapToGrid(desiredHeight))}px`;
	});
	const flowRenderKey = $derived.by(() =>
		getEditorNodes()
			.map((node) => `${node.id}:${node.data.outputs.map((output) => output.id).join(',')}`)
			.join('|')
	);

	onMount(async () => {
		await settingsContext.initialize();
		await Promise.all([loadFlowSettingOptions(), loadSavedFlow()]);
	});

	$effect(() => {
		const tenantId = currentTenantId || 'default';
		if (!initializedOptionsTenantId || initializedOptionsTenantId === tenantId) return;
		void loadFlowSettingOptions();
	});

	$effect(() => {
		const activeFlowKey = savedFlow?.id ?? flow?.id ?? '';
		if (!activeFlowKey) return;
		const activeLocaleMarker = savedFlow ? 'saved-flow' : localeMarker;
		if (initializedFlowId === activeFlowKey && initializedLocaleMarker === activeLocaleMarker)
			return;
		const graph = savedFlow?.editor
			? buildGraphFromEditorState(savedFlow.editor)
			: buildInitialGraph(flow!);
		editorNodes = withCompletionSubflows(withNodeActions(graph.nodes));
		editorEdges = graph.edges;
		initializedFlowId = activeFlowKey;
		initializedLocaleMarker = activeLocaleMarker;
		nextNodeIndex = graph.nodes.length;
		editingNodeId = null;
	});

	$effect(() => {
		const element = flowCanvasElement;
		if (!element) return;

		const handleConfigureNode = (event: Event) => {
			const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId;
			if (!nodeId) return;
			openNodeConfig(nodeId);
		};

		const handleDeleteEdge = (event: Event) => {
			const edgeId = (event as CustomEvent<{ edgeId?: string }>).detail?.edgeId;
			if (!edgeId) return;
			editorEdges = editorEdges.filter((edge) => edge.id !== edgeId);
		};

		element.addEventListener(CONFIGURE_NODE_EVENT, handleConfigureNode);
		element.addEventListener(DELETE_EDGE_EVENT, handleDeleteEdge);
		return () => {
			element.removeEventListener(CONFIGURE_NODE_EVENT, handleConfigureNode);
			element.removeEventListener(DELETE_EDGE_EVENT, handleDeleteEdge);
		};
	});

	$effect(() => {
		if (!editorEdges.some((edge) => edgeNeedsNormalization(edge))) return;
		editorEdges = normalizeEditorEdges(editorEdges);
	});

	function createEmptyDraft(): NodeDraft {
		return {
			title: '',
			description: '',
			settingsText: '',
			authProfile: 'default',
			screen: 'basic_profile',
			consentPolicy: 'registration_consent_policy',
			conditionType: 'always',
			conditionValue: '',
			conditionOutputHandle: 'matched',
			conditionOutputLabel: $LL.admin_flows_output_matched(),
			conditionRows: [
				{
					id: 'condition-1',
					label: $LL.admin_flows_output_matched(),
					type: 'always',
					value: '',
					outputHandle: 'matched'
				}
			],
			conditionOtherwiseMode: 'output',
			conditionOtherwiseOutputHandle: 'otherwise',
			conditionOtherwiseOutputLabel: $LL.admin_flows_output_otherwise(),
			conditionTerminalError: 'condition_not_met',
			conditionTerminalMessage: ''
		};
	}

	async function loadFlowSettingOptions() {
		const tenantId = currentTenantId || undefined;
		const optionsTenantId = tenantId || 'default';
		flowSettingsError = '';
		try {
			const [authenticationMethods, screens, consentPolicies] = await Promise.all([
				adminAuthenticationMethodsAPI.get(tenantId),
				adminScreensAPI.list(),
				adminConsentPoliciesAPI.listPolicies()
			]);
			const nextAuthProfileOptions = [createDefaultAuthProfileOption(authenticationMethods)];
			const nextScreenOptions = screens.screens.map(createScreenOption);
			const nextConsentPolicyOptions = consentPolicies.policies.map(createConsentPolicyOption);
			loadedAuthProfileOptions = nextAuthProfileOptions;
			loadedScreens = screens.screens;
			loadedScreenOptions = nextScreenOptions;
			loadedConsentPolicyOptions = nextConsentPolicyOptions;
			screensLoaded = true;
			consentPoliciesLoaded = true;
			initializedOptionsTenantId = optionsTenantId;
			syncConfiguredNodeOptions(
				nextAuthProfileOptions,
				nextScreenOptions,
				nextConsentPolicyOptions
			);
		} catch (error) {
			flowSettingsError =
				error instanceof Error ? error.message : $LL.admin_flows_runtime_options_error();
			initializedOptionsTenantId = optionsTenantId;
			loadedScreens = [];
			screensLoaded = false;
			consentPoliciesLoaded = false;
		}
	}

	async function loadSavedFlow() {
		if (!flowId) return;
		flowLoading = true;
		flowLoadError = '';
		try {
			const response = await adminFlowsAPI.get(flowId);
			savedFlow = response.flow;
			syncFlowMetadata(response.flow);
		} catch (error) {
			savedFlow = null;
			flowLoadError = error instanceof Error ? error.message : $LL.admin_flows_load_error();
		} finally {
			flowLoading = false;
		}
	}

	function syncFlowMetadata(flowValue: AdminFlow) {
		flowSlug = flowValue.slug;
		flowDisplayName = flowValue.display_name || flowValue.name || flowValue.slug;
		flowDescription = flowValue.description ?? '';
	}

	function getAdminFlowKindLabel(kind: AdminFlowKind): string {
		switch (kind) {
			case 'approve':
				return $LL.admin_flows_kind_authorization();
			case 'registration':
				return $LL.admin_flows_kind_registration();
			case 'login':
				return $LL.admin_flows_kind_login();
			case 'account':
				return $LL.admin_flows_palette_account_label();
			default:
				return kind;
		}
	}

	function createDefaultAuthProfileOption(
		response: AuthenticationMethodSettingsResponse
	): FlowEditorAuthProfileOption {
		const outputs: FlowEditorNodeOutput[] = [];
		const usedOutputIds = new Set<string>();
		const builtIn = response.builtIn;

		if (builtIn.emailOtpLoginEnabled || builtIn.emailOtpSignupEnabled) {
			addAuthOutput(outputs, usedOutputIds, 'mail_otp', $LL.admin_flows_setting_email_otp());
		}
		if (builtIn.totpLoginEnabled || builtIn.totpSignupEnabled) {
			addAuthOutput(outputs, usedOutputIds, 'totp', $LL.admin_flows_setting_totp());
		}
		if (builtIn.passkeyLoginEnabled || builtIn.passkeySignupEnabled) {
			addAuthOutput(outputs, usedOutputIds, 'passkey', $LL.admin_flows_setting_passkey());
		}
		if (response.directoryPassword.loginEnabled) {
			addAuthOutput(
				outputs,
				usedOutputIds,
				'directory_password',
				$LL.admin_flows_setting_directory_password()
			);
		}

		const externalProviderKeys: string[] = [];
		for (const provider of response.externalProviderUsages) {
			if (!provider.enabled || (!provider.loginEnabled && !provider.signupEnabled)) continue;
			externalProviderKeys.push(provider.id, provider.providerId);
			addAuthOutput(outputs, usedOutputIds, provider.id, provider.name || provider.id);
		}
		for (const provider of response.providers) {
			if (!provider.enabled || (!provider.loginEnabled && !provider.signupEnabled)) continue;
			if (
				externalProviderKeys.includes(provider.id) ||
				(provider.slug && externalProviderKeys.includes(provider.slug))
			) {
				continue;
			}
			addAuthOutput(
				outputs,
				usedOutputIds,
				provider.slug || provider.id,
				provider.name || provider.id
			);
		}

		return {
			value: 'default',
			label: $LL.admin_flows_auth_profile_default(),
			outputs
		};
	}

	function addAuthOutput(
		outputs: FlowEditorNodeOutput[],
		usedOutputIds: Set<string>,
		rawId: string,
		label: string
	) {
		const baseId = normalizeOutputHandle(rawId);
		let nextId = baseId;
		let suffix = 2;
		while (usedOutputIds.has(nextId)) {
			nextId = `${baseId}_${suffix}`;
			suffix += 1;
		}
		usedOutputIds.add(nextId);
		outputs.push({ id: nextId, label });
	}

	function normalizeOutputHandle(value: string): string {
		const normalized = value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, '_')
			.replace(/^_+|_+$/g, '');
		return normalized || 'method';
	}

	function createConsentPolicyOption(policy: ConsentPolicy): FlowEditorOption {
		const label = policy.display_name || policy.name || policy.id;
		return {
			value: policy.id,
			label: policy.is_active ? label : `${label} (${$LL.admin_flows_consent_policy_inactive()})`
		};
	}

	function createScreenOption(screen: Screen): FlowEditorOption {
		const label = screen.display_name || screen.screen_key || screen.id;
		return {
			value: screen.id,
			label: screen.is_active ? label : `${label} (${$LL.admin_flows_consent_policy_inactive()})`
		};
	}

	function firstSelectableValue(options: FlowEditorOption[]): string {
		return options.find((option) => !option.disabled && option.value)?.value ?? '';
	}

	function noScreenOption(): FlowEditorOption {
		return {
			value: '',
			label: ft('利用できるスクリーンがありません', 'No screens are available'),
			disabled: true
		};
	}

	function screenKind(screen: Screen): ScreenKind {
		return screen.screen_kind;
	}

	function screenMatchesScreenKinds(screen: Screen, screenKinds: ScreenKind[]): boolean {
		const active = screen.is_active === true || screen.is_active === 1;
		const kind = screenKind(screen);
		if (screenKinds.includes('code_input')) return active && kind === 'code_input';
		return active && (screenKinds.includes(kind) || kind === 'custom');
	}

	function screenOptionsForKinds(screenKinds: ScreenKind[]): FlowEditorOption[] {
		if (!screensLoaded) return screenOptions;
		const options = loadedScreens
			.filter((screen) => screenMatchesScreenKinds(screen, screenKinds))
			.map(createScreenOption);
		return options.length > 0 ? options : [noScreenOption()];
	}

	function screenKindsForNode(kind: FlowEditorNodeKind): ScreenKind[] {
		if (kind === 'registration') return ['registration'];
		if (kind === 'authentication') return ['login'];
		if (kind === 'verification') return ['code_input'];
		if (kind === 'profile') return ['profile_completion'];
		if (kind === 'consent') return ['consent'];
		return ['custom'];
	}

	function screenOptionsForNodeKind(kind: FlowEditorNodeKind): FlowEditorOption[] {
		return screenOptionsForKinds(screenKindsForNode(kind));
	}

	function firstScreenForNodeKind(kind: FlowEditorNodeKind, fallback: string): string {
		if (kind === 'verification') {
			return preferredScreenValue(['code_input'], ['code_input'], fallback);
		}
		return firstSelectableValue(screenOptionsForNodeKind(kind)) || fallback;
	}

	function preferredScreenValue(
		screenKeys: string[],
		screenKinds: ScreenKind[],
		fallback: string
	): string {
		const keyMatches = new Set(screenKeys.map((value) => value.toLowerCase()));
		const acceptedKinds = screenKinds.includes('code_input')
			? screenKinds
			: [...screenKinds, 'custom'];
		const kindMatches = new Set(acceptedKinds.map((value) => value.toLowerCase()));
		const screen =
			loadedScreens.find(
				(item) => item.is_active && keyMatches.has((item.screen_key ?? '').toLowerCase())
			) ??
			loadedScreens.find(
				(item) => item.is_active && kindMatches.has((item.screen_kind ?? '').toLowerCase())
			);
		return screen?.id ?? (firstSelectableValue(screenOptionsForKinds(screenKinds)) || fallback);
	}

	function normalizeOptionValue(
		value: string,
		options: FlowEditorOption[],
		fallback: string
	): string {
		if (options.some((option) => !option.disabled && option.value === value)) return value;
		return firstSelectableValue(options) || fallback;
	}

	function syncConfiguredNodeOptions(
		nextAuthProfileOptions: FlowEditorAuthProfileOption[],
		_nextScreenOptions: FlowEditorOption[],
		nextConsentPolicyOptions: FlowEditorOption[]
	) {
		const effectiveConsentPolicyOptions =
			nextConsentPolicyOptions.length > 0
				? nextConsentPolicyOptions
				: [
						{
							value: '',
							label: $LL.admin_flows_consent_policy_none_available(),
							disabled: true
						}
					];
		const nextNodes = getEditorNodes().map<EditorNode>((node) => {
			if (node.data.kind === 'registration' || node.data.kind === 'authentication') {
				const screenOptions = screenOptionsForNodeKind(node.data.kind);
				const authProfile = normalizeOptionValue(
					getConfigValue(node, 'authProfile', 'default'),
					nextAuthProfileOptions,
					'default'
				);
				const outputs = getAuthProfileOutputsFromOptions(nextAuthProfileOptions, authProfile);
				const screen = normalizeOptionValue(
					getConfigValue(node, 'screen', 'basic_profile'),
					screenOptions,
					firstSelectableValue(screenOptions) || 'basic_profile'
				);
				const hasConsentWidget = selectedScreenHasConsentWidget(screen);
				const consentPolicy = hasConsentWidget
					? normalizeOptionValue(
							getConfigValue(node, 'consentPolicy', ''),
							effectiveConsentPolicyOptions,
							''
						)
					: getConfigValue(node, 'consentPolicy', '');
				const settings =
					node.data.kind === 'registration' || node.data.kind === 'authentication'
						? [
								getLabel(nextAuthProfileOptions, authProfile),
								getLabel(screenOptions, screen),
								...(hasConsentWidget && consentPolicy
									? [getLabel(effectiveConsentPolicyOptions, consentPolicy)]
									: [])
							]
						: [getLabel(nextAuthProfileOptions, authProfile)];
				return {
					...node,
					data: {
						...node.data,
						authProfile,
						screen,
						consentPolicy,
						outputs,
						settings
					}
				};
			}

			if (node.data.kind === 'consent') {
				const screenOptions = screenOptionsForNodeKind('consent');
				const screen = normalizeOptionValue(
					getConfigValue(node, 'screen', firstSelectableValue(screenOptions)),
					screenOptions,
					firstSelectableValue(screenOptions)
				);
				const consentPolicy = normalizeOptionValue(
					getConfigValue(node, 'consentPolicy', 'registration_consent_policy'),
					effectiveConsentPolicyOptions,
					''
				);
				const retainedSettings = node.data.screen
					? node.data.settings.slice(2)
					: node.data.settings.slice(1);
				return {
					...node,
					data: {
						...node.data,
						screen,
						consentPolicy,
						settings: [
							getLabel(effectiveConsentPolicyOptions, consentPolicy),
							...(screen ? [getLabel(screenOptions, screen)] : []),
							...retainedSettings
						]
					}
				};
			}

			if (node.data.kind === 'profile') {
				const screenOptions = screenOptionsForNodeKind('profile');
				const screen = normalizeOptionValue(
					getConfigValue(node, 'screen', 'basic_profile'),
					screenOptions,
					firstSelectableValue(screenOptions) || 'basic_profile'
				);
				const hasConsentWidget = selectedScreenHasConsentWidget(screen);
				const consentPolicy = hasConsentWidget
					? normalizeOptionValue(
							getConfigValue(node, 'consentPolicy', ''),
							effectiveConsentPolicyOptions,
							''
						)
					: getConfigValue(node, 'consentPolicy', '');
				const retainedSettings = node.data.settings.slice(hasConsentWidget ? 2 : 1);
				return {
					...node,
					data: {
						...node.data,
						screen,
						settings: [
							getLabel(screenOptions, screen),
							...(hasConsentWidget && consentPolicy
								? [getLabel(effectiveConsentPolicyOptions, consentPolicy)]
								: []),
							...retainedSettings
						],
						consentPolicy
					}
				};
			}

			return node;
		});
		editorNodes = withCompletionSubflows(withNodeActions(nextNodes));
		const outputIdsByNodeId = new Map(
			nextNodes.map((node) => [node.id, new Set(node.data.outputs.map((output) => output.id))])
		);
		editorEdges = editorEdges.filter((edge) => {
			if (!edge.sourceHandle) return true;
			return outputIdsByNodeId.get(edge.source)?.has(edge.sourceHandle) ?? true;
		});
	}

	function withNodeActions(nodes: EditorNode[]): EditorNode[] {
		return nodes.map((node) => ({
			...node,
			data: {
				...node.data,
				configure: openNodeConfig,
				hover: setHoveredEditorNode
			}
		}));
	}

	function setHoveredEditorNode(nodeId: string | null) {
		if (hoveredEditorNodeId === nodeId) return;
		hoveredEditorNodeId = nodeId;
		editorEdges = editorEdges.map((edge) => {
			const connected = !!nodeId && (edge.source === nodeId || edge.target === nodeId);
			const data = {
				...(edge.data ?? {}),
				highlighted: connected,
				dimmed: !!nodeId && !connected
			};
			return { ...edge, data };
		});
	}

	function isEditorNode(node: FlowNode | Node): node is EditorNode {
		return node.type === 'editor';
	}

	function isCompletionGroupNode(node: FlowNode | Node): node is CompletionGroupNode {
		return node.type === 'completionGroup';
	}

	function getEditorNodes(nodes: Node[] = editorNodes): EditorNode[] {
		const groups = new Map(nodes.filter(isCompletionGroupNode).map((node) => [node.id, node]));
		return nodes.filter(isEditorNode).map((node) => {
			const parent = node.parentId ? groups.get(node.parentId) : null;
			const position = parent
				? {
						x: parent.position.x + node.position.x,
						y: parent.position.y + node.position.y
					}
				: node.position;
			return {
				...node,
				parentId: undefined,
				extent: undefined,
				position: snapPosition(position)
			};
		});
	}

	function withCompletionSubflows(nodes: EditorNode[]): FlowNode[] {
		const absoluteNodes = getEditorNodes(nodes);
		const groupItems: Array<{ id: string; nodes: EditorNode[]; block: FlowEditorCompletionBlock }> =
			[];

		for (const node of absoluteNodes) {
			const block = node.data.completionBlock;
			if (!block?.id) continue;
			const existing = groupItems.find((group) => group.id === block.id);
			if (existing) {
				existing.nodes = [...existing.nodes, node];
			} else {
				groupItems.push({ id: block.id, nodes: [node], block });
			}
		}

		const groupedNodeById = new SvelteMap<string, EditorNode>();
		const groups = groupItems
			.filter((group) => group.nodes.length > 1)
			.map<CompletionGroupNode>((group) => {
				const minX = Math.min(...group.nodes.map((node) => node.position.x));
				const minY = Math.min(...group.nodes.map((node) => node.position.y));
				const maxX = Math.max(...group.nodes.map((node) => node.position.x + DEFAULT_NODE_WIDTH));
				const maxY = Math.max(...group.nodes.map((node) => node.position.y + DEFAULT_NODE_HEIGHT));
				const padding = 34;
				const groupPosition = snapPosition({
					x: minX - padding,
					y: minY - padding
				});
				const width = snapToGrid(maxX - minX + padding * 2);
				const height = snapToGrid(maxY - minY + padding * 2);
				const groupId = completionGroupId(group.id);

				for (const node of group.nodes) {
					groupedNodeById.set(node.id, {
						...node,
						parentId: groupId,
						extent: 'parent',
						position: snapPosition({
							x: node.position.x - groupPosition.x,
							y: node.position.y - groupPosition.y
						})
					});
				}

				return {
					id: groupId,
					type: 'completionGroup',
					data: {
						label: group.block.label,
						protocol: group.block.protocol,
						purpose: group.block.purpose
					},
					position: groupPosition,
					style: `width: ${width}px; height: ${height}px;`,
					draggable: true,
					selectable: true,
					deletable: true,
					zIndex: 0
				};
			});

		const children = absoluteNodes.map((node) => groupedNodeById.get(node.id) ?? node);
		return [...groups, ...children];
	}

	function completionGroupId(blockId: string): string {
		return `completion-group:${blockId}`;
	}

	function buildInitialGraph(template: NewFlowTemplate): {
		nodes: EditorNode[];
		edges: EditorEdge[];
	} {
		if (template.id === 'default-registration') {
			return buildRegistrationGraph();
		}
		if (template.id === 'default-registration-no-consent') {
			return buildRegistrationNoConsentGraph();
		}
		if (template.id === 'default-login') {
			return buildLoginGraph();
		}
		if (template.id === 'default-login-no-consent') {
			return buildLoginNoConsentGraph();
		}

		const nodes = template.nodes.map<EditorNode>((node, index) =>
			(() => {
				const localizedNode = getLocalizedFlowNode($LL, template.id, node);
				const kind = inferNodeKind(node.id, node.label);
				return createEditorNode({
					id: node.id,
					kind,
					title: localizedNode.label,
					description: localizedNode.description,
					settings: localizedNode.settings,
					position: { x: DEFAULT_NODE_X, y: index * COMPACT_NODE_Y_GAP },
					outputs: getTemplateNodeOutputs(kind, node.id),
					data: getTemplateNodeData(kind, template, node.id)
				});
			})()
		);
		const edges = nodes
			.slice(0, -1)
			.map<EditorEdge>((node, index) =>
				createEditorEdge(
					node.id,
					nodes[index + 1].id,
					getDefaultSourceHandle(getRuntimeTypeForNode(node)) ?? 'default'
				)
			);
		return { nodes, edges };
	}

	function getTemplateNodeOutputs(
		kind: FlowEditorNodeKind,
		nodeId: string
	): FlowEditorNodeOutput[] {
		if (kind === 'authentication' || kind === 'registration') {
			return getAuthProfileOutputs('default');
		}
		if (kind === 'session') {
			return getDefaultOutputsForRuntimeType('session_check');
		}
		if (nodeId === 'output') {
			return [];
		}
		return getDefaultOutputsForKind(kind);
	}

	function getTemplateNodeData(
		kind: FlowEditorNodeKind,
		template: NewFlowTemplate,
		nodeId: string
	): Partial<FlowEditorNodeData> {
		const data: Partial<FlowEditorNodeData> = {
			completionBlock: completionBlockForTemplateNode(template, nodeId)
		};
		if (kind === 'authentication' || kind === 'registration') {
			data.authProfile = 'default';
		}
		if (kind === 'session') {
			data.runtimeType = 'session_check';
		}
		if (kind === 'consent') {
			data.screen = preferredScreenValue(['consent'], ['consent'], 'basic_profile');
			data.consentPolicy = resolveConsentPolicyValue(
				template.id === 'saml-attribute-release' || template.id === 'academic-saml-login'
					? 'saml_attribute_release_policy'
					: template.id === 'default-registration'
						? 'registration_consent_policy'
						: 'oidc_authorization_consent_policy'
			);
		}
		return data;
	}

	function resolveConsentPolicyValue(preferredValue: string): string {
		const preferred = consentPolicyOptions.find(
			(option) => !option.disabled && option.value === preferredValue
		);
		if (preferred) return preferred.value;
		return firstSelectableValue(consentPolicyOptions);
	}

	function buildRegistrationGraph(): { nodes: EditorNode[]; edges: EditorEdge[] } {
		const registrationOutputs = getAuthProfileOutputs('default');
		const defaultScreen = preferredScreenValue(['registration'], ['registration'], 'basic_profile');
		const defaultConsentScreen = preferredScreenValue(['consent'], ['consent'], 'basic_profile');
		const oidcRegistrationBlock = createCompletionBlock('oidc', 'registration', 'consent');
		const nodes: EditorNode[] = [
			createEditorNode({
				id: 'request',
				kind: 'start',
				title: $LL.admin_flows_node_registration_request(),
				description: $LL.admin_flows_editor_registration_request_description(),
				settings: [
					$LL.admin_flows_setting_application_context(),
					$LL.admin_flows_editor_setting_prompt_create(),
					$LL.admin_flows_editor_setting_signup_entry()
				],
				position: { x: DEFAULT_NODE_X, y: 0 },
				outputs: [{ id: 'next', label: $LL.admin_flows_output_start_registration() }]
			}),
			createEditorNode({
				id: 'registration-method',
				kind: 'registration',
				title: $LL.admin_flows_node_registration_method(),
				description: $LL.admin_flows_editor_registration_method_description(),
				settings: [
					getLabel(authProfileOptions, 'default'),
					getLabel(screenOptionsForNodeKind('registration'), defaultScreen)
				],
				position: { x: DEFAULT_NODE_X, y: 140 },
				outputs: registrationOutputs,
				data: {
					authProfile: 'default',
					screen: defaultScreen
				}
			}),
			createEditorNode({
				id: 'profile-input',
				kind: 'profile',
				title: $LL.admin_flows_node_profile_input(),
				description: $LL.admin_flows_editor_profile_input_description(),
				settings: [
					$LL.admin_flows_editor_setting_basic_profile(),
					$LL.admin_flows_editor_setting_email(),
					$LL.admin_flows_editor_setting_name()
				],
				position: { x: DEFAULT_NODE_X, y: 380 },
				outputs: [{ id: 'submitted', label: $LL.admin_flows_output_profile_completed() }],
				data: { screen: defaultScreen }
			}),
			createEditorNode({
				id: 'consent',
				kind: 'consent',
				title: $LL.admin_flows_setting_registration_consent(),
				description: $LL.admin_flows_editor_registration_consent_description(),
				settings: [
					$LL.admin_flows_consent_policy_registration(),
					getLabel(screenOptionsForNodeKind('consent'), defaultConsentScreen),
					$LL.admin_flows_setting_terms_of_service(),
					$LL.admin_flows_setting_privacy_policy()
				],
				position: { x: DEFAULT_NODE_X, y: 520 },
				outputs: [{ id: 'accepted', label: $LL.admin_flows_output_accepted() }],
				data: {
					screen: defaultConsentScreen,
					consentPolicy: 'registration_consent_policy',
					completionBlock: oidcRegistrationBlock
				}
			}),
			createEditorNode({
				id: 'account-create',
				kind: 'account',
				title: $LL.admin_flows_node_account_creation(),
				description: $LL.admin_flows_editor_account_creation_description(),
				settings: [
					$LL.admin_flows_setting_user_record(),
					$LL.admin_flows_setting_credential_binding(),
					$LL.admin_flows_setting_audit_event()
				],
				position: { x: DEFAULT_NODE_X, y: 660 },
				outputs: [{ id: 'completed', label: $LL.admin_flows_output_created() }]
			}),
			createEditorNode({
				id: 'end',
				kind: 'end',
				title: $LL.admin_flows_palette_end_label(),
				description: $LL.admin_flows_editor_end_description(),
				settings: [
					$LL.admin_flows_setting_authorization_code(),
					$LL.admin_flows_setting_id_token_claims(),
					$LL.admin_flows_editor_setting_redirect()
				],
				position: { x: DEFAULT_NODE_X, y: 800 },
				outputs: [{ id: 'default', label: $LL.admin_flows_output_complete() }],
				data: {
					completionBlock: {
						...oidcRegistrationBlock,
						role: 'output'
					}
				}
			})
		];

		const edges: EditorEdge[] = [
			createEditorEdge('request', 'registration-method', 'next'),
			createEditorEdge('registration-method', 'profile-input', 'mail_otp'),
			createEditorEdge('registration-method', 'profile-input', 'totp'),
			createEditorEdge('registration-method', 'profile-input', 'passkey'),
			createEditorEdge('registration-method', 'profile-input', 'facebook'),
			createEditorEdge('profile-input', 'consent', 'submitted'),
			createEditorEdge('consent', 'account-create', 'accepted'),
			createEditorEdge('account-create', 'end', 'completed')
		];

		return { nodes, edges };
	}

	function buildRegistrationNoConsentGraph(): { nodes: EditorNode[]; edges: EditorEdge[] } {
		const registrationOutputs = getAuthProfileOutputs('default');
		const oidcRegistrationBlock = createCompletionBlock('oidc', 'registration', 'output');
		const nodes: EditorNode[] = [
			createEditorNode({
				id: 'request',
				kind: 'start',
				title: $LL.admin_flows_node_registration_request(),
				description: $LL.admin_flows_editor_registration_request_description(),
				settings: [
					$LL.admin_flows_setting_application_context(),
					$LL.admin_flows_editor_setting_prompt_create(),
					$LL.admin_flows_editor_setting_signup_entry()
				],
				position: { x: DEFAULT_NODE_X, y: 0 },
				outputs: [{ id: 'next', label: $LL.admin_flows_output_start_registration() }]
			}),
			createEditorNode({
				id: 'registration-method',
				kind: 'registration',
				title: $LL.admin_flows_node_registration_method(),
				description: $LL.admin_flows_editor_registration_method_description(),
				settings: [getLabel(authProfileOptions, 'default')],
				position: { x: DEFAULT_NODE_X, y: 140 },
				outputs: registrationOutputs,
				data: {
					authProfile: 'default'
				}
			}),
			createEditorNode({
				id: 'account-create',
				kind: 'account',
				title: $LL.admin_flows_node_account_creation(),
				description: $LL.admin_flows_editor_account_creation_description(),
				settings: [
					$LL.admin_flows_setting_user_record(),
					$LL.admin_flows_setting_credential_binding(),
					$LL.admin_flows_setting_audit_event()
				],
				position: { x: DEFAULT_NODE_X, y: 280 },
				outputs: [{ id: 'completed', label: $LL.admin_flows_output_created() }]
			}),
			createEditorNode({
				id: 'end',
				kind: 'end',
				title: $LL.admin_flows_palette_end_label(),
				description: $LL.admin_flows_editor_end_description(),
				settings: [
					$LL.admin_flows_setting_authorization_code(),
					$LL.admin_flows_setting_id_token_claims(),
					$LL.admin_flows_editor_setting_redirect()
				],
				position: { x: DEFAULT_NODE_X, y: 420 },
				outputs: [{ id: 'default', label: $LL.admin_flows_output_complete() }],
				data: {
					completionBlock: oidcRegistrationBlock
				}
			})
		];

		const edges: EditorEdge[] = [
			createEditorEdge('request', 'registration-method', 'next'),
			...registrationOutputs.map((output) =>
				createEditorEdge('registration-method', 'account-create', output.id)
			),
			createEditorEdge('account-create', 'end', 'completed')
		];

		return { nodes, edges };
	}

	function buildLoginGraph(): { nodes: EditorNode[]; edges: EditorEdge[] } {
		const authenticationOutputs = getAuthProfileOutputs('default');
		const defaultLoginScreen = preferredScreenValue(['login'], ['login'], 'basic_profile');
		const defaultConsentScreen = preferredScreenValue(['consent'], ['consent'], 'basic_profile');
		const samlConsentPolicy = resolveConsentPolicyValue('saml_attribute_release_policy');
		const oidcConsentPolicy = resolveConsentPolicyValue('oidc_authorization_consent_policy');
		const samlAttributeReleaseBlock = createCompletionBlock('saml', 'attribute_release', 'consent');
		const oidcAuthorizationBlock = createCompletionBlock('oidc', 'authorization', 'consent');
		const nodes: EditorNode[] = [
			createEditorNode({
				id: 'request',
				kind: 'start',
				title: $LL.admin_flows_node_login_request(),
				description: $LL.admin_flows_editor_login_request_description(),
				settings: [
					$LL.admin_flows_setting_application_context(),
					$LL.admin_flows_setting_redirect_uri(),
					$LL.admin_flows_setting_scope_prompt_max_age()
				],
				position: { x: DEFAULT_NODE_X, y: 0 },
				outputs: [{ id: 'next', label: $LL.admin_flows_output_next() }]
			}),
			createEditorNode({
				id: 'session-check',
				kind: 'session',
				title: $LL.admin_flows_node_session_check(),
				description: $LL.admin_flows_node_oidc_login_session_description(),
				settings: getDefaultNodeSettings('session', 'default', 'basic_profile', ''),
				position: { x: DEFAULT_NODE_X, y: 140 },
				outputs: getDefaultOutputsForRuntimeType('session_check'),
				data: { runtimeType: 'session_check' }
			}),
			createEditorNode({
				id: 'authentication',
				kind: 'authentication',
				title: $LL.admin_flows_node_authentication_method(),
				description: $LL.admin_flows_node_oidc_login_authentication_description(),
				settings: [
					getLabel(authProfileOptions, 'default'),
					getLabel(screenOptionsForNodeKind('authentication'), defaultLoginScreen)
				],
				position: { x: 522, y: 280 },
				outputs: authenticationOutputs,
				data: { authProfile: 'default', screen: defaultLoginScreen }
			}),
			createEditorNode({
				id: 'saml-attribute-release-consent',
				kind: 'consent',
				title: $LL.admin_flows_node_consent(),
				description: $LL.admin_flows_node_oidc_login_consent_description(),
				settings: [
					...(samlConsentPolicy ? [getLabel(consentPolicyOptions, samlConsentPolicy)] : []),
					getLabel(screenOptionsForNodeKind('consent'), defaultConsentScreen)
				],
				position: { x: 108, y: 468 },
				outputs: [{ id: 'accepted', label: $LL.admin_flows_output_accepted() }],
				data: {
					screen: defaultConsentScreen,
					consentPolicy: samlConsentPolicy,
					completionBlock: samlAttributeReleaseBlock
				}
			}),
			createEditorNode({
				id: 'saml-attribute-release-complete',
				kind: 'end',
				title: $LL.admin_flows_palette_end_label(),
				description: $LL.admin_flows_node_saml_output_description(),
				settings: [$LL.admin_flows_setting_saml_assertion()],
				position: { x: 108, y: 612 },
				outputs: [],
				data: {
					completionBlock: {
						...samlAttributeReleaseBlock,
						role: 'output'
					}
				}
			}),
			createEditorNode({
				id: 'oidc-authorization-consent',
				kind: 'consent',
				title: $LL.admin_flows_node_consent(),
				description: $LL.admin_flows_node_oidc_login_consent_description(),
				settings: [
					...(oidcConsentPolicy ? [getLabel(consentPolicyOptions, oidcConsentPolicy)] : []),
					getLabel(screenOptionsForNodeKind('consent'), defaultConsentScreen)
				],
				position: { x: 594, y: 468 },
				outputs: [{ id: 'accepted', label: $LL.admin_flows_output_accepted() }],
				data: {
					screen: defaultConsentScreen,
					consentPolicy: oidcConsentPolicy,
					completionBlock: oidcAuthorizationBlock
				}
			}),
			createEditorNode({
				id: 'oidc-authorization-complete',
				kind: 'end',
				title: $LL.admin_flows_palette_end_label(),
				description: $LL.admin_flows_node_oidc_login_output_description(),
				settings: [
					$LL.admin_flows_setting_authorization_code(),
					$LL.admin_flows_setting_id_token_claims(),
					$LL.admin_flows_setting_userinfo_claims()
				],
				position: { x: 594, y: 612 },
				outputs: [],
				data: {
					completionBlock: {
						...oidcAuthorizationBlock,
						role: 'output'
					}
				}
			})
		];

		const edges: EditorEdge[] = [
			createEditorEdge('request', 'session-check', 'next'),
			createEditorEdge('session-check', 'saml-attribute-release-consent', 'continue'),
			createEditorEdge('session-check', 'oidc-authorization-consent', 'continue'),
			createEditorEdge('session-check', 'authentication', 'authenticate'),
			...authenticationOutputs.flatMap((output) => [
				createEditorEdge('authentication', 'saml-attribute-release-consent', output.id),
				createEditorEdge('authentication', 'oidc-authorization-consent', output.id)
			]),
			createEditorEdge(
				'saml-attribute-release-consent',
				'saml-attribute-release-complete',
				'accepted'
			),
			createEditorEdge('oidc-authorization-consent', 'oidc-authorization-complete', 'accepted')
		];

		return { nodes, edges };
	}

	function buildLoginNoConsentGraph(): { nodes: EditorNode[]; edges: EditorEdge[] } {
		const authenticationOutputs = getAuthProfileOutputs('default');
		const defaultLoginScreen = preferredScreenValue(['login'], ['login'], 'basic_profile');
		const samlAttributeReleaseBlock = createCompletionBlock('saml', 'attribute_release', 'output');
		const oidcAuthorizationBlock = createCompletionBlock('oidc', 'authorization', 'output');
		const nodes: EditorNode[] = [
			createEditorNode({
				id: 'request',
				kind: 'start',
				title: $LL.admin_flows_node_login_request(),
				description: $LL.admin_flows_editor_login_request_description(),
				settings: [
					$LL.admin_flows_setting_application_context(),
					$LL.admin_flows_setting_redirect_uri(),
					$LL.admin_flows_setting_scope_prompt_max_age()
				],
				position: { x: DEFAULT_NODE_X, y: 0 },
				outputs: [{ id: 'next', label: $LL.admin_flows_output_next() }]
			}),
			createEditorNode({
				id: 'session-check',
				kind: 'session',
				title: $LL.admin_flows_node_session_check(),
				description: $LL.admin_flows_node_oidc_login_session_description(),
				settings: getDefaultNodeSettings('session', 'default', 'basic_profile', ''),
				position: { x: DEFAULT_NODE_X, y: 140 },
				outputs: getDefaultOutputsForRuntimeType('session_check'),
				data: { runtimeType: 'session_check' }
			}),
			createEditorNode({
				id: 'authentication',
				kind: 'authentication',
				title: $LL.admin_flows_node_authentication_method(),
				description: $LL.admin_flows_node_oidc_login_authentication_description(),
				settings: [
					getLabel(authProfileOptions, 'default'),
					getLabel(screenOptionsForNodeKind('authentication'), defaultLoginScreen)
				],
				position: { x: 522, y: 280 },
				outputs: authenticationOutputs,
				data: { authProfile: 'default', screen: defaultLoginScreen }
			}),
			createEditorNode({
				id: 'saml-attribute-release-complete',
				kind: 'end',
				title: $LL.admin_flows_palette_end_label(),
				description: $LL.admin_flows_node_saml_output_description(),
				settings: [$LL.admin_flows_setting_saml_assertion()],
				position: { x: 108, y: 612 },
				outputs: [],
				data: {
					completionBlock: samlAttributeReleaseBlock
				}
			}),
			createEditorNode({
				id: 'oidc-authorization-complete',
				kind: 'end',
				title: $LL.admin_flows_palette_end_label(),
				description: $LL.admin_flows_node_oidc_login_output_description(),
				settings: [
					$LL.admin_flows_setting_authorization_code(),
					$LL.admin_flows_setting_id_token_claims(),
					$LL.admin_flows_setting_userinfo_claims()
				],
				position: { x: 594, y: 612 },
				outputs: [],
				data: {
					completionBlock: oidcAuthorizationBlock
				}
			})
		];

		const edges: EditorEdge[] = [
			createEditorEdge('request', 'session-check', 'next'),
			createEditorEdge('session-check', 'saml-attribute-release-complete', 'continue'),
			createEditorEdge('session-check', 'oidc-authorization-complete', 'continue'),
			createEditorEdge('session-check', 'authentication', 'authenticate'),
			...authenticationOutputs.flatMap((output) => [
				createEditorEdge('authentication', 'saml-attribute-release-complete', output.id),
				createEditorEdge('authentication', 'oidc-authorization-complete', output.id)
			])
		];

		return { nodes, edges };
	}

	function completionBlockLabel(protocol: string, purpose: string): string {
		if (protocol === 'oidc' && purpose === 'registration') {
			return $LL.admin_flows_completion_block_oidc_registration();
		}
		if (protocol === 'oidc' && purpose === 'authorization') {
			return $LL.admin_flows_completion_block_oidc_authorization();
		}
		if (protocol === 'saml' && purpose === 'attribute_release') {
			return $LL.admin_flows_completion_block_saml_attribute_release();
		}
		if (protocol === 'direct') {
			return $LL.admin_flows_completion_block_direct_login();
		}
		return $LL.admin_flows_completion_block_generic();
	}

	function createCompletionBlock(
		protocol: string,
		purpose: string,
		role: FlowEditorCompletionBlock['role']
	): FlowEditorCompletionBlock {
		return {
			id: `${protocol}-${purpose}-completion`,
			label: completionBlockLabel(protocol, purpose),
			protocol,
			purpose,
			role
		};
	}

	function completionBlockForTemplateNode(
		template: NewFlowTemplate,
		nodeId: string
	): FlowEditorCompletionBlock | undefined {
		const role =
			nodeId === 'consent' || nodeId.endsWith('-consent')
				? 'consent'
				: nodeId === 'output' || nodeId.endsWith('-complete')
					? 'output'
					: undefined;
		if (!role) return undefined;
		const protocol = template.protocol.toLowerCase();
		const purpose =
			template.id === 'saml-attribute-release' || template.id === 'academic-saml-login'
				? 'attribute_release'
				: template.id === 'default-registration' ||
					  template.id === 'default-registration-no-consent'
					? 'registration'
					: 'authorization';
		return createCompletionBlock(protocol, purpose, role);
	}

	function getRuntimeNodeType(kind: FlowEditorNodeKind): string {
		switch (kind) {
			case 'start':
				return 'entry';
			case 'session':
				return 'session_check';
			case 'registration':
				return 'registration';
			case 'authentication':
				return 'authentication';
			case 'verification':
				return 'email_verification';
			case 'profile':
				return 'screen';
			case 'consent':
				return 'consent';
			case 'account':
				return 'account_action';
			case 'end':
				return 'complete';
			case 'oidc_completion':
			case 'saml_completion':
				return 'complete';
			case 'decision':
			default:
				return 'condition';
		}
	}

	function getEditorNodeKind(type: string, config?: Record<string, unknown>): FlowEditorNodeKind {
		const uiKind = config?.ui_kind;
		if (typeof uiKind === 'string' && isFlowEditorNodeKind(uiKind)) {
			return uiKind;
		}
		switch (type) {
			case 'entry':
				return 'start';
			case 'session_check':
				return 'session';
			case 'registration':
				return 'registration';
			case 'authentication':
				return 'authentication';
			case 'email_verification':
				return 'verification';
			case 'screen':
				return 'profile';
			case 'consent':
				return 'consent';
			case 'account_action':
				return 'account';
			case 'complete':
				return 'end';
			case 'condition':
			default:
				return 'decision';
		}
	}

	function getPersistedEditorNodeKind(
		node: FlowEditorState['nodes'][number],
		config?: Record<string, unknown>
	): FlowEditorNodeKind {
		const kind = getEditorNodeKind(node.type, config);
		if (kind !== 'decision') return kind;
		const title = typeof node.title === 'string' ? node.title : '';
		const value = `${node.id} ${title}`.toLowerCase();
		if (value.includes('session-check') || value.includes('session check')) {
			return 'session';
		}
		return kind;
	}

	function getRuntimeTypeForNode(node: EditorNode): string {
		const runtimeType = node.data.runtimeType;
		return typeof runtimeType === 'string' && runtimeType
			? runtimeType
			: getRuntimeNodeType(node.data.kind);
	}

	function getDefaultOutputsForRuntimeType(type: string): FlowEditorNodeOutput[] {
		switch (type) {
			case 'entry':
				return [{ id: 'next', label: $LL.admin_flows_output_next() }];
			case 'registration':
			case 'authentication':
				return getAuthProfileOutputs('default');
			case 'session_check':
				return [
					{ id: 'continue', label: $LL.admin_flows_session_output_continue() },
					{ id: 'authenticate', label: $LL.admin_flows_session_output_authenticate() }
				];
			case 'email_verification':
				return [
					{ id: 'verified', label: $LL.admin_flows_output_accepted() },
					{ id: 'failed', label: $LL.admin_flows_cancel() }
				];
			case 'screen':
				return [{ id: 'submitted', label: $LL.admin_flows_output_profile_completed() }];
			case 'consent':
				return [{ id: 'accepted', label: $LL.admin_flows_output_accepted() }];
			case 'account_action':
				return [{ id: 'completed', label: $LL.admin_flows_output_created() }];
			case 'condition':
				return [
					{ id: 'matched', label: $LL.admin_flows_output_matched() },
					{ id: 'otherwise', label: $LL.admin_flows_output_otherwise() }
				];
			case 'complete':
				return [];
			default:
				return [{ id: 'default', label: $LL.admin_flows_output_next() }];
		}
	}

	function getDefaultOutputsForKind(kind: FlowEditorNodeKind): FlowEditorNodeOutput[] {
		return getDefaultOutputsForRuntimeType(getRuntimeNodeType(kind));
	}

	function getDefaultSourceHandle(type: string): string | undefined {
		const outputs = getDefaultOutputsForRuntimeType(type);
		return outputs[0]?.id;
	}

	function getConfigRecord(value: unknown): Record<string, unknown> {
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	}

	function getConfigString(config: Record<string, unknown>, key: string, fallback: string): string {
		const value = config[key];
		return typeof value === 'string' ? value : fallback;
	}

	function getConfigStringArray(config: Record<string, unknown>, key: string): string[] {
		const value = config[key];
		return Array.isArray(value)
			? value.filter((item): item is string => typeof item === 'string')
			: [];
	}

	function getCompletionBlockFromConfig(
		config: Record<string, unknown>
	): FlowEditorCompletionBlock | undefined {
		const value = getConfigRecord(config.completion_block);
		const id = getConfigString(value, 'id', '');
		const protocol = getConfigString(value, 'protocol', '');
		const purpose = getConfigString(value, 'purpose', '');
		const roleValue = getConfigString(value, 'role', '');
		const role = roleValue === 'consent' || roleValue === 'output' ? roleValue : undefined;
		if (!id || !role) return undefined;
		const label = getConfigString(value, 'label', completionBlockLabel(protocol, purpose));
		return {
			id,
			label,
			...(protocol ? { protocol } : {}),
			...(purpose ? { purpose } : {}),
			role
		};
	}

	function getConfigOutputs(config: Record<string, unknown>, type: string): FlowEditorNodeOutput[] {
		const value = config.outputs;
		if (!Array.isArray(value)) return getDefaultOutputsForRuntimeType(type);
		const outputs = value
			.map((item) => getConfigRecord(item))
			.map((item) => ({
				id: typeof item.id === 'string' ? item.id : '',
				label: typeof item.label === 'string' ? item.label : ''
			}))
			.filter((item) => item.id && item.label);
		return outputs.length > 0 ? outputs : getDefaultOutputsForRuntimeType(type);
	}

	function isConditionDraftType(value: unknown): value is ConditionDraftType {
		return (
			value === 'always' ||
			value === 'protocol' ||
			value === 'authenticated' ||
			value === 'first_login' ||
			value === 'client_id' ||
			value === 'saml_sp_id' ||
			value === 'flow_kind' ||
			value === 'requested_scope' ||
			value === 'authentication_method'
		);
	}

	function getConditionTypeOptions(): Array<{ value: ConditionDraftType; label: string }> {
		return [
			{ value: 'always', label: $LL.admin_flows_condition_type_always() },
			{ value: 'protocol', label: ft('プロトコル', 'Protocol') },
			{ value: 'authenticated', label: $LL.admin_flows_condition_type_authenticated() },
			{ value: 'first_login', label: $LL.admin_flows_condition_type_first_login() },
			{ value: 'client_id', label: $LL.admin_flows_condition_type_client_id() },
			{ value: 'saml_sp_id', label: $LL.admin_flows_condition_type_saml_sp_id() },
			{ value: 'flow_kind', label: $LL.admin_flows_condition_type_flow_kind() },
			{ value: 'requested_scope', label: $LL.admin_flows_condition_type_requested_scope() },
			{
				value: 'authentication_method',
				label: $LL.admin_flows_condition_type_authentication_method()
			}
		];
	}

	function conditionValueToDraft(condition: Record<string, unknown>): string {
		const values = condition.values;
		if (Array.isArray(values)) return values.map(String).join(' ');
		if (condition.value !== undefined && condition.value !== null) return String(condition.value);
		return '';
	}

	function getConditionDraft(config: Record<string, unknown>): Partial<NodeDraft> {
		const conditions = getConfigRecord(config.conditions);
		const rows = Array.isArray(conditions.rows) ? conditions.rows : [];
		const otherwise = getConfigRecord(conditions.otherwise);
		const terminalError = getConfigRecord(otherwise.terminal_error);
		const otherwiseOutputHandle = getConfigString(otherwise, 'output_handle', 'otherwise');
		const outputs = getConfigOutputs(config, 'condition');
		const conditionRows = rows.map((value, index): ConditionRowDraft => {
			const row = getConfigRecord(value);
			const condition = getConfigRecord(row.condition);
			const outputHandle = getConfigString(row, 'output_handle', `matched-${index + 1}`);
			return {
				id: getConfigString(row, 'id', `condition-${index + 1}`),
				label:
					getConfigString(row, 'label', '') ||
					outputs.find((output) => output.id === outputHandle)?.label ||
					$LL.admin_flows_output_matched(),
				type: isConditionDraftType(condition.type) ? condition.type : 'always',
				value: conditionValueToDraft(condition),
				outputHandle
			};
		});
		const normalizedRows =
			conditionRows.length > 0
				? conditionRows
				: [
						{
							id: 'condition-1',
							label: $LL.admin_flows_output_matched(),
							type: 'always' as const,
							value: '',
							outputHandle: 'matched'
						}
					];
		const firstRow = normalizedRows[0];
		return {
			conditionType: firstRow.type,
			conditionValue: firstRow.value,
			conditionOutputHandle: firstRow.outputHandle,
			conditionOutputLabel: firstRow.label,
			conditionRows: normalizedRows,
			conditionOtherwiseMode: terminalError.error ? 'terminal_error' : 'output',
			conditionOtherwiseOutputHandle: otherwiseOutputHandle,
			conditionOtherwiseOutputLabel:
				outputs.find((output) => output.id === otherwiseOutputHandle)?.label ||
				$LL.admin_flows_output_otherwise(),
			conditionTerminalError: getConfigString(terminalError, 'error', 'condition_not_met'),
			conditionTerminalMessage: getConfigString(terminalError, 'message', '')
		};
	}

	function getConditionOutputsFromDraft(source: NodeDraft): FlowEditorNodeOutput[] {
		const outputs: FlowEditorNodeOutput[] = [];
		for (const row of source.conditionRows) {
			const id = normalizeOutputHandle(row.outputHandle || 'matched');
			if (outputs.some((output) => output.id === id)) continue;
			outputs.push({
				id,
				label: row.label.trim() || $LL.admin_flows_output_matched()
			});
		}
		if (source.conditionOtherwiseMode === 'output') {
			const otherwiseId = normalizeOutputHandle(
				source.conditionOtherwiseOutputHandle || 'otherwise'
			);
			if (!outputs.some((output) => output.id === otherwiseId)) {
				outputs.push({
					id: otherwiseId,
					label: source.conditionOtherwiseOutputLabel.trim() || $LL.admin_flows_output_otherwise()
				});
			}
		}
		return outputs;
	}

	function buildConditionExpression(row: ConditionRowDraft): Record<string, unknown> {
		if (row.type === 'always') {
			return { type: 'always' };
		}
		if (row.type === 'authenticated' || row.type === 'first_login') {
			return {
				type: row.type,
				value: row.value.trim().toLowerCase() === 'false' ? false : true
			};
		}
		const values = row.value
			.split(/[\s,]+/)
			.map((value) => value.trim())
			.filter(Boolean);
		return values.length > 1
			? { type: row.type, values }
			: { type: row.type, value: values[0] ?? '' };
	}

	function buildConditionConfig(source: NodeDraft): Record<string, unknown> {
		const otherwiseHandle = normalizeOutputHandle(
			source.conditionOtherwiseOutputHandle || 'otherwise'
		);
		return {
			rows: source.conditionRows.map((row, index) => ({
				id: row.id.trim() || `condition-${index + 1}`,
				label: row.label.trim() || $LL.admin_flows_output_matched(),
				condition: buildConditionExpression(row),
				output_handle: normalizeOutputHandle(row.outputHandle || `matched-${index + 1}`)
			})),
			otherwise:
				source.conditionOtherwiseMode === 'terminal_error'
					? {
							terminal_error: {
								error: source.conditionTerminalError.trim() || 'condition_not_met',
								message: source.conditionTerminalMessage.trim() || undefined
							}
						}
					: {
							output_handle: otherwiseHandle
						}
		};
	}

	function getNodeConditionRows(node: EditorNode): ConditionRowDraft[] {
		const value = node.data.conditionRows;
		if (Array.isArray(value)) {
			const rows = value
				.map((item, index): ConditionRowDraft | null => {
					const row = getConfigRecord(item);
					const type = isConditionDraftType(row.type) ? row.type : 'always';
					return {
						id: getConfigString(row, 'id', `condition-${index + 1}`),
						label: getConfigString(row, 'label', $LL.admin_flows_output_matched()),
						type,
						value: getConfigString(row, 'value', ''),
						outputHandle: getConfigString(row, 'outputHandle', `matched-${index + 1}`)
					};
				})
				.filter((row): row is ConditionRowDraft => row !== null);
			if (rows.length > 0) return rows;
		}
		return [
			{
				id: 'condition-1',
				label: getConfigValue(node, 'conditionOutputLabel', $LL.admin_flows_output_matched()),
				type: getConfigConditionType(node),
				value: getConfigValue(node, 'conditionValue', ''),
				outputHandle: getConfigValue(node, 'conditionOutputHandle', 'matched')
			}
		];
	}

	function nodeConditionDraft(node: EditorNode): NodeDraft {
		const conditionRows = getNodeConditionRows(node);
		const firstRow = conditionRows[0];
		return {
			...createEmptyDraft(),
			conditionType: firstRow.type,
			conditionValue: firstRow.value,
			conditionOutputHandle: firstRow.outputHandle,
			conditionOutputLabel: firstRow.label,
			conditionRows,
			conditionOtherwiseMode: getConfigOtherwiseMode(node),
			conditionOtherwiseOutputHandle: getConfigValue(
				node,
				'conditionOtherwiseOutputHandle',
				'otherwise'
			),
			conditionOtherwiseOutputLabel: getConfigValue(
				node,
				'conditionOtherwiseOutputLabel',
				$LL.admin_flows_output_otherwise()
			),
			conditionTerminalError: getConfigValue(node, 'conditionTerminalError', 'condition_not_met'),
			conditionTerminalMessage: getConfigValue(node, 'conditionTerminalMessage', '')
		};
	}

	function buildGraphFromEditorState(editor: FlowEditorState): {
		nodes: EditorNode[];
		edges: EditorEdge[];
	} {
		const nodes = editor.nodes.map<EditorNode>((node, index) => {
			const config = getConfigRecord(node.config);
			const kind = getPersistedEditorNodeKind(node, config);
			const settings = getConfigStringArray(config, 'settings');
			const authProfile = getConfigString(config, 'authentication_profile_ref', 'default');
			const screen = getConfigString(config, 'screen_ref', 'basic_profile');
			const consentPolicy = getConfigString(
				config,
				'consent_policy_ref',
				'registration_consent_policy'
			);
			const conditionDraft = getConditionDraft(config);
			const conditionNodeDraft: NodeDraft = { ...createEmptyDraft(), ...conditionDraft };
			return createEditorNode({
				id: node.id,
				kind,
				title: normalizePersistedNodeTitle(kind, node.title),
				description: getConfigString(config, 'description', ''),
				settings:
					kind === 'session'
						? getDefaultNodeSettings('session', authProfile, screen, consentPolicy)
						: settings.length > 0
							? settings
							: getDefaultNodeSettings(kind, authProfile, screen, consentPolicy),
				position: node.position ?? { x: DEFAULT_NODE_X, y: index * COMPACT_NODE_Y_GAP },
				outputs:
					kind === 'session'
						? getDefaultOutputsForRuntimeType('session_check')
						: kind === 'decision'
							? getConditionOutputsFromDraft(conditionNodeDraft)
							: getConfigOutputs(config, node.type),
				data: {
					runtimeType: kind === 'session' ? 'session_check' : node.type,
					authProfile,
					screen,
					consentPolicy,
					completionBlock: getCompletionBlockFromConfig(config),
					...conditionDraft
				}
			});
		});
		const nodeById = new Map(nodes.map((node) => [node.id, node]));
		const edges = editor.edges.map<EditorEdge>((edge) => {
			const sourceNode = nodeById.get(edge.source);
			const sourceHandle = normalizeSourceHandleForNode(sourceNode, edge.source_handle);
			return createEditorEdge(edge.source, edge.target, sourceHandle, edge.target_handle);
		});
		return { nodes, edges };
	}

	function getDefaultNodeTitle(kind: FlowEditorNodeKind): string {
		return nodePalette.find((item) => item.kind === kind)?.label ?? kind;
	}

	function normalizePersistedNodeTitle(
		kind: FlowEditorNodeKind,
		title: string | undefined
	): string {
		const trimmed = title?.trim() ?? '';
		if (kind === 'start' && (trimmed === 'START' || trimmed === 'Start')) {
			return $LL.admin_flows_palette_start_label();
		}
		if (kind === 'end' && (trimmed === 'END' || trimmed === 'End' || trimmed === 'Output')) {
			return $LL.admin_flows_palette_end_label();
		}
		return trimmed || getDefaultNodeTitle(kind);
	}

	function getDefaultNodeSettings(
		kind: FlowEditorNodeKind,
		authProfile: string,
		screen: string,
		consentPolicy: string
	): string[] {
		if (kind === 'registration') {
			const screenOptions = screenOptionsForNodeKind(kind);
			return [
				getLabel(authProfileOptions, authProfile),
				getLabel(screenOptions, screen),
				...(selectedScreenHasConsentWidget(screen) && consentPolicy
					? [getLabel(consentPolicyOptions, consentPolicy)]
					: [])
			];
		}
		if (kind === 'authentication') {
			const screenOptions = screenOptionsForNodeKind(kind);
			return [
				getLabel(authProfileOptions, authProfile),
				getLabel(screenOptions, screen),
				...(selectedScreenHasConsentWidget(screen) && consentPolicy
					? [getLabel(consentPolicyOptions, consentPolicy)]
					: [])
			];
		}
		if (kind === 'profile') {
			const screenOptions = screenOptionsForNodeKind(kind);
			return [
				getLabel(screenOptions, screen),
				...(selectedScreenHasConsentWidget(screen) && consentPolicy
					? [getLabel(consentPolicyOptions, consentPolicy)]
					: [])
			];
		}
		if (kind === 'verification') {
			const screenOptions = screenOptionsForNodeKind(kind);
			return [getLabel(screenOptions, screen)];
		}
		if (kind === 'consent') {
			const screenOptions = screenOptionsForNodeKind(kind);
			return [
				getLabel(consentPolicyOptions, consentPolicy),
				...(screen ? [getLabel(screenOptions, screen)] : [])
			];
		}
		if (kind === 'session') {
			return [
				$LL.admin_flows_setting_existing_session(),
				$LL.admin_flows_setting_prompt_login(),
				$LL.admin_flows_setting_max_age_acr()
			];
		}
		if (kind === 'decision') {
			return [$LL.admin_flows_condition_type_always()];
		}
		return [];
	}

	function createEditorNode(options: {
		id: string;
		kind: FlowEditorNodeKind;
		title: string;
		description: string;
		settings: string[];
		position: { x: number; y: number };
		outputs?: FlowEditorNodeOutput[];
		data?: Partial<FlowEditorNodeData>;
	}): EditorNode {
		return {
			id: options.id,
			type: 'editor',
			data: {
				kind: options.kind,
				title: options.title,
				description: options.description,
				settings: options.settings,
				outputs: options.outputs ?? getDefaultOutputsForKind(options.kind),
				runtimeType: getRuntimeNodeType(options.kind),
				...options.data
			},
			position: snapPosition(options.position),
			sourcePosition: Position.Bottom,
			targetPosition: Position.Top
		};
	}

	function snapToGrid(value: number): number {
		return Math.round(value / FLOW_SNAP_GRID_SIZE) * FLOW_SNAP_GRID_SIZE;
	}

	function snapPosition(position: { x: number; y: number }): { x: number; y: number } {
		return {
			x: snapToGrid(Math.max(FLOW_SNAP_GRID_SIZE, position.x)),
			y: snapToGrid(Math.max(FLOW_SNAP_GRID_SIZE, position.y))
		};
	}

	function createEditorEdge(
		source: string,
		target: string,
		sourceHandle = 'default',
		targetHandle?: string | null
	): EditorEdge {
		return {
			id: `${source}:${sourceHandle}->${target}:${targetHandle ?? 'default'}`,
			type: 'editor',
			source,
			target,
			sourceHandle,
			targetHandle,
			markerEnd: { type: MarkerType.ArrowClosed },
			data: { deletable: true }
		};
	}

	function edgeNeedsNormalization(edge: Edge): boolean {
		return (
			edge.type !== 'editor' ||
			!edge.markerEnd ||
			(edge.data as FlowEditorEdgeData | undefined)?.deletable !== true
		);
	}

	function normalizeEditorEdge(edge: Edge): EditorEdge {
		const sourceHandle = edge.sourceHandle ?? 'default';
		const targetHandle = edge.targetHandle ?? undefined;
		return {
			...createEditorEdge(edge.source, edge.target, sourceHandle, targetHandle),
			selected: edge.selected
		};
	}

	function normalizeEditorEdges(edges: Edge[]): EditorEdge[] {
		const normalized: EditorEdge[] = [];
		const signatures = new SvelteSet<string>();
		for (const edge of edges) {
			const nextEdge = normalizeEditorEdge(edge);
			const signature = edgeSignature(nextEdge);
			if (signatures.has(signature)) continue;
			signatures.add(signature);
			normalized.push(nextEdge);
		}
		return normalized;
	}

	function normalizeSourceHandleForNode(
		node: EditorNode | undefined,
		handle?: string | null
	): string {
		const value =
			handle || getDefaultSourceHandle(node ? getRuntimeTypeForNode(node) : '') || 'default';
		if (node?.data.kind !== 'session') return value;
		if (value === 'authenticated') return 'continue';
		if (value === 'login_required' || value === 'reauth_required') return 'authenticate';
		return value;
	}

	function filterEdgesForExistingNodes(
		edges: EditorEdge[],
		nodes: EditorNode[] = getEditorNodes()
	): EditorEdge[] {
		const nodeIds = new Set(nodes.map((node) => node.id));
		return edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
	}

	function edgeSignature(
		edge: Pick<EditorEdge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>
	) {
		return [
			edge.source,
			edge.sourceHandle ?? 'default',
			edge.target,
			edge.targetHandle ?? 'default'
		].join('::');
	}

	function inferNodeKind(id: string, label: string): FlowEditorNodeKind {
		const value = `${id} ${label}`.toLowerCase();
		if (value.includes('request') || value.includes('start')) return 'start';
		if (value.includes('session')) return 'session';
		if (value.includes('registration')) return 'registration';
		if (value.includes('auth')) return 'authentication';
		if (value.includes('verification')) return 'verification';
		if (value.includes('profile') || value.includes('schema')) return 'profile';
		if (value.includes('consent')) return 'consent';
		if (value.includes('account')) return 'account';
		if (value.includes('output') || value.includes('complete') || value.includes('end'))
			return 'end';
		return 'decision';
	}

	function getLabel(options: Array<{ value: string; label: string }>, value: string): string {
		return options.find((option) => option.value === value)?.label ?? value;
	}

	function ft(ja: string, en: string): string {
		return localeMarker === 'ja' ? ja : en;
	}

	function getSelectedScreen(screenId: string): Screen | null {
		return loadedScreens.find((screen) => screen.id === screenId) ?? null;
	}

	function fieldBlockType(field: Screen['fields'][number]): string {
		return field.block_type ?? 'identity_field';
	}

	function screenHasIdentityField(screen: Screen, fieldNames: string[]): boolean {
		const normalizedNames = new Set(fieldNames.map((fieldName) => fieldName.toLowerCase()));
		return screen.fields.some(
			(field) =>
				fieldBlockType(field) === 'identity_field' &&
				normalizedNames.has((field.field ?? '').toLowerCase())
		);
	}

	function screenHasAuthBlock(screen: Screen): boolean {
		return screen.fields.some((field) => fieldBlockType(field) === 'auth_widget');
	}

	function screenHasMailAuthWidget(screen: Screen): boolean {
		return screen.fields.some(
			(field) => fieldBlockType(field) === 'auth_widget' && field.auth_method === 'mail_otp'
		);
	}

	function screenHasConsentWidget(screen: Screen): boolean {
		return screen.fields.some((field) => fieldBlockType(field) === 'consent_widget');
	}

	function selectedScreenHasConsentWidget(screenId: string): boolean {
		const screen = getSelectedScreen(screenId);
		return screen ? screenHasConsentWidget(screen) : false;
	}

	function draftScreenHasConsentWidget(): boolean {
		return selectedScreenHasConsentWidget(draft.screen);
	}

	function authProfileNeedsEmail(profileId: string): boolean {
		return getAuthProfileOutputs(profileId).some((output) =>
			['mail', 'email'].some((keyword) => output.id.toLowerCase().includes(keyword))
		);
	}

	function getRegistrationScreenValidationMessages(): Array<{
		level: 'ok' | 'warning';
		text: string;
	}> {
		if (!editingNode || editingNode.data.kind !== 'registration') return [];
		const messages: Array<{ level: 'ok' | 'warning'; text: string }> = [];
		const screen = getSelectedScreen(draft.screen);
		if (!screen) {
			messages.push({
				level: 'warning',
				text: ft(
					'選択したスクリーンを読み込めません。保存済みスクリーンを選択してください。',
					'The selected screen could not be loaded. Select a saved screen.'
				)
			});
			return messages;
		}
		if (!screenHasAuthBlock(screen)) {
			messages.push({
				level: 'warning',
				text: ft(
					'選択した登録スクリーンに認証ウィジェットがありません。',
					'Registration screen has no authentication widget.'
				)
			});
		}
		if (
			authProfileNeedsEmail(draft.authProfile) &&
			!screenHasIdentityField(screen, ['email']) &&
			!screenHasMailAuthWidget(screen)
		) {
			messages.push({
				level: 'warning',
				text: ft(
					'メール系の認証経路を使う場合、登録スクリーンにメールアドレス項目が必要になることがあります。',
					'Mail-based routes usually require an email field in the selected registration screen.'
				)
			});
		}
		if (screenHasConsentWidget(screen) && !draft.consentPolicy) {
			messages.push({
				level: 'warning',
				text: ft(
					'選択した登録スクリーンに同意ウィジェットがあります。同じノードで同意ポリシーを選択してください。',
					'The selected registration screen contains a consent widget. Select a consent policy on this node.'
				)
			});
		}
		if (messages.length === 0) {
			messages.push({
				level: 'ok',
				text: ft(
					'認証方式プロフィールと登録スクリーンの基本的な組み合わせは問題なさそうです。',
					'Registration method and screen look compatible.'
				)
			});
		}
		return messages;
	}

	function getAuthProfileOutputs(profileId: string): FlowEditorNodeOutput[] {
		return getAuthProfileOutputsFromOptions(authProfileOptions, profileId);
	}

	function getAuthProfileOutputsFromOptions(
		options: FlowEditorAuthProfileOption[],
		profileId: string
	): FlowEditorNodeOutput[] {
		return options.find((option) => option.value === profileId)?.outputs ?? [];
	}

	function getConfigValue(node: EditorNode, key: string, fallback: string): string {
		const value = node.data[key];
		return typeof value === 'string' ? value : fallback;
	}

	function getConfigConditionType(node: EditorNode): ConditionDraftType {
		const value = node.data.conditionType;
		return isConditionDraftType(value) ? value : 'always';
	}

	function getConfigOtherwiseMode(node: EditorNode): ConditionOtherwiseMode {
		return node.data.conditionOtherwiseMode === 'terminal_error' ? 'terminal_error' : 'output';
	}

	function openNodeConfig(nodeId: string) {
		const node = getEditorNodes().find((candidate) => candidate.id === nodeId);
		if (!node) return;
		const authProfile = normalizeOptionValue(
			getConfigValue(node, 'authProfile', 'default'),
			authProfileOptions,
			'default'
		);
		const consentPolicy = normalizeOptionValue(
			getConfigValue(node, 'consentPolicy', 'registration_consent_policy'),
			consentPolicyOptions,
			''
		);
		const nodeScreenOptions = screenOptionsForNodeKind(node.data.kind);
		const screen = normalizeOptionValue(
			getConfigValue(node, 'screen', firstScreenForNodeKind(node.data.kind, 'basic_profile')),
			nodeScreenOptions,
			firstSelectableValue(nodeScreenOptions) || 'basic_profile'
		);
		const conditionRows = getNodeConditionRows(node);
		const firstConditionRow = conditionRows[0];
		draft = {
			title: node.data.title,
			description: node.data.description,
			settingsText: node.data.settings.join('\n'),
			authProfile,
			screen,
			consentPolicy,
			conditionType: firstConditionRow.type,
			conditionValue: firstConditionRow.value,
			conditionOutputHandle: firstConditionRow.outputHandle,
			conditionOutputLabel: firstConditionRow.label,
			conditionRows: conditionRows.map((row) => ({ ...row })),
			conditionOtherwiseMode: getConfigOtherwiseMode(node),
			conditionOtherwiseOutputHandle: getConfigValue(
				node,
				'conditionOtherwiseOutputHandle',
				'otherwise'
			),
			conditionOtherwiseOutputLabel: getConfigValue(
				node,
				'conditionOtherwiseOutputLabel',
				$LL.admin_flows_output_otherwise()
			),
			conditionTerminalError: getConfigValue(node, 'conditionTerminalError', 'condition_not_met'),
			conditionTerminalMessage: getConfigValue(node, 'conditionTerminalMessage', '')
		};
		editingNodeId = nodeId;
	}

	function closeNodeConfig() {
		editingNodeId = null;
	}

	function addConditionRow() {
		let index = draft.conditionRows.length + 1;
		while (draft.conditionRows.some((row) => row.id === `condition-${index}`)) index += 1;
		draft.conditionRows.push({
			id: `condition-${index}`,
			label: ft(`条件 ${index}`, `Condition ${index}`),
			type: 'always',
			value: '',
			outputHandle: `matched-${index}`
		});
	}

	function removeConditionRow(rowId: string) {
		if (draft.conditionRows.length <= 1) return;
		draft.conditionRows = draft.conditionRows.filter((row) => row.id !== rowId);
	}

	function getDraftSettings(kind: FlowEditorNodeKind): string[] {
		const freeTextSettings = draft.settingsText
			.split('\n')
			.map((item) => item.trim())
			.filter(Boolean);

		if (kind === 'registration') {
			const screenOptions = screenOptionsForNodeKind(kind);
			return [
				getLabel(authProfileOptions, draft.authProfile),
				getLabel(screenOptions, draft.screen),
				...(draftScreenHasConsentWidget() && draft.consentPolicy
					? [getLabel(consentPolicyOptions, draft.consentPolicy)]
					: [])
			];
		}
		if (kind === 'authentication') {
			const screenOptions = screenOptionsForNodeKind(kind);
			return [
				getLabel(authProfileOptions, draft.authProfile),
				getLabel(screenOptions, draft.screen),
				...(draftScreenHasConsentWidget() && draft.consentPolicy
					? [getLabel(consentPolicyOptions, draft.consentPolicy)]
					: [])
			];
		}
		if (kind === 'profile') {
			const screenOptions = screenOptionsForNodeKind(kind);
			return [
				getLabel(screenOptions, draft.screen),
				...(draftScreenHasConsentWidget() && draft.consentPolicy
					? [getLabel(consentPolicyOptions, draft.consentPolicy)]
					: []),
				...freeTextSettings
			];
		}
		if (kind === 'verification') {
			const screenOptions = screenOptionsForNodeKind(kind);
			return [getLabel(screenOptions, draft.screen), ...freeTextSettings];
		}
		if (kind === 'consent') {
			const screenOptions = screenOptionsForNodeKind(kind);
			return [
				getLabel(consentPolicyOptions, draft.consentPolicy),
				...(draft.screen ? [getLabel(screenOptions, draft.screen)] : []),
				...freeTextSettings
			];
		}
		if (kind === 'session') {
			return [
				$LL.admin_flows_setting_existing_session(),
				$LL.admin_flows_setting_prompt_login(),
				$LL.admin_flows_setting_max_age_acr()
			];
		}
		if (kind === 'decision') {
			return [
				...draft.conditionRows.map((row) => {
					const conditionLabel =
						getConditionTypeOptions().find((option) => option.value === row.type)?.label ??
						row.type;
					return `${conditionLabel}${row.value ? `: ${row.value}` : ''}`;
				}),
				...freeTextSettings
			];
		}
		return freeTextSettings;
	}

	function applyNodeConfig() {
		const node = editingNode;
		if (!node) return;
		const firstConditionRow = draft.conditionRows[0];

		const outputs =
			node.data.kind === 'registration' || node.data.kind === 'authentication'
				? getAuthProfileOutputs(draft.authProfile)
				: node.data.kind === 'decision'
					? getConditionOutputsFromDraft(draft)
					: node.data.outputs;
		const updatedNode: EditorNode = {
			...node,
			data: {
				...node.data,
				title: draft.title.trim() || node.data.title,
				description: draft.description.trim(),
				settings: getDraftSettings(node.data.kind),
				outputs,
				authProfile: draft.authProfile,
				screen: draft.screen,
				consentPolicy: draft.consentPolicy,
				conditionType: firstConditionRow?.type ?? 'always',
				conditionValue: firstConditionRow?.value ?? '',
				conditionOutputHandle: normalizeOutputHandle(firstConditionRow?.outputHandle || 'matched'),
				conditionOutputLabel: firstConditionRow?.label || $LL.admin_flows_output_matched(),
				conditionRows: draft.conditionRows.map((row) => ({
					...row,
					outputHandle: normalizeOutputHandle(row.outputHandle || 'matched')
				})),
				conditionOtherwiseMode: draft.conditionOtherwiseMode,
				conditionOtherwiseOutputHandle: normalizeOutputHandle(
					draft.conditionOtherwiseOutputHandle || 'otherwise'
				),
				conditionOtherwiseOutputLabel: draft.conditionOtherwiseOutputLabel,
				conditionTerminalError: draft.conditionTerminalError,
				conditionTerminalMessage: draft.conditionTerminalMessage
			}
		};
		const allowedOutputIds = new Set(outputs.map((output) => output.id));
		editorNodes = withCompletionSubflows(
			withNodeActions(
				getEditorNodes().map((candidate) =>
					candidate.id === updatedNode.id ? updatedNode : candidate
				)
			)
		);
		editorEdges = editorEdges.filter(
			(edge) =>
				edge.source !== updatedNode.id ||
				!edge.sourceHandle ||
				allowedOutputIds.has(edge.sourceHandle)
		);
		closeNodeConfig();
	}

	function deleteEditingNode() {
		const node = editingNode;
		if (!node) return;
		deleteNodesWithMiddleReconnect([node.id]);
		closeNodeConfig();
	}

	function createMiddleReconnectEdges(deletedNodeIds: Set<string>, candidateEdges: EditorEdge[]) {
		const nextEdges: EditorEdge[] = [];

		for (const nodeId of deletedNodeIds) {
			const incomingEdges = candidateEdges.filter(
				(edge) => edge.target === nodeId && !deletedNodeIds.has(edge.source)
			);
			const outgoingEdges = candidateEdges.filter(
				(edge) => edge.source === nodeId && !deletedNodeIds.has(edge.target)
			);

			for (const incoming of incomingEdges) {
				for (const outgoing of outgoingEdges) {
					if (incoming.source === outgoing.target) continue;
					nextEdges.push(
						createEditorEdge(
							incoming.source,
							outgoing.target,
							incoming.sourceHandle ?? 'default',
							outgoing.targetHandle
						)
					);
				}
			}
		}

		return nextEdges;
	}

	function appendUniqueEdges(edges: EditorEdge[], edgesToAppend: EditorEdge[]) {
		const signatures = edges.map(edgeSignature);
		return [
			...edges,
			...edgesToAppend.filter((edge) => {
				const signature = edgeSignature(edge);
				if (signatures.includes(signature)) return false;
				signatures.push(signature);
				return true;
			})
		];
	}

	function deleteNodesWithMiddleReconnect(nodeIds: string[]) {
		const deletedNodeIds = new Set(nodeIds);
		const reconnectEdges = createMiddleReconnectEdges(deletedNodeIds, editorEdges);
		const remainingEdges = editorEdges.filter(
			(edge) => !deletedNodeIds.has(edge.source) && !deletedNodeIds.has(edge.target)
		);
		const remainingNodes = getEditorNodes().filter(
			(candidate) => !deletedNodeIds.has(candidate.id)
		);
		editorNodes = withCompletionSubflows(withNodeActions(remainingNodes));
		editorEdges = filterEdgesForExistingNodes(
			appendUniqueEdges(remainingEdges, reconnectEdges),
			remainingNodes
		);
	}

	function getDeleteTargetNodeIds(nodes: Node[]): Set<string> {
		const deletedNodeIds = new SvelteSet<string>();
		const deletedGroupIds = new SvelteSet<string>();

		for (const node of nodes) {
			if (isEditorNode(node)) {
				deletedNodeIds.add(node.id);
			}
			if (isCompletionGroupNode(node)) {
				deletedGroupIds.add(node.id);
			}
		}

		if (deletedGroupIds.size > 0) {
			for (const node of editorNodes) {
				if (isEditorNode(node) && node.parentId && deletedGroupIds.has(node.parentId)) {
					deletedNodeIds.add(node.id);
				}
			}
		}

		return deletedNodeIds;
	}

	function isFlowEditorNodeKind(value: string): value is FlowEditorNodeKind {
		return nodePalette.some((item) => item.kind === value);
	}

	function screenPointToFlowPosition(clientX: number, clientY: number): { x: number; y: number } {
		const rect = flowCanvasElement?.getBoundingClientRect();
		const viewport = flowCanvasElement?.querySelector('.svelte-flow__viewport');
		if (!rect || !(viewport instanceof HTMLElement)) {
			return { x: DEFAULT_NODE_X, y: COMPACT_NODE_Y_GAP };
		}

		const transform = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
		const zoom = transform.a || 1;

		return {
			x: (clientX - rect.left - transform.e) / zoom,
			y: (clientY - rect.top - transform.f) / zoom
		};
	}

	function canvasDropPosition(event: DragEvent): { x: number; y: number } {
		const position = screenPointToFlowPosition(event.clientX, event.clientY);
		return snapPosition({
			x: Math.max(20, position.x - DEFAULT_NODE_WIDTH / 2),
			y: Math.max(20, position.y - DEFAULT_NODE_HEIGHT / 2)
		});
	}

	function handlePaletteDragStart(event: DragEvent, kind: FlowEditorNodeKind) {
		event.dataTransfer?.setData('application/x-authrim-flow-node-kind', kind);
		event.dataTransfer?.setData('text/plain', kind);
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'copy';
		}
	}

	function handleCanvasDragOver(event: DragEvent) {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'copy';
		}
	}

	function handleCanvasDrop(event: DragEvent) {
		event.preventDefault();
		const rawKind =
			event.dataTransfer?.getData('application/x-authrim-flow-node-kind') ||
			event.dataTransfer?.getData('text/plain') ||
			'';
		if (!isFlowEditorNodeKind(rawKind)) return;
		addNode(rawKind, canvasDropPosition(event));
	}

	function addNode(kind: FlowEditorNodeKind, position?: { x: number; y: number }) {
		if (kind === 'oidc_completion' || kind === 'saml_completion') {
			addCompletionBlock(kind, position);
			return;
		}
		nextNodeIndex += 1;
		const base = nodePalette.find((item) => item.kind === kind);
		const realNodes = getEditorNodes();
		const maxY = realNodes.reduce((value, node) => Math.max(value, node.position.y), 0);
		const id = `${kind}-${nextNodeIndex}`;
		const defaultAuthProfile = firstSelectableValue(authProfileOptions) || 'default';
		const nodeScreenOptions = screenOptionsForNodeKind(kind);
		const defaultScreen =
			kind === 'verification'
				? preferredScreenValue(['code_input'], ['code_input'], 'code_input')
				: firstSelectableValue(nodeScreenOptions) || 'basic_profile';
		const defaultConsentPolicy = firstSelectableValue(consentPolicyOptions);
		const settings =
			kind === 'registration'
				? [
						getLabel(authProfileOptions, defaultAuthProfile),
						getLabel(nodeScreenOptions, defaultScreen)
					]
				: kind === 'authentication'
					? [
							getLabel(authProfileOptions, defaultAuthProfile),
							getLabel(nodeScreenOptions, defaultScreen)
						]
					: kind === 'profile'
						? [getLabel(nodeScreenOptions, defaultScreen)]
						: kind === 'verification'
							? [getLabel(nodeScreenOptions, defaultScreen)]
							: kind === 'consent'
								? [
										getLabel(consentPolicyOptions, defaultConsentPolicy),
										getLabel(nodeScreenOptions, defaultScreen)
									]
								: kind === 'session'
									? [
											$LL.admin_flows_setting_existing_session(),
											$LL.admin_flows_setting_prompt_login(),
											$LL.admin_flows_setting_max_age_acr()
										]
									: kind === 'decision'
										? [$LL.admin_flows_condition_type_always()]
										: [];
		const node = createEditorNode({
			id,
			kind,
			title: base?.label ?? kind,
			description: base?.description ?? '',
			settings,
			position: position ?? { x: DEFAULT_NODE_X, y: maxY + COMPACT_NODE_Y_GAP },
			outputs:
				kind === 'registration' || kind === 'authentication'
					? getAuthProfileOutputs(defaultAuthProfile)
					: kind === 'decision'
						? getDefaultOutputsForRuntimeType('condition')
						: getDefaultOutputsForKind(kind),
			data:
				kind === 'registration'
					? {
							authProfile: defaultAuthProfile,
							screen: defaultScreen
						}
					: kind === 'authentication'
						? {
								authProfile: defaultAuthProfile,
								screen: defaultScreen
							}
						: kind === 'profile'
							? {
									screen: defaultScreen
								}
							: kind === 'verification'
								? {
										screen: defaultScreen
									}
								: kind === 'consent'
									? {
											screen: defaultScreen,
											consentPolicy: defaultConsentPolicy
										}
									: kind === 'session'
										? {
												runtimeType: 'session_check'
											}
										: kind === 'decision'
											? {
													conditionType: 'always',
													conditionValue: '',
													conditionOutputHandle: 'matched',
													conditionOutputLabel: $LL.admin_flows_output_matched(),
													conditionRows: [
														{
															id: 'condition-1',
															label: $LL.admin_flows_output_matched(),
															type: 'always',
															value: '',
															outputHandle: 'matched'
														}
													],
													conditionOtherwiseMode: 'output',
													conditionOtherwiseOutputHandle: 'otherwise',
													conditionOtherwiseOutputLabel: $LL.admin_flows_output_otherwise(),
													conditionTerminalError: 'condition_not_met',
													conditionTerminalMessage: ''
												}
											: {}
		});
		editorNodes = withCompletionSubflows(withNodeActions([...realNodes, node]));
	}

	function addCompletionBlock(
		kind: 'oidc_completion' | 'saml_completion',
		position?: { x: number; y: number }
	) {
		nextNodeIndex += 1;
		const realNodes = getEditorNodes();
		const maxY = realNodes.reduce((value, node) => Math.max(value, node.position.y), 0);
		const basePosition = position ?? { x: DEFAULT_NODE_X, y: maxY + COMPACT_NODE_Y_GAP };
		const protocol = kind === 'saml_completion' ? 'saml' : 'oidc';
		const purpose = kind === 'saml_completion' ? 'attribute_release' : 'authorization';
		const block: FlowEditorCompletionBlock = {
			...createCompletionBlock(protocol, purpose, 'consent'),
			id: `${protocol}-${purpose}-completion-${nextNodeIndex}`
		};
		const consentPolicy = resolveConsentPolicyValue(
			kind === 'saml_completion'
				? 'saml_attribute_release_policy'
				: 'oidc_authorization_consent_policy'
		);
		const consentScreen = preferredScreenValue(['consent'], ['consent'], 'basic_profile');
		const consentNode = createEditorNode({
			id: `${protocol}-${purpose}-consent-${nextNodeIndex}`,
			kind: 'consent',
			title: $LL.admin_flows_node_consent(),
			description:
				kind === 'saml_completion'
					? $LL.admin_flows_node_saml_consent_description()
					: $LL.admin_flows_node_oidc_authorization_consent_description(),
			settings: [
				...(consentPolicy ? [getLabel(consentPolicyOptions, consentPolicy)] : []),
				getLabel(screenOptionsForNodeKind('consent'), consentScreen)
			],
			position: basePosition,
			outputs: [{ id: 'accepted', label: $LL.admin_flows_output_accepted() }],
			data: {
				screen: consentScreen,
				consentPolicy,
				completionBlock: block
			}
		});
		const outputNode = createEditorNode({
			id: `${protocol}-${purpose}-complete-${nextNodeIndex}`,
			kind: 'end',
			title: $LL.admin_flows_palette_end_label(),
			description:
				kind === 'saml_completion'
					? $LL.admin_flows_node_saml_output_description()
					: $LL.admin_flows_node_oidc_authorization_output_description(),
			settings:
				kind === 'saml_completion'
					? [$LL.admin_flows_setting_saml_assertion()]
					: [
							$LL.admin_flows_setting_authorization_code(),
							$LL.admin_flows_setting_id_token_claims(),
							$LL.admin_flows_setting_userinfo_claims()
						],
			position: { x: basePosition.x, y: basePosition.y + COMPACT_NODE_Y_GAP },
			outputs: [],
			data: {
				completionBlock: {
					...block,
					role: 'output'
				}
			}
		});
		editorNodes = withCompletionSubflows(withNodeActions([...realNodes, consentNode, outputNode]));
		editorEdges = [...editorEdges, createEditorEdge(consentNode.id, outputNode.id, 'accepted')];
	}

	function handleConnect(connection: Connection) {
		if (!connection.source || !connection.target) return;
		if (connection.source === connection.target) return;
		const validation = validateEditorConnection(connection);
		if (!validation.valid) {
			invalidConnectionMessage = validation.message;
			return;
		}
		invalidConnectionMessage = '';
		const sourceHandle = connection.sourceHandle ?? 'default';
		const targetHandle = connection.targetHandle ?? undefined;
		const edgeExists = editorEdges.some(
			(edge) =>
				edge.source === connection.source &&
				edge.target === connection.target &&
				(edge.sourceHandle ?? 'default') === sourceHandle &&
				(edge.targetHandle ?? 'default') === (targetHandle ?? 'default')
		);
		if (edgeExists) return;

		editorEdges = [
			...editorEdges,
			createEditorEdge(connection.source, connection.target, sourceHandle, targetHandle)
		];
	}

	function validateEditorConnection(connection: Connection | Edge): {
		valid: boolean;
		message: string;
	} {
		if (!connection.source || !connection.target) {
			return { valid: false, message: $LL.admin_flows_invalid_connection_missing_node() };
		}
		const realNodes = getEditorNodes();
		const source = realNodes.find((node) => node.id === connection.source);
		const target = realNodes.find((node) => node.id === connection.target);
		if (!source || !target) {
			return { valid: false, message: $LL.admin_flows_invalid_connection_missing_node() };
		}
		if (source.data.kind === 'end') {
			return { valid: false, message: $LL.admin_flows_invalid_connection_from_complete() };
		}
		if (target.data.kind === 'start') {
			return { valid: false, message: $LL.admin_flows_invalid_connection_to_entry() };
		}
		const sourceBlock = source.data.completionBlock;
		const targetBlock = target.data.completionBlock;
		if (
			sourceBlock?.id &&
			targetBlock?.id &&
			sourceBlock.id !== targetBlock.id &&
			sourceBlock.protocol &&
			targetBlock.protocol &&
			sourceBlock.protocol !== targetBlock.protocol
		) {
			return {
				valid: false,
				message: $LL.admin_flows_invalid_connection_protocol_mismatch()
			};
		}
		if (
			sourceBlock?.id &&
			targetBlock?.id &&
			sourceBlock.id !== targetBlock.id &&
			sourceBlock.purpose &&
			targetBlock.purpose &&
			sourceBlock.purpose !== targetBlock.purpose
		) {
			return {
				valid: false,
				message: $LL.admin_flows_invalid_connection_completion_block_mismatch()
			};
		}
		return { valid: true, message: '' };
	}

	function handleDelete({ nodes, edges }: { nodes: Node[]; edges: EditorEdge[] }) {
		const deletedNodeIds = getDeleteTargetNodeIds(nodes);
		if (!deletedNodeIds.size) return;
		const reconnectEdges = createMiddleReconnectEdges(deletedNodeIds, edges);
		const remainingNodes = getEditorNodes().filter((node) => !deletedNodeIds.has(node.id));
		editorEdges = filterEdgesForExistingNodes(
			appendUniqueEdges(editorEdges, reconnectEdges),
			remainingNodes
		);
	}

	function resetGraph() {
		const graph = savedFlow?.editor
			? buildGraphFromEditorState(savedFlow.editor)
			: flow
				? buildInitialGraph(flow)
				: null;
		if (!graph) return;
		editorNodes = withCompletionSubflows(withNodeActions(graph.nodes));
		editorEdges = graph.edges;
		nextNodeIndex = graph.nodes.length;
		closeNodeConfig();
	}

	function createNodeConfig(node: EditorNode): Record<string, unknown> {
		const config: Record<string, unknown> = {
			ui_kind: node.data.kind,
			description: node.data.description,
			settings: node.data.settings,
			outputs: node.data.outputs
		};
		if (node.data.kind === 'registration' || node.data.kind === 'authentication') {
			config.authentication_profile_ref = getConfigValue(node, 'authProfile', 'default');
		}
		if (
			node.data.kind === 'registration' ||
			node.data.kind === 'authentication' ||
			node.data.kind === 'verification' ||
			node.data.kind === 'profile' ||
			node.data.kind === 'consent'
		) {
			config.screen_ref = getConfigValue(node, 'screen', 'basic_profile');
		}
		if (
			node.data.kind === 'consent' ||
			((node.data.kind === 'registration' ||
				node.data.kind === 'authentication' ||
				node.data.kind === 'profile') &&
				selectedScreenHasConsentWidget(getConfigValue(node, 'screen', 'basic_profile')))
		) {
			config.consent_policy_ref = getConfigValue(
				node,
				'consentPolicy',
				node.data.kind === 'consent' ? 'registration_consent_policy' : ''
			);
		}
		if (node.data.kind === 'decision') {
			config.conditions = buildConditionConfig(nodeConditionDraft(node));
		}
		if (node.data.completionBlock) {
			config.completion_block = node.data.completionBlock;
		}
		return config;
	}

	function serializeEditorState(): FlowEditorState {
		const realNodes = getEditorNodes();
		const nodeById = new Map(realNodes.map((node) => [node.id, node]));
		const realEdges = filterEdgesForExistingNodes(editorEdges, realNodes);
		return {
			nodes: realNodes.map((node) => ({
				id: node.id,
				type: getRuntimeTypeForNode(node),
				title: node.data.title,
				position: snapPosition(node.position),
				config: createNodeConfig(node)
			})),
			edges: realEdges.map((edge) => {
				const sourceNode = nodeById.get(edge.source);
				const sourceHandle = normalizeSourceHandleForNode(sourceNode, edge.sourceHandle);
				return {
					id: edge.id,
					source: edge.source,
					target: edge.target,
					source_handle: sourceHandle,
					target_handle: edge.targetHandle ?? undefined
				};
			}),
			viewport: { x: 36, y: 36, zoom: 1 }
		};
	}

	async function saveFlow() {
		if (!savedFlow) return;
		const slug = flowSlug.trim();
		const displayName = flowDisplayName.trim();
		if (!slug || !displayName) {
			saveStatus = $LL.admin_flows_metadata_required();
			return;
		}
		saving = true;
		saveStatus = '';
		try {
			const editor = serializeEditorState();
			const response = await adminFlowsAPI.update(savedFlow.id, {
				slug,
				display_name: displayName,
				description: flowDescription.trim() || null,
				editor
			});
			savedFlow = response.flow;
			syncFlowMetadata(response.flow);
			saveStatus = '';
			toast.success($LL.admin_flows_saved());
		} catch (error) {
			saveStatus = error instanceof Error ? error.message : $LL.admin_flows_save_failed();
			toast.error(saveStatus);
		} finally {
			saving = false;
		}
	}

	function openDeleteFlowModal() {
		if (!savedFlow) return;
		deleteFlowModalOpen = true;
		saveStatus = '';
	}

	function closeDeleteFlowModal() {
		if (deletingFlow) return;
		deleteFlowModalOpen = false;
	}

	async function deleteCurrentFlow() {
		if (!savedFlow) return;
		deletingFlow = true;
		saveStatus = '';
		try {
			await adminFlowsAPI.delete(savedFlow.id);
			await goto('/admin/flows');
		} catch (error) {
			saveStatus = error instanceof Error ? error.message : $LL.admin_flows_delete_failed();
			toast.error(saveStatus);
			deleteFlowModalOpen = false;
		} finally {
			deletingFlow = false;
		}
	}

	async function validateFlow() {
		if (!savedFlow) return;
		validating = true;
		validationRan = true;
		try {
			const editor = serializeEditorState();
			const result = await adminFlowsAPI.validate(savedFlow.id, { editor });
			validationIssues = result.issues;
		} catch (error) {
			validationIssues = [
				{
					level: 'error',
					code: 'validation_request_failed',
					message: error instanceof Error ? error.message : $LL.admin_flows_validation_failed()
				}
			];
		} finally {
			validating = false;
		}
	}
</script>

<svelte:head>
	<title
		>{pageTitle
			? $LL.admin_flows_editor_page_title({ title: pageTitle })
			: $LL.admin_flows_editor_fallback_page_title()}</title
	>
</svelte:head>

<AdminPageShell>
	{#if flowLoading}
		<AdminPageHeader title={$LL.admin_flows_title()} description={$LL.admin_flows_loading()}>
			{#snippet actions()}
				<a href="/admin/flows" class="btn btn-secondary">
					<i class="i-ph-arrow-left" aria-hidden="true"></i>
					{$LL.admin_flows_back_to_list()}
				</a>
			{/snippet}
		</AdminPageHeader>
	{:else if !savedFlow && !flow}
		<AdminPageHeader
			title={$LL.admin_flows_not_found_title()}
			description={flowLoadError || $LL.admin_flows_not_found_description()}
		>
			{#snippet actions()}
				<a href="/admin/flows" class="btn btn-secondary">
					<i class="i-ph-arrow-left" aria-hidden="true"></i>
					{$LL.admin_flows_back_to_list()}
				</a>
			{/snippet}
		</AdminPageHeader>
	{:else}
		<AdminPageHeader
			title={$LL.admin_flows_editor_header_title({ title: pageTitle })}
			description={pageDescription}
			eyebrow={pageEyebrow}
		>
			{#snippet actions()}
				<a href={`/admin/flows/${savedFlow?.id ?? flow?.id}`} class="btn btn-secondary">
					<i class="i-ph-arrow-left" aria-hidden="true"></i>
					{$LL.admin_flows_back_to_detail()}
				</a>
				<button type="button" class="btn btn-secondary" onclick={resetGraph}>
					{$LL.admin_flows_reset_template()}
				</button>
				{#if savedFlow}
					<button type="button" class="btn btn-danger" onclick={openDeleteFlowModal}>
						<i class="i-ph-trash" aria-hidden="true"></i>
						{$LL.admin_flows_delete_flow()}
					</button>
					<button
						type="button"
						class="btn btn-secondary"
						onclick={validateFlow}
						disabled={validating}
					>
						{validating ? $LL.admin_flows_loading() : $LL.admin_flows_validation_title()}
					</button>
					<button type="button" class="btn btn-primary" onclick={saveFlow} disabled={saving}>
						{saving ? $LL.admin_flows_saving() : $LL.admin_flows_save()}
					</button>
				{/if}
			{/snippet}
		</AdminPageHeader>

		<AdminSection
			title={$LL.admin_flows_editor_section_title()}
			description={$LL.admin_flows_editor_section_description()}
		>
			{#if flowSettingsError}
				<div class="settings-warning" role="status">
					{$LL.admin_flows_runtime_options_error()}
					{flowSettingsError}
				</div>
			{/if}
			{#if invalidConnectionMessage}
				<div class="settings-warning" role="status">{invalidConnectionMessage}</div>
			{/if}
			{#if saveStatus}
				<div class="settings-warning" role="status">{saveStatus}</div>
			{/if}
			{#if savedFlow}
				<div class="flow-metadata">
					<label class="field">
						<span>{$LL.admin_flows_display_name_label()}</span>
						<input class="admin-input" bind:value={flowDisplayName} />
					</label>
					<label class="field">
						<span>{$LL.admin_flows_detail_slug()}</span>
						<input
							class="admin-input"
							bind:value={flowSlug}
							placeholder={$LL.admin_flows_slug_placeholder()}
							spellcheck="false"
						/>
					</label>
					<label class="field field-wide">
						<span>{$LL.admin_flows_node_description_label()}</span>
						<textarea class="admin-input" rows="2" bind:value={flowDescription}></textarea>
					</label>
				</div>
			{/if}
			{#if validationRan}
				<div class="validation-panel" data-valid={validationIssues.length === 0}>
					<strong>
						{validationIssues.length === 0
							? $LL.admin_flows_validation_valid()
							: $LL.admin_flows_validation_failed()}
					</strong>
					{#if validationIssues.length > 0}
						<ul>
							{#each validationIssues as issue, index (`${issue.code}-${issue.path ?? ''}-${index}`)}
								<li data-level={issue.level}>
									<code>{issue.code}</code>
									<span>{issue.message}</span>
									{#if issue.node_id || issue.edge_id || issue.path}
										<small>{issue.node_id || issue.edge_id || issue.path}</small>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
			<div class="editor-layout">
				<aside class="node-palette" aria-label={$LL.admin_flows_node_palette_aria()}>
					<div class="palette-heading">
						<strong>{$LL.admin_flows_node_palette_title()}</strong>
						<span
							>{$LL.admin_flows_node_palette_count({
								nodes: getEditorNodes().length,
								edges: editorEdges.length
							})}</span
						>
					</div>
					<div class="palette-list">
						{#each nodePalette as item (item.kind)}
							<button
								type="button"
								class="palette-item"
								draggable="true"
								ondragstart={(event) => handlePaletteDragStart(event, item.kind)}
								onclick={() => addNode(item.kind)}
							>
								<strong>{item.label}</strong>
								<span>{item.description}</span>
							</button>
						{/each}
					</div>
				</aside>

				<div
					class="flow-canvas"
					style={`--flow-canvas-height: ${flowCanvasHeight};`}
					role="application"
					aria-label={$LL.admin_flows_canvas_aria({ title: pageTitle })}
					bind:this={flowCanvasElement}
					ondragover={handleCanvasDragOver}
					ondrop={handleCanvasDrop}
				>
					{#key flowRenderKey}
						<SvelteFlow
							bind:nodes={editorNodes}
							bind:edges={editorEdges}
							{nodeTypes}
							{edgeTypes}
							onconnect={handleConnect}
							ondelete={handleDelete}
							isValidConnection={(connection) => validateEditorConnection(connection).valid}
							connectionMode={ConnectionMode.Strict}
							connectionLineType={ConnectionLineType.Bezier}
							clickConnect
							initialViewport={{ x: 36, y: 36, zoom: 1 }}
							minZoom={1}
							maxZoom={1}
							nodesDraggable
							nodesConnectable
							elementsSelectable
							snapGrid={FLOW_SNAP_GRID}
							zoomOnScroll={false}
							zoomOnDoubleClick={false}
							zoomOnPinch={false}
							panOnScroll={false}
							panOnDrag
							preventScrolling={false}
							autoPanOnNodeFocus={false}
							autoPanOnNodeDrag
							autoPanOnConnect
							colorMode={themeStore.mode}
							proOptions={{ hideAttribution: true }}
						>
							<Background variant={BackgroundVariant.Dots} gap={18} size={1} />
						</SvelteFlow>
					{/key}
				</div>
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

<Modal
	open={deleteFlowModalOpen}
	onClose={closeDeleteFlowModal}
	title={$LL.admin_flows_delete_flow_confirm_title()}
>
	<p class="confirm-text">
		{$LL.admin_flows_delete_flow_confirm_description({
			title: flowDisplayName || savedFlow?.slug || ''
		})}
	</p>

	{#snippet footer()}
		<button
			type="button"
			class="btn btn-secondary"
			onclick={closeDeleteFlowModal}
			disabled={deletingFlow}
		>
			{$LL.admin_flows_cancel()}
		</button>
		<button
			type="button"
			class="btn btn-danger"
			onclick={deleteCurrentFlow}
			disabled={deletingFlow}
		>
			{deletingFlow ? $LL.admin_flows_deleting() : $LL.admin_flows_delete_flow()}
		</button>
	{/snippet}
</Modal>

<Modal
	open={!!editingNode}
	onClose={closeNodeConfig}
	title={$LL.admin_flows_node_modal_title()}
	size="lg"
>
	{#if editingNode}
		<div class="config-grid">
			<label class="field">
				<span>{$LL.admin_flows_node_title_label()}</span>
				<input class="admin-input" bind:value={draft.title} />
			</label>

			<label class="field field-wide">
				<span>{$LL.admin_flows_node_description_label()}</span>
				<textarea class="admin-input" rows="3" bind:value={draft.description}></textarea>
			</label>

			{#if editingNode.data.kind === 'registration' || editingNode.data.kind === 'authentication'}
				<label class="field field-wide">
					<span>{$LL.admin_flows_auth_profile_label()}</span>
					<select class="admin-input" bind:value={draft.authProfile}>
						{#each authProfileOptions as option (option.value)}
							<option value={option.value} disabled={option.disabled}>{option.label}</option>
						{/each}
					</select>
				</label>
				<label class="field field-wide">
					<span>{$LL.admin_flows_screen_label()}</span>
					<select class="admin-input" bind:value={draft.screen}>
						{#each screenOptionsForNodeKind(editingNode.data.kind) as option (option.value)}
							<option value={option.value} disabled={option.disabled}>{option.label}</option>
						{/each}
					</select>
				</label>
				{#if draftScreenHasConsentWidget()}
					<label class="field field-wide">
						<span>{$LL.admin_flows_consent_policy_label()}</span>
						<select class="admin-input" bind:value={draft.consentPolicy}>
							{#each consentPolicyOptions as option (option.value)}
								<option value={option.value} disabled={option.disabled}>{option.label}</option>
							{/each}
						</select>
					</label>
				{/if}
				{#if editingNode.data.kind === 'registration'}
					<div class="registration-screen-check field-wide">
						<strong>{ft('組み合わせチェック', 'Compatibility check')}</strong>
						<ul>
							{#each getRegistrationScreenValidationMessages() as item (item.text)}
								<li data-level={item.level}>{item.text}</li>
							{/each}
						</ul>
					</div>
				{/if}
			{:else if editingNode.data.kind === 'profile' || editingNode.data.kind === 'verification'}
				<label class="field field-wide">
					<span>{$LL.admin_flows_screen_label()}</span>
					<select class="admin-input" bind:value={draft.screen}>
						{#each screenOptionsForNodeKind(editingNode.data.kind) as option (option.value)}
							<option value={option.value} disabled={option.disabled}>{option.label}</option>
						{/each}
					</select>
				</label>
				{#if draftScreenHasConsentWidget()}
					<label class="field field-wide">
						<span>{$LL.admin_flows_consent_policy_label()}</span>
						<select class="admin-input" bind:value={draft.consentPolicy}>
							{#each consentPolicyOptions as option (option.value)}
								<option value={option.value} disabled={option.disabled}>{option.label}</option>
							{/each}
						</select>
					</label>
				{/if}
			{:else if editingNode.data.kind === 'consent'}
				<label class="field field-wide">
					<span>{$LL.admin_flows_screen_label()}</span>
					<select class="admin-input" bind:value={draft.screen}>
						{#each screenOptionsForNodeKind(editingNode.data.kind) as option (option.value)}
							<option value={option.value} disabled={option.disabled}>{option.label}</option>
						{/each}
					</select>
				</label>
				<label class="field field-wide">
					<span>{$LL.admin_flows_consent_policy_label()}</span>
					<select class="admin-input" bind:value={draft.consentPolicy}>
						{#each consentPolicyOptions as option (option.value)}
							<option value={option.value} disabled={option.disabled}>{option.label}</option>
						{/each}
					</select>
				</label>
			{:else if editingNode.data.kind === 'decision'}
				<div class="condition-editor field-wide">
					<div class="condition-editor__header">
						<strong>{ft('条件分岐', 'Condition branches')}</strong>
						<button type="button" class="btn btn-secondary btn-compact" onclick={addConditionRow}>
							<i class="i-ph-plus" aria-hidden="true"></i>
							{ft('条件を追加', 'Add condition')}
						</button>
					</div>
					{#each draft.conditionRows as row, index (row.id)}
						<div class="condition-row">
							<div class="condition-row__header">
								<strong>{ft(`条件 ${index + 1}`, `Condition ${index + 1}`)}</strong>
								<button
									type="button"
									class="btn btn-secondary btn-icon"
									onclick={() => removeConditionRow(row.id)}
									disabled={draft.conditionRows.length <= 1}
									aria-label={ft(`条件 ${index + 1} を削除`, `Remove condition ${index + 1}`)}
								>
									<i class="i-ph-trash" aria-hidden="true"></i>
								</button>
							</div>
							<div class="condition-row__fields">
								<label class="field">
									<span>{$LL.admin_flows_condition_type_label()}</span>
									<select class="admin-input" bind:value={row.type}>
										{#each getConditionTypeOptions() as option (option.value)}
											<option value={option.value}>{option.label}</option>
										{/each}
									</select>
								</label>
								<label class="field">
									<span>{$LL.admin_flows_condition_value_label()}</span>
									{#if row.type === 'protocol'}
										<select class="admin-input" bind:value={row.value}>
											<option value="saml">SAML</option>
											<option value="oidc">OIDC</option>
										</select>
									{:else}
										<input
											class="admin-input"
											placeholder={$LL.admin_flows_condition_value_placeholder()}
											disabled={row.type === 'always'}
											bind:value={row.value}
										/>
									{/if}
								</label>
								<label class="field">
									<span>{$LL.admin_flows_condition_match_output_label()}</span>
									<input class="admin-input" bind:value={row.outputHandle} />
								</label>
								<label class="field">
									<span>{$LL.admin_flows_condition_match_label_label()}</span>
									<input class="admin-input" bind:value={row.label} />
								</label>
							</div>
						</div>
					{/each}
				</div>

				<label class="field">
					<span>{$LL.admin_flows_condition_otherwise_mode_label()}</span>
					<select class="admin-input" bind:value={draft.conditionOtherwiseMode}>
						<option value="output">{$LL.admin_flows_condition_otherwise_output_mode()}</option>
						<option value="terminal_error">
							{$LL.admin_flows_condition_otherwise_terminal_mode()}
						</option>
					</select>
				</label>

				{#if draft.conditionOtherwiseMode === 'output'}
					<label class="field">
						<span>{$LL.admin_flows_condition_otherwise_output_label()}</span>
						<input class="admin-input" bind:value={draft.conditionOtherwiseOutputHandle} />
					</label>

					<label class="field">
						<span>{$LL.admin_flows_condition_otherwise_label_label()}</span>
						<input class="admin-input" bind:value={draft.conditionOtherwiseOutputLabel} />
					</label>
				{:else}
					<label class="field">
						<span>{$LL.admin_flows_condition_terminal_error_label()}</span>
						<input class="admin-input" bind:value={draft.conditionTerminalError} />
					</label>

					<label class="field field-wide">
						<span>{$LL.admin_flows_condition_terminal_message_label()}</span>
						<textarea class="admin-input" rows="2" bind:value={draft.conditionTerminalMessage}
						></textarea>
					</label>
				{/if}
			{/if}

			{#if editingNode.data.kind === 'registration' || editingNode.data.kind === 'authentication'}
				<div class="output-preview field-wide">
					<span>{$LL.admin_flows_output_handles_label()}</span>
					<div>
						{#if getAuthProfileOutputs(draft.authProfile).length > 0}
							{#each getAuthProfileOutputs(draft.authProfile) as output (output.id)}
								<code>{output.label}</code>
							{/each}
						{:else}
							<span class="empty-hint">{$LL.admin_flows_output_handles_empty()}</span>
						{/if}
					</div>
				</div>
			{:else if editingNode.data.kind === 'session'}
				<div class="output-preview field-wide">
					<span>{$LL.admin_flows_output_handles_label()}</span>
					<div>
						{#each getDefaultOutputsForRuntimeType('session_check') as output (output.id)}
							<code>{output.id}: {output.label}</code>
						{/each}
					</div>
				</div>
			{:else if editingNode.data.kind === 'decision'}
				<div class="output-preview field-wide">
					<span>{$LL.admin_flows_output_handles_label()}</span>
					<div>
						{#each getConditionOutputsFromDraft(draft) as output (output.id)}
							<code>{output.id}: {output.label}</code>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<button type="button" class="btn btn-danger" onclick={deleteEditingNode}>
			{$LL.admin_flows_delete()}
		</button>
		<span class="modal-spacer"></span>
		<button type="button" class="btn btn-secondary" onclick={closeNodeConfig}>
			{$LL.admin_flows_cancel()}
		</button>
		<button type="button" class="btn btn-primary" onclick={applyNodeConfig}>
			{$LL.admin_flows_apply()}
		</button>
	{/snippet}
</Modal>

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
		cursor: pointer;
	}

	.btn:hover {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	.btn-primary {
		border-color: var(--button-primary-bg, var(--color-accent));
		background: var(--button-primary-bg, var(--color-accent));
		color: var(--button-primary-color, var(--color-accent-contrast));
	}

	.btn-primary:hover {
		color: var(--button-primary-color, var(--color-accent-contrast));
	}

	.btn-danger {
		border-color: var(--color-danger);
		background: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface));
		color: var(--color-danger);
	}

	.flow-metadata {
		display: grid;
		grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr);
		gap: 12px;
		margin-bottom: 14px;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-surface-muted) 48%, transparent);
	}

	.editor-layout {
		display: grid;
		grid-template-columns: minmax(220px, 260px) minmax(0, 1fr);
		gap: 16px;
		align-items: stretch;
	}

	.settings-warning {
		margin-bottom: 12px;
		padding: 10px 12px;
		border: 1px solid color-mix(in srgb, var(--color-warning, #c58a00) 42%, var(--color-border));
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-warning, #c58a00) 10%, var(--color-surface));
		color: var(--color-text);
		font-size: 0.82rem;
		line-height: 1.45;
	}

	.validation-panel {
		display: grid;
		gap: 10px;
		margin-bottom: 12px;
		padding: 12px;
		border: 1px solid color-mix(in srgb, var(--color-danger) 45%, var(--color-border));
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-danger) 9%, var(--color-surface));
		color: var(--color-text);
		font-size: 0.84rem;
	}

	.validation-panel[data-valid='true'] {
		border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 9%, var(--color-surface));
	}

	.validation-panel strong {
		color: var(--color-text);
	}

	.validation-panel ul {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.validation-panel li {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 4px 8px;
		align-items: start;
		padding: 8px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-surface);
	}

	.validation-panel li[data-level='warning'] {
		border-color: color-mix(in srgb, var(--color-warning) 44%, var(--color-border));
	}

	.validation-panel code {
		color: var(--color-text-muted);
		font-size: 0.74rem;
	}

	.validation-panel small {
		grid-column: 1 / -1;
		color: var(--color-text-muted);
		font-size: 0.72rem;
	}

	.node-palette {
		min-height: 720px;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
	}

	.palette-heading {
		display: grid;
		gap: 4px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--color-border);
	}

	.palette-heading strong {
		color: var(--color-text);
		font-family: var(--font-display);
		font-size: 0.95rem;
	}

	.palette-heading span {
		color: var(--color-text-muted);
		font-size: 0.78rem;
	}

	.palette-list {
		display: grid;
		gap: 8px;
		margin-top: 12px;
	}

	.palette-item {
		display: grid;
		gap: 5px;
		width: 100%;
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: transparent;
		color: var(--color-text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.palette-item:hover {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 7%, transparent);
	}

	.palette-item strong {
		font-size: 0.86rem;
		font-weight: 900;
	}

	.palette-item span {
		color: var(--color-text-muted);
		font-size: 0.76rem;
		line-height: 1.45;
	}

	.flow-canvas {
		--flow-canvas-bg: color-mix(in srgb, var(--color-surface-muted) 62%, var(--color-surface));
		--flow-dot-color: color-mix(in srgb, var(--color-text-muted) 34%, transparent);
		--flow-node-bg: color-mix(in srgb, var(--color-surface) 96%, var(--color-text) 4%);
		position: relative;
		width: 100%;
		height: var(--flow-canvas-height, 720px);
		min-height: 720px;
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--flow-canvas-bg);
		box-shadow: var(--card-shadow, none);
	}

	:global([data-theme='dark']) .flow-canvas {
		--flow-canvas-bg: color-mix(
			in srgb,
			var(--color-page-bg, var(--bg-page)) 58%,
			var(--color-surface) 42%
		);
		--flow-dot-color: color-mix(in srgb, var(--color-text-muted) 42%, transparent);
		--flow-node-bg: color-mix(in srgb, var(--color-surface) 94%, var(--color-text) 6%);
	}

	.flow-canvas :global(.svelte-flow) {
		--xy-background-color-default: var(--flow-canvas-bg);
		--xy-background-pattern-dots-color-default: var(--flow-dot-color);
		background: var(--flow-canvas-bg);
		color: var(--color-text);
	}

	.flow-canvas :global(.svelte-flow__background) {
		background-color: var(--flow-canvas-bg);
	}

	.flow-canvas :global(.svelte-flow__background-pattern) {
		color: var(--flow-dot-color);
	}

	.flow-canvas :global(.svelte-flow__pane) {
		cursor: grab;
	}

	.flow-canvas :global(.svelte-flow__pane:active) {
		cursor: grabbing;
	}

	.flow-canvas :global(.svelte-flow__node) {
		overflow: visible;
	}

	.flow-canvas :global(.svelte-flow__node:has(.flow-editor-node__settings:hover)),
	.flow-canvas :global(.svelte-flow__node:has(.flow-editor-node__settings:focus-visible)) {
		z-index: 40 !important;
	}

	.flow-canvas :global(.svelte-flow__edge-path) {
		stroke: var(--color-border-strong, var(--color-border));
		stroke-width: 2;
	}

	.flow-canvas :global(.svelte-flow__edge.selected .svelte-flow__edge-path) {
		stroke: var(--color-accent);
	}

	.flow-canvas :global(.svelte-flow__connection-path) {
		stroke: var(--color-accent);
		stroke-width: 2;
	}

	.config-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
	}

	.field {
		display: grid;
		gap: 7px;
		color: var(--color-text);
		font-size: 0.84rem;
		font-weight: 800;
	}

	.field-wide {
		grid-column: 1 / -1;
	}

	.condition-editor {
		display: grid;
		gap: 10px;
	}

	.condition-editor__header,
	.condition-row__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.condition-editor__header strong,
	.condition-row__header strong {
		color: var(--color-text);
		font-size: 0.84rem;
	}

	.condition-row {
		display: grid;
		gap: 12px;
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: color-mix(in srgb, var(--color-surface-muted) 52%, transparent);
	}

	.condition-row__fields {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	.btn-compact {
		min-height: 32px;
		padding-inline: 10px;
		font-size: 0.78rem;
	}

	.btn-icon {
		width: 32px;
		min-height: 32px;
		padding: 0;
	}

	.admin-input {
		width: 100%;
		min-height: 38px;
		padding: 9px 11px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		font-weight: 500;
	}

	textarea.admin-input {
		resize: vertical;
		line-height: 1.5;
	}

	.registration-screen-check {
		display: grid;
		gap: 8px;
		padding: 10px 12px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-surface-muted) 52%, transparent);
	}

	.registration-screen-check strong {
		color: var(--color-text);
		font-size: 0.84rem;
	}

	.registration-screen-check ul {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.registration-screen-check li {
		color: var(--color-text-muted);
		font-size: 0.8rem;
		line-height: 1.45;
	}

	.registration-screen-check li[data-level='warning'] {
		color: var(--color-warning, #c58a00);
	}

	.output-preview {
		display: grid;
		gap: 8px;
	}

	.output-preview > span {
		color: var(--color-text);
		font-size: 0.84rem;
		font-weight: 800;
	}

	.output-preview div {
		display: flex;
		flex-wrap: wrap;
		gap: 7px;
	}

	.output-preview code {
		padding: 5px 8px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		background: var(--color-surface);
		color: var(--color-text-muted);
		font-size: 0.76rem;
	}

	.empty-hint {
		color: var(--color-text-muted);
		font-size: 0.78rem;
		font-weight: 600;
	}

	.modal-spacer {
		flex: 1;
	}

	.confirm-text {
		margin: 0;
		color: var(--color-text);
		line-height: 1.6;
	}

	@media (max-width: 980px) {
		.editor-layout,
		.config-grid,
		.condition-row__fields,
		.flow-metadata {
			grid-template-columns: 1fr;
		}

		.node-palette,
		.flow-canvas {
			min-height: 520px;
		}
	}
</style>
