<script lang="ts">
	import { beforeNavigate } from '$app/navigation';
	import { onDestroy, onMount, tick } from 'svelte';
	import { LL, getLocale } from '$i18n/i18n-svelte';
	import {
		adminIdentityMappingAPI,
		type PersistentIdentifierProfileSummary
	} from '$lib/api/admin-identity-mapping';
	import { suggestAutoMapConnections } from './auto-map-candidates';
	import {
		type MappingAdapter,
		type MappingDraftPayload,
		type MappingDraftRuleInput,
		type MappingEdge,
		type MappingNode,
		type MappingSample,
		type RuleDetail,
		type TransformOperation
	} from './types';

	type ViewMode = 'overview' | 'source' | 'destination';
	type SelectorOption = {
		id: string;
		title: string;
		adapter?: MappingAdapter;
		direction?: 'source' | 'destination' | 'both';
		sourceProfileIds?: string[];
		destinationProfileIds?: string[];
		rules?: PolicySelectorRule[];
	};
	type PolicySelectorRule = {
		id: string;
		ruleKey: string;
		ruleKind: string;
		action: string;
		priority: number;
		metadata?: Record<string, unknown>;
		edges: PolicySelectorEdge[];
		transforms: PolicySelectorTransform[];
	};
	type PolicySelectorEdge = {
		id: string;
		sourceRef: Record<string, unknown>;
		targetRef: Record<string, unknown>;
		edgeKind: string;
		displayOrder: number;
	};
	type PolicySelectorTransform = {
		id: string;
		edgeId?: string | null;
		stepOrder: number;
		operation: string;
		parameters: Record<string, unknown>;
	};
	type TransformParameterSchema =
		| {
				name: string;
				label: string;
				kind: 'enum';
				required: true;
				options: Array<{ value: string; label: string }>;
		  }
		| {
				name: string;
				label: string;
				kind: 'string';
				required: boolean;
				placeholder: string;
		  }
		| {
				name: string;
				label: string;
				kind: 'boolean';
				required: boolean;
		  };
	type TransformOperationSchema = {
		operation: TransformOperation;
		label: string;
		description: string;
		parameters: TransformParameterSchema[];
	};
	type TransformOperationCategoryId = 'basic' | 'array' | 'text' | 'identifier' | 'json';
	type TransformOperationCategory = {
		id: TransformOperationCategoryId;
		operations: TransformOperation[];
	};
	type TransformParameterValue = string | boolean;
	type DryRunValue = {
		ok: boolean;
		value: string;
		input?: string;
		trace?: string;
	};

	const transformOperationSchemas: TransformOperationSchema[] = [
		{
			operation: 'copy',
			label: 'Copy',
			description: 'Pass the first input value through unchanged.',
			parameters: []
		},
		{
			operation: 'as_array',
			label: 'As array',
			description: 'Wrap one input value as a multi-value array.',
			parameters: [
				{ name: 'trimItems', label: 'Trim items', kind: 'boolean', required: false },
				{ name: 'omitEmpty', label: 'Omit empty values', kind: 'boolean', required: false },
				{ name: 'unique', label: 'Remove duplicates', kind: 'boolean', required: false }
			]
		},
		{
			operation: 'split',
			label: 'Split',
			description: 'Split one text value into a multi-value array.',
			parameters: [
				{
					name: 'delimiter',
					label: 'Delimiter',
					kind: 'string',
					required: false,
					placeholder: 'comma, space, or custom text'
				},
				{ name: 'trimItems', label: 'Trim items', kind: 'boolean', required: false },
				{ name: 'omitEmpty', label: 'Omit empty values', kind: 'boolean', required: false },
				{ name: 'unique', label: 'Remove duplicates', kind: 'boolean', required: false }
			]
		},
		{
			operation: 'join',
			label: 'Join',
			description: 'Join a multi-value array into one text value.',
			parameters: [
				{
					name: 'delimiter',
					label: 'Delimiter',
					kind: 'string',
					required: false,
					placeholder: 'comma, space, or custom text'
				},
				{ name: 'trimItems', label: 'Trim items', kind: 'boolean', required: false },
				{ name: 'omitEmpty', label: 'Omit empty values', kind: 'boolean', required: false },
				{ name: 'unique', label: 'Remove duplicates', kind: 'boolean', required: false }
			]
		},
		{
			operation: 'first',
			label: 'First',
			description: 'Use the first value from a multi-value array.',
			parameters: [
				{ name: 'trimItems', label: 'Trim items', kind: 'boolean', required: false },
				{ name: 'omitEmpty', label: 'Omit empty values', kind: 'boolean', required: false }
			]
		},
		{
			operation: 'oidc_pairwise_sub',
			label: 'OIDC pairwise sub',
			description: 'Use the current OIDC client pairwise subject identifier.',
			parameters: [
				{
					name: 'persistentIdentifierProfileId',
					label: 'Persistent Identifier Profile',
					kind: 'string',
					required: false,
					placeholder: 'profile id'
				}
			]
		},
		{
			operation: 'saml_edu_person_targeted_id',
			label: 'SAML eduPersonTargetedID',
			description: 'Build IdP!SP!opaque targeted ID from the current SAML SP context.',
			parameters: [
				{
					name: 'persistentIdentifierProfileId',
					label: 'Persistent Identifier Profile',
					kind: 'string',
					required: false,
					placeholder: 'profile id'
				}
			]
		},
		{
			operation: 'affix_text',
			label: 'Add prefix/suffix',
			description: 'Add fixed text before or after the input value.',
			parameters: [
				{
					name: 'prefix',
					label: 'Prefix',
					kind: 'string',
					required: false,
					placeholder: 'prefix'
				},
				{
					name: 'suffix',
					label: 'Suffix',
					kind: 'string',
					required: false,
					placeholder: 'suffix'
				}
			]
		},
		{
			operation: 'trim',
			label: 'Trim',
			description: 'Remove leading and trailing whitespace from the first input value.',
			parameters: []
		},
		{
			operation: 'normalize',
			label: 'Normalize',
			description: 'Normalize Unicode or collapse repeated whitespace before validation.',
			parameters: [
				{
					name: 'mode',
					label: 'Mode',
					kind: 'enum',
					required: true,
					options: [
						{ value: 'whitespace', label: 'Whitespace' },
						{ value: 'unicode', label: 'Unicode NFKC' }
					]
				}
			]
		},
		{
			operation: 'case',
			label: 'Case',
			description: 'Convert string case before writing to the target.',
			parameters: [
				{
					name: 'mode',
					label: 'Mode',
					kind: 'enum',
					required: true,
					options: [
						{ value: 'lower', label: 'Lowercase' },
						{ value: 'upper', label: 'Uppercase' },
						{ value: 'title', label: 'Title case' }
					]
				}
			]
		},
		{
			operation: 'concat',
			label: 'Concat',
			description: 'Join all connected input values into one string.',
			parameters: [
				{
					name: 'delimiter',
					label: 'Delimiter',
					kind: 'string',
					required: false,
					placeholder: 'space, comma, blank, or custom text'
				}
			]
		},
		{
			operation: 'fallback',
			label: 'Fallback',
			description: 'Use the first non-empty connected input value.',
			parameters: []
		},
		{
			operation: 'text_to_boolean',
			label: 'Text to boolean',
			description:
				'Convert configured text tokens to true, false, or null before writing to a boolean target.',
			parameters: [
				{
					name: 'trueValues',
					label: 'True values',
					kind: 'string',
					required: false,
					placeholder: 'true, 1, yes, active'
				},
				{
					name: 'falseValues',
					label: 'False values',
					kind: 'string',
					required: false,
					placeholder: 'false, 0, no, inactive'
				},
				{
					name: 'nullValues',
					label: 'Null values',
					kind: 'string',
					required: false,
					placeholder: 'empty, null, none, n/a'
				}
			]
		},
		{
			operation: 'json_build',
			label: 'Build JSON',
			description:
				'Build a JSON object from one or more inputs, or parse a single JSON text input.',
			parameters: [
				{
					name: 'keyMap',
					label: 'Key map',
					kind: 'string',
					required: false,
					placeholder: '{"source_column":"jsonKey"}'
				},
				{
					name: 'nullHandling',
					label: 'Null handling',
					kind: 'enum',
					required: true,
					options: [
						{ value: 'omit', label: 'Omit empty values' },
						{ value: 'include_null', label: 'Include null values' }
					]
				}
			]
		},
		{
			operation: 'json_extract_text',
			label: 'Extract text from JSON',
			description: 'Read a JSON path and output text.',
			parameters: [
				{
					name: 'path',
					label: 'JSON path',
					kind: 'string',
					required: true,
					placeholder: 'profile.name or emails[0].value'
				}
			]
		},
		{
			operation: 'json_extract_boolean',
			label: 'Extract boolean from JSON',
			description: 'Read a JSON path and output true, false, or null.',
			parameters: [
				{
					name: 'path',
					label: 'JSON path',
					kind: 'string',
					required: true,
					placeholder: 'active or flags.enabled'
				}
			]
		},
		{
			operation: 'json_extract_integer',
			label: 'Extract integer from JSON',
			description: 'Read a JSON path and output an integer or null.',
			parameters: [
				{
					name: 'path',
					label: 'JSON path',
					kind: 'string',
					required: true,
					placeholder: 'quota.limit or memberships[0].rank'
				}
			]
		}
	];
	const transformOperationCategories: TransformOperationCategory[] = [
		{ id: 'basic', operations: ['copy', 'fallback'] },
		{ id: 'array', operations: ['as_array', 'split', 'join', 'first'] },
		{
			id: 'text',
			operations: ['trim', 'normalize', 'case', 'affix_text', 'concat', 'text_to_boolean']
		},
		{ id: 'identifier', operations: ['oidc_pairwise_sub', 'saml_edu_person_targeted_id'] },
		{
			id: 'json',
			operations: [
				'json_build',
				'json_extract_text',
				'json_extract_boolean',
				'json_extract_integer'
			]
		}
	];

	const {
		samples = [],
		loading = false,
		loadError = null,
		allowedViewModes = ['overview', 'source', 'destination'],
		initialViewMode = 'overview',
		editable = true,
		showToolbarSourceProfile = true,
		showToolbarModeToggle = true,
		showMetrics = true,
		showInspector = true,
		showLaneProfileSelectors = true,
		laneSelectorMode = 'profile',
		policySelectorOptions = [],
		showGraphPolicyDraftLabel = true,
		showCompileDraftButton = true,
		primaryActionLabel = 'Compile draft',
		primaryActionBusyLabel = 'Compiling...',
		initialPolicyOptionId = null,
		selectedViewMode = null,
		selectedProfileId = null,
		emptyStateTitle = null,
		emptyStateDescription = null,
		emptyStateActionHref = null,
		emptyStateActionLabel = null,
		draftResetKey = 0,
		onDraftDirtyChange = null,
		onCompileDraft = null
	} = $props<{
		samples?: MappingSample[];
		loading?: boolean;
		loadError?: string | null;
		allowedViewModes?: ViewMode[];
		initialViewMode?: ViewMode;
		editable?: boolean;
		showToolbarSourceProfile?: boolean;
		showToolbarModeToggle?: boolean;
		showMetrics?: boolean;
		showInspector?: boolean;
		showLaneProfileSelectors?: boolean;
		laneSelectorMode?: 'profile' | 'policy';
		policySelectorOptions?: SelectorOption[];
		showGraphPolicyDraftLabel?: boolean;
		showCompileDraftButton?: boolean;
		primaryActionLabel?: string;
		primaryActionBusyLabel?: string;
		initialPolicyOptionId?: string | null;
		selectedViewMode?: ViewMode | null;
		selectedProfileId?: string | null;
		emptyStateTitle?: string | null;
		emptyStateDescription?: string | null;
		emptyStateActionHref?: string | null;
		emptyStateActionLabel?: string | null;
		draftResetKey?: number;
		onDraftDirtyChange?: ((dirty: boolean) => void) | null;
		onCompileDraft?: ((draft: MappingDraftPayload) => Promise<void> | void) | null;
	}>();

	const emptySample: MappingSample = {
		id: 'empty-control-plane',
		title: 'No control-plane schemas loaded',
		snapshot: 'not available',
		status: 'empty',
		reviewGates: '0 fields',
		sourceAdapter: 'CSV',
		destinationAdapter: 'OIDC',
		activeRuleId: 'empty-flow',
		metrics: ['0 / 0', '0 schemas', '0', 'no catalog'],
		nodes: [],
		edges: [],
		rules: {}
	};
	const nodeHeight = 32;
	const targetHeight = 40;
	const transformWidth = 168;
	const transformHeight = 38;
	const graphBaseTop = $derived(showLaneProfileSelectors ? 76 : 48);
	const graphStep = 50;
	const targetGroupHeaderHeight = 28;
	const targetGroupRowStep = targetHeight - 1;
	const targetGroupGap = 10;
	const connectionAutoScrollMargin = 72;
	const connectionAutoScrollMaxSpeed = 24;
	const connectionAutoScrollMinSpeed = 4;

	let canvas: HTMLDivElement;
	let canvasWidth = $state(1000);
	let sample = $state(emptySample);
	let selectedSampleId = $state<string | null>(null);
	let activeSampleRef: MappingSample | null = null;
	let sourceAdapter = $state<MappingAdapter>(emptySample.sourceAdapter);
	let destinationAdapter = $state<MappingAdapter>(emptySample.destinationAdapter);
	let selectedDestinationProfileId = $state<string | null>(null);
	let selectedSourcePolicyId = $state<string | null>(null);
	let selectedDestinationPolicyId = $state<string | null>(null);
	let appliedInitialPolicyOptionId = $state<string | null>(null);
	let activeRuleId = $state(emptySample.activeRuleId);
	let activeTab = $state<'rule' | 'dryrun' | 'diff'>('rule');
	let viewMode = $state<ViewMode>('overview');
	let viewModeInitialized = false;
	let customCounter = $state(0);
	let nodes = $state<MappingNode[]>([...emptySample.nodes]);
	let edges = $state<MappingEdge[]>([...emptySample.edges]);
	let hoverNodeId = $state<string | null>(null);
	let hoverEdgeId = $state<string | null>(null);
	let hoverTargetGroupKey = $state<string | null>(null);
	let infoOverlayNodeId = $state<string | null>(null);
	let selectedNodeId = $state<string | null>(null);
	let selectedEdgeId = $state<string | null>(null);
	let collapsedTargetGroupKeys = $state<string[]>([]);
	let hasUnsavedDraftChanges = $state(false);
	let activeDraftResetKey = $state<number | null>(null);
	let draftSubmitStatus = $state<'idle' | 'saving' | 'saved' | 'info' | 'error'>('idle');
	let draftSubmitMessage = $state<string | null>(null);
	let persistentIdentifierProfiles = $state<PersistentIdentifierProfileSummary[]>([]);
	let dryRunResults = $state<
		Record<string, Pick<RuleDetail, 'dryrunStatus' | 'dryrunTone' | 'input' | 'output' | 'trace'>>
	>({});
	let swappingNodeIds = $state<string[]>([]);
	let nodeSwapAnimationTimer: ReturnType<typeof setTimeout> | null = null;
	let animateNextSampleSourceNodes = false;
	let dragState = $state<{
		fromNodeId: string;
		from: Point;
		to: Point;
		validTarget: boolean | null;
		targetNodeId: string | null;
		reconnectEdgeId?: string;
		reconnectSide?: 'source' | 'target';
		fixedNodeId?: string;
	} | null>(null);
	let pendingConnectionStart: {
		fromNodeId: string;
		startClient: Point;
		from: Point;
	} | null = null;
	let connectionDragPointer: Point | null = null;
	let connectionAutoScrollFrame: number | null = null;
	let suppressNextNodeClickId: string | null = null;
	let suppressNextCanvasClear = false;

	interface Point {
		x: number;
		y: number;
	}

	interface LayoutNode extends MappingNode {
		top: number;
		left: number;
		width: number;
		height: number;
		hidden: boolean;
		stackIndex: number;
		collapsed?: boolean;
		targetGroupKey?: string;
		targetGroupPosition?: 'single' | 'first' | 'middle' | 'last';
	}

	interface TargetNodeGroup {
		key: string;
		label: string;
		nodes: MappingNode[];
	}

	interface LayoutTargetGroup {
		key: string;
		label: string;
		top: number;
		left: number;
		width: number;
		height: number;
		count: number;
		collapsed: boolean;
	}

	const sourcePolicyOptions = $derived(
		policySelectorOptions.filter(
			(option: SelectorOption) => option.direction === 'source' || option.direction === 'both'
		)
	);
	const destinationPolicyOptions = $derived(
		policySelectorOptions.filter(
			(option: SelectorOption) => option.direction === 'destination' || option.direction === 'both'
		)
	);
	const selectedSourcePolicy = $derived(
		sourcePolicyOptions.find((option: SelectorOption) => option.id === selectedSourcePolicyId) ??
			null
	);
	const selectedDestinationPolicy = $derived(
		destinationPolicyOptions.find(
			(option: SelectorOption) => option.id === selectedDestinationPolicyId
		) ?? null
	);
	const policyModeHasSelection = $derived(
		laneSelectorMode !== 'policy' || Boolean(selectedSourcePolicyId || selectedDestinationPolicyId)
	);
	const visibleNodes = $derived(
		policyModeHasSelection
			? nodes.filter(
					(node) =>
						node.role === 'target' ||
						node.role === 'transform' ||
						(node.role === 'source' && viewMode !== 'destination') ||
						(node.role === 'destination' && viewMode !== 'source')
				)
			: []
	);
	const overviewLayerSourceNodes = $derived(
		viewMode === 'overview' && policyModeHasSelection
			? samples
					.filter((candidate: MappingSample) => candidate.id !== sample.id)
					.flatMap((candidate: MappingSample) =>
						candidate.nodes
							.filter((node: MappingNode) => node.role === 'source')
							.map((node: MappingNode) => ({
								...node,
								id: `overview-layer-${candidate.id}-${node.id}`,
								ruleId: `overview-layer-${candidate.id}-${node.ruleId}`,
								profileId: candidate.id,
								profileTitle: candidate.title
							}))
					)
			: []
	);
	const sourceNodes = $derived([
		...visibleNodes.filter((node) => node.role === 'source'),
		...overviewLayerSourceNodes
	]);
	const transformNodes = $derived(visibleNodes.filter((node) => node.role === 'transform'));
	const targetNodes = $derived(visibleNodes.filter((node) => node.role === 'target'));
	const targetNodeGroups = $derived(groupTargetNodes(targetNodes));
	const groupedTargetNodes = $derived(targetNodeGroups.flatMap((group) => group.nodes));
	const destinationNodes = $derived(visibleNodes.filter((node) => node.role === 'destination'));
	const sourceProfileOptions = $derived(
		((samples.length > 0 ? samples : [sample]) as MappingSample[]).map(
			(candidate: MappingSample) => ({
				id: candidate.id,
				title: candidate.title,
				adapter: candidate.sourceAdapter
			})
		)
	);
	const destinationProfileOptions = $derived(destinationProfileOptionsForSample(sample));
	const selectedSourcePolicyTitle = $derived(selectedSourcePolicy?.title ?? null);
	const selectedDestinationPolicyTitle = $derived(selectedDestinationPolicy?.title ?? null);
	const graphTitle = $derived.by(() => {
		if (laneSelectorMode !== 'policy') return sample.title;
		if (!selectedSourcePolicyTitle && !selectedDestinationPolicyTitle)
			return $LL.admin_identity_mapping_flow_no_mapping_policies();
		if (selectedSourcePolicyTitle && selectedSourcePolicyTitle === selectedDestinationPolicyTitle) {
			return selectedSourcePolicyTitle;
		}
		return [selectedSourcePolicyTitle, selectedDestinationPolicyTitle].filter(Boolean).join(' / ');
	});
	const emptyGraphTitle = $derived(
		laneSelectorMode === 'policy'
			? policySelectorOptions.length === 0
				? $LL.admin_identity_mapping_flow_no_active_policies()
				: $LL.admin_identity_mapping_flow_select_active_policy()
			: $LL.admin_identity_mapping_flow_no_profiles_registered()
	);
	const emptyGraphDescription = $derived(
		laneSelectorMode === 'policy'
			? policySelectorOptions.length === 0
				? $LL.admin_identity_mapping_flow_no_active_policies_desc()
				: $LL.admin_identity_mapping_flow_select_active_policy_desc()
			: $LL.admin_identity_mapping_flow_no_profiles_registered_desc()
	);
	const resolvedEmptyGraphTitle = $derived(emptyStateTitle ?? emptyGraphTitle);
	const resolvedEmptyGraphDescription = $derived(emptyStateDescription ?? emptyGraphDescription);
	const hasControlPlaneData = $derived(
		samples.length > 0 && (laneSelectorMode !== 'policy' || policySelectorOptions.length > 0)
	);
	const hasRenderableGraph = $derived(hasControlPlaneData && policyModeHasSelection);
	const layout = $derived(buildLayout());
	const laidOutNodes = $derived(layout.nodes);
	const overviewLayerEdges = $derived(buildOverviewLayerEdges());
	const graphEdges = $derived(
		[...edges, ...overviewLayerEdges].filter((edge) => {
			const fromNode = layoutNodeById(edge.from);
			const toNode = layoutNodeById(edge.to);
			return fromNode && toNode;
		})
	);
	const selectedEdge = $derived(
		selectedEdgeId ? graphEdges.find((edge) => edge.id === selectedEdgeId) : null
	);
	const selectedEdges = $derived(
		new Set([...connectedEdgeIds(selectedNodeId), ...(selectedEdgeId ? [selectedEdgeId] : [])])
	);
	const hoverEdges = $derived(
		new Set([...connectedEdgeIds(hoverNodeId), ...connectedTargetGroupEdgeIds(hoverTargetGroupKey)])
	);
	const activeTargetGroupKeys = $derived.by(() => {
		const keys: string[] = [];
		if (hoverTargetGroupKey) addTargetGroupKey(keys, hoverTargetGroupKey);
		addConnectedTargetGroupKeys(hoverNodeId, keys);
		addConnectedTargetGroupKeys(selectedNodeId, keys);
		addEdgeTargetGroupKeys(hoverEdgeId, keys);
		addEdgeTargetGroupKeys(selectedEdgeId, keys);
		return keys;
	});
	const invalidEdgeTargetNodeIds = $derived(
		new Set(
			graphEdges
				.filter((edge) => edgeHasTypeMismatch(edge))
				.map((edge) => edge.to)
				.filter(Boolean)
		)
	);
	const enabledViewModes = $derived(
		allowedViewModes.length > 0 ? allowedViewModes : (['overview'] satisfies ViewMode[])
	);
	const inspectorRuleKey = $derived(selectedEdge ? `edge:${selectedEdge.id}` : activeRuleId);
	const baseRule = $derived(
		selectedEdge ? edgeInspectorRule(selectedEdge) : (sample.rules[activeRuleId] ?? fallbackRule())
	);
	const liveDryRunResult = $derived.by(() => {
		if (activeTab !== 'dryrun') return null;
		const edge = selectedDryRunEdge();
		return dryRunRulePatch(
			edge ? evaluateDryRunEdge(edge) : evaluateDryRunNode(selectedInspectorNode())
		);
	});
	const rule = $derived({
		...baseRule,
		...(dryRunResults[inspectorRuleKey] ?? {}),
		...(liveDryRunResult ?? {})
	});
	const selectedTransformNode = $derived.by(() => {
		const selected = selectedNodeId ? nodeById(selectedNodeId) : undefined;
		return selected?.role === 'transform' ? selected : null;
	});

	$effect(() => {
		if (!viewModeInitialized) {
			viewMode = enabledViewModes.includes(initialViewMode) ? initialViewMode : enabledViewModes[0];
			viewModeInitialized = true;
		}
		if (!enabledViewModes.includes(viewMode)) {
			viewMode = enabledViewModes[0];
		}
		if (
			selectedViewMode &&
			enabledViewModes.includes(selectedViewMode) &&
			viewMode !== selectedViewMode
		) {
			viewMode = selectedViewMode;
		}
	});

	$effect(() => {
		if (
			selectedViewMode === 'source' &&
			selectedProfileId &&
			selectedProfileId !== selectedSampleId
		) {
			animateNextSampleSourceNodes = true;
			selectedSampleId = selectedProfileId;
		}
		const next =
			(samples as MappingSample[]).find(
				(candidate: MappingSample) => candidate.id === selectedSampleId
			) ??
			samples[0] ??
			emptySample;
		if (activeSampleRef !== next) {
			activateSample(next);
		}
	});

	$effect(() => {
		if (
			laneSelectorMode !== 'policy' ||
			!initialPolicyOptionId ||
			appliedInitialPolicyOptionId === initialPolicyOptionId
		) {
			return;
		}
		const option = policySelectorOptions.find(
			(candidate: SelectorOption) => candidate.id === initialPolicyOptionId
		);
		if (!option) return;
		appliedInitialPolicyOptionId = initialPolicyOptionId;
		if (option.direction === 'source') {
			applySourcePolicySelection(option.id);
		} else if (option.direction === 'destination') {
			applyDestinationPolicySelection(option.id);
		}
	});

	$effect(() => {
		if (laneSelectorMode === 'policy') {
			if (!selectedDestinationPolicyId) {
				selectedDestinationProfileId = null;
				return;
			}
			const destinationProfileId = selectedDestinationPolicy?.destinationProfileIds?.find(
				(id: string) => destinationProfileOptions.some((option) => option.id === id)
			);
			if (destinationProfileId) {
				selectedDestinationProfileId = destinationProfileId;
				return;
			}
		}
		if (selectedViewMode === 'destination' && selectedProfileId) {
			selectedDestinationProfileId = selectedProfileId;
		}
		const hasSelectedDestination = destinationProfileOptions.some(
			(option) => option.id === selectedDestinationProfileId
		);
		if (!hasSelectedDestination) {
			selectedDestinationProfileId =
				destinationProfileOptions.find((option) => option.adapter === 'OIDC')?.id ??
				destinationProfileOptions[0]?.id ??
				null;
		}
	});

	$effect(() => {
		if (activeDraftResetKey === null) {
			activeDraftResetKey = draftResetKey;
			return;
		}
		if (activeDraftResetKey === draftResetKey) return;
		activeDraftResetKey = draftResetKey;
		resetDraftFromCurrentSample();
	});

	$effect(() => {
		onDraftDirtyChange?.(hasUnsavedDraftChanges);
	});

	beforeNavigate((navigation) => {
		if (!editable || !hasUnsavedDraftChanges) return;
		const shouldLeave = window.confirm($LL.admin_identity_mapping_flow_unsaved_leave_confirm());
		if (!shouldLeave) {
			navigation.cancel();
		}
	});

	onMount(() => {
		void loadPersistentIdentifierProfiles();
		const resize = () => {
			const rect = canvas?.getBoundingClientRect();
			if (!rect) return;
			canvasWidth = Math.max(720, rect.width);
		};
		resize();
		const observer = new ResizeObserver(resize);
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (!editable || !hasUnsavedDraftChanges) return;
			event.preventDefault();
			event.returnValue = '';
		};
		if (canvas) observer.observe(canvas);
		window.addEventListener('resize', resize);
		window.addEventListener('keydown', handleGlobalKeyDown);
		window.addEventListener('beforeunload', beforeUnload);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', resize);
			window.removeEventListener('keydown', handleGlobalKeyDown);
			window.removeEventListener('beforeunload', beforeUnload);
		};
	});

	async function loadPersistentIdentifierProfiles() {
		try {
			const response = await adminIdentityMappingAPI.listPersistentIdentifierProfiles();
			persistentIdentifierProfiles = response.profiles.filter(
				(profile) => profile.lifecycleState === 'active'
			);
		} catch {
			persistentIdentifierProfiles = [];
		}
	}

	function activateSample(next: MappingSample) {
		activeSampleRef = next;
		selectedSampleId = next.id;
		sourceAdapter = next.sourceAdapter;
		destinationAdapter = next.destinationAdapter;
		selectedDestinationProfileId =
			destinationProfileOptionsForSample(next).find((option) => option.adapter === 'OIDC')?.id ??
			destinationProfileOptionsForSample(next)[0]?.id ??
			null;
		applyPolicyGraph(next);
		if (animateNextSampleSourceNodes) {
			animateNextSampleSourceNodes = false;
			queueMicrotask(() => animateVisibleNodeSwap('source'));
		}
	}

	function applyPolicyGraph(base: MappingSample) {
		const policyGraph = buildPolicyGraph(base);
		sample = policyGraph;
		nodes = [...policyGraph.nodes];
		edges = [...policyGraph.edges];
		activeRuleId = policyGraph.edges[0]?.id ?? policyGraph.activeRuleId;
		selectedEdgeId = null;
		selectedNodeId = null;
		hasUnsavedDraftChanges = false;
		swappingNodeIds = [];
	}

	function resetDraftFromCurrentSample() {
		stopConnectionAutoScroll();
		nodes = [...sample.nodes];
		edges = [...sample.edges];
		activeRuleId = sample.activeRuleId;
		selectedEdgeId = null;
		selectedNodeId = null;
		hoverNodeId = null;
		dragState = null;
		pendingConnectionStart = null;
		suppressNextNodeClickId = null;
		hasUnsavedDraftChanges = false;
		swappingNodeIds = [];
	}

	onDestroy(() => {
		stopConnectionAutoScroll();
		if (nodeSwapAnimationTimer) clearTimeout(nodeSwapAnimationTimer);
		window.removeEventListener('pointermove', handlePointerMove);
		window.removeEventListener('pointerup', handlePointerUp);
		window.removeEventListener('pointermove', handleEasyConnectionPointerMove);
		window.removeEventListener('pointerup', handleEasyConnectionPointerUp);
	});

	function nodeById(id: string): MappingNode | undefined {
		return nodes.find((node) => node.id === id);
	}

	function firstNodeExample(node: MappingNode | undefined): string {
		const example = node?.examples?.[0];
		if (example !== undefined && example !== null && String(example).trim().length > 0) {
			return formatNodeInfoValue(example);
		}
		if (node?.caption) return node.caption;
		return node?.label ?? $LL.admin_identity_mapping_flow_not_connected();
	}

	function nodeForRule(ruleId: string): MappingNode | undefined {
		return nodes.find((node) => node.ruleId === ruleId);
	}

	function layoutNodeById(id: string): LayoutNode | undefined {
		return laidOutNodes.find((node) => node.id === id);
	}

	function layoutTargetGroupByKey(key: string): LayoutTargetGroup | undefined {
		return layout.targetGroups.find((group) => group.key === key);
	}

	function selectRule(ruleId: string) {
		activeRuleId = ruleId;
		selectedEdgeId = null;
		selectedNodeId = nodeForRule(ruleId)?.id ?? null;
		dryRunResults = {};
	}

	function selectEdge(edge: MappingEdge) {
		selectedEdgeId = edge.id;
		selectedNodeId = null;
		dryRunResults = {};
	}

	function clearSelection() {
		selectedEdgeId = null;
		selectedNodeId = null;
		hoverNodeId = null;
		hoverEdgeId = null;
		hoverTargetGroupKey = null;
		dryRunResults = {};
	}

	function clearCanvasSelection() {
		if (suppressNextCanvasClear) {
			suppressNextCanvasClear = false;
			return;
		}
		clearSelection();
	}

	function suppressCanvasClearOnce() {
		suppressNextCanvasClear = true;
		window.setTimeout(() => {
			suppressNextCanvasClear = false;
		}, 0);
	}

	function markDraftDirty() {
		hasUnsavedDraftChanges = true;
		draftSubmitStatus = 'idle';
		draftSubmitMessage = null;
	}

	function visibleAutoMapFromNodes(): MappingNode[] {
		if (viewMode === 'destination') {
			return targetNodes.filter((node) => !node.locked);
		}
		return sourceNodes.filter((node) =>
			node.profileId ? node.profileId === sample.id : node.adapter === sourceAdapter
		);
	}

	function visibleAutoMapToNodes(): MappingNode[] {
		if (viewMode === 'destination') {
			return destinationNodes.filter((node) =>
				node.profileId
					? node.profileId === selectedDestinationProfileId
					: node.adapter === destinationAdapter
			);
		}
		return targetNodes.filter((node) => !node.locked);
	}

	function autoMapConnections() {
		if (!editable) return;
		const candidates = suggestAutoMapConnections({
			fromNodes: visibleAutoMapFromNodes(),
			toNodes: visibleAutoMapToNodes(),
			existingEdges: edges,
			max: 32
		});
		const newEdges: MappingEdge[] = [];

		for (const candidate of candidates) {
			const fromNode = nodeById(candidate.fromId);
			const toNode = nodeById(candidate.toId);
			if (!fromNode || !toNode) continue;
			if (!isConnectionAllowed(fromNode, toNode, new Set(), newEdges)) continue;
			if (isConnectionTypeMismatch(fromNode, toNode)) continue;
			customCounter += 1;
			newEdges.push({
				id: `auto-edge-${customCounter}`,
				from: fromNode.id,
				to: toNode.id,
				destinationSide: fromNode.role === 'target',
				custom: true
			});
		}
		logDebug('[IdentityMappingAutoMap]', {
			viewMode,
			fromNodes: visibleAutoMapFromNodes().map(debugNode),
			toNodes: visibleAutoMapToNodes().map(debugNode),
			candidates,
			newEdges
		});

		if (newEdges.length === 0) {
			draftSubmitStatus = 'info';
			draftSubmitMessage = $LL.admin_identity_mapping_flow_no_auto_map();
			return;
		}

		edges = [...edges, ...newEdges];
		selectedEdgeId = newEdges.at(-1)?.id ?? null;
		selectedNodeId = null;
		hasUnsavedDraftChanges = true;
		onDraftDirtyChange?.(true);
		draftSubmitStatus = 'info';
		draftSubmitMessage = $LL.admin_identity_mapping_flow_auto_mapped({
			count: newEdges.length
		});
	}

	async function animateVisibleNodeSwap(role: 'source' | 'destination') {
		await tick();
		if (nodeSwapAnimationTimer) clearTimeout(nodeSwapAnimationTimer);
		const visibleNodeIds = laidOutNodes
			.filter((node) => node.role === role && !node.hidden)
			.map((node) => node.id);
		swappingNodeIds = [];
		if (visibleNodeIds.length === 0) return;
		queueMicrotask(() => {
			swappingNodeIds = visibleNodeIds;
			nodeSwapAnimationTimer = setTimeout(() => {
				swappingNodeIds = [];
				nodeSwapAnimationTimer = null;
			}, 300);
		});
	}

	function handleClearSelectionKeyDown(event: KeyboardEvent) {
		if (event.key !== 'Escape' && event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		clearSelection();
	}

	function connectedEdgeIds(nodeId: string | null): Set<string> {
		if (!nodeId) return new Set();
		return connectedGraph(nodeId).edgeIds;
	}

	function connectedTargetGroupEdgeIds(groupKey: string | null): Set<string> {
		if (!groupKey) return new Set();
		const group = targetNodeGroups.find((candidate) => candidate.key === groupKey);
		if (!group) return new Set();
		return new Set(
			group.nodes.flatMap((node) => {
				const graph = connectedGraph(node.id);
				return [...graph.edgeIds];
			})
		);
	}

	function addTargetGroupKey(keys: string[], key: string) {
		if (!keys.includes(key)) keys.push(key);
	}

	function addConnectedTargetGroupKeys(nodeId: string | null, keys: string[]) {
		if (!nodeId) return;
		for (const connectedNodeId of [nodeId, ...connectedGraph(nodeId).nodeIds]) {
			const node = nodeById(connectedNodeId);
			if (node?.role !== 'target') continue;
			addTargetGroupKey(keys, targetGroupKey(node));
		}
	}

	function addEdgeTargetGroupKeys(edgeId: string | null, keys: string[]) {
		if (!edgeId) return;
		const edge = edges.find((candidate) => candidate.id === edgeId);
		if (!edge) return;
		addConnectedTargetGroupKeys(edge.from, keys);
		addConnectedTargetGroupKeys(edge.to, keys);
	}

	function connectedNodeIds(nodeId: string | null): Set<string> {
		if (!nodeId) return new Set();
		return connectedGraph(nodeId).nodeIds;
	}

	function connectedGraph(nodeId: string): { nodeIds: Set<string>; edgeIds: Set<string> } {
		const nodeIds: string[] = [];
		const edgeIds: string[] = [];
		const visited = [nodeId];
		const queue = [nodeId];

		while (queue.length > 0) {
			const current = queue.shift();
			if (!current) continue;
			for (const edge of edges) {
				if (edge.from !== current && edge.to !== current) continue;
				if (!edgeIds.includes(edge.id)) edgeIds.push(edge.id);
				const next = edge.from === current ? edge.to : edge.from;
				if (visited.includes(next)) continue;
				visited.push(next);
				nodeIds.push(next);
				queue.push(next);
			}
		}

		return { nodeIds: new Set(nodeIds), edgeIds: new Set(edgeIds) };
	}

	function buildOverviewLayerEdges(): MappingEdge[] {
		if (laneSelectorMode !== 'policy' || viewMode !== 'overview') return [];
		const layerEdges: MappingEdge[] = [];
		const seen: string[] = [];
		const addLayerEdge = (from: string, to: string, destinationSide = false) => {
			const id = `overview-layer-edge-${from}-${to}`;
			if (seen.includes(id)) return;
			seen.push(id);
			layerEdges.push({ id, from, to, destinationSide });
		};

		for (const option of sourcePolicyOptions) {
			if (option.id === selectedSourcePolicyId) continue;
			for (const rule of rulesForPolicyOption(option, 'source')) {
				for (const edge of rule.edges) {
					for (const profileId of sourceProfileIdsForPolicyEdge(option, edge)) {
						const profileSample = samples.find(
							(candidate: MappingSample) => candidate.id === profileId
						);
						if (!profileSample) continue;
						const sourceNode = nodeFromPolicyRef(profileSample.nodes, edge.sourceRef);
						const targetNode = nodeFromPolicyRef(nodes, edge.targetRef);
						if (!sourceNode || !targetNode) continue;
						addLayerEdge(`overview-layer-${profileSample.id}-${sourceNode.id}`, targetNode.id);
					}
				}
			}
		}

		for (const option of destinationPolicyOptions) {
			if (option.id === selectedDestinationPolicyId) continue;
			for (const rule of rulesForPolicyOption(option, 'destination')) {
				for (const edge of rule.edges) {
					const sourceNode = nodeFromPolicyRef(nodes, edge.sourceRef);
					const destinationNode = nodeFromPolicyRef(nodes, edge.targetRef);
					if (!sourceNode || !destinationNode) continue;
					addLayerEdge(sourceNode.id, destinationNode.id, true);
				}
			}
		}

		return layerEdges;
	}

	function sourceProfileIdsForPolicyEdge(
		option: SelectorOption,
		edge: PolicySelectorEdge
	): string[] {
		const profileId = stringRef(edge.sourceRef, 'profileId');
		if (profileId) return [profileId];
		return option.sourceProfileIds ?? [];
	}

	function buildPolicyGraph(base: MappingSample): MappingSample {
		const baseNodes = base.nodes.map((node) => ({ ...node }));
		const policyRules = selectedPolicyRules();
		if (laneSelectorMode !== 'policy' || policyRules.length === 0) {
			return {
				...base,
				nodes: baseNodes,
				edges: [...base.edges],
				rules: { ...base.rules }
			};
		}

		const graphNodes = [...baseNodes];
		const graphEdges: MappingEdge[] = [];
		const graphRules: MappingSample['rules'] = { ...base.rules };
		let transformIndex = 0;

		for (const rule of policyRules) {
			const transforms = [...rule.transforms].sort((a, b) => a.stepOrder - b.stepOrder);
			const resolvedEdges = rule.edges.flatMap((edge) => {
				const fromNode = nodeFromPolicyRef(graphNodes, edge.sourceRef);
				const toNode = nodeFromPolicyRef(graphNodes, edge.targetRef);
				if (!fromNode || !toNode) return [];
				return [{ edge, fromNode, toNode }];
			});
			if (transforms.length === 0) {
				for (const { edge, fromNode, toNode } of resolvedEdges) {
					const edgeId = `policy-edge-${edge.id}`;
					graphEdges.push({
						id: edgeId,
						from: fromNode.id,
						to: toNode.id,
						destinationSide: fromNode.role === 'target'
					});
					graphRules[edgeId] = ruleForPolicyEdge(rule, fromNode, toNode);
				}
				continue;
			}

			if (shouldGroupPolicyTransformInputs(rule, resolvedEdges, transforms)) {
				const targetNode = resolvedEdges[0]?.toNode;
				if (!targetNode) continue;
				transformIndex += 1;
				const transformNode = policyTransformNode(
					rule,
					'group',
					targetNode,
					transforms,
					transformIndex
				);
				graphNodes.push(transformNode);
				graphRules[transformNode.ruleId] = ruleForPolicyTransform(rule, transformNode, targetNode);

				const addedInputNodeIds: string[] = [];
				for (const { edge, fromNode } of resolvedEdges) {
					if (addedInputNodeIds.includes(fromNode.id)) continue;
					addedInputNodeIds.push(fromNode.id);
					graphEdges.push({
						id: `policy-edge-${edge.id}-in`,
						from: fromNode.id,
						to: transformNode.id,
						destinationSide: fromNode.role === 'target'
					});
				}
				graphEdges.push({
					id: `policy-edge-${rule.id}-out`,
					from: transformNode.id,
					to: targetNode.id,
					destinationSide: targetNode.role === 'destination'
				});
				continue;
			}

			for (const { edge, fromNode, toNode } of resolvedEdges) {
				const edgeTransforms = transforms.filter((transform) => transform.edgeId === edge.id);
				if (edgeTransforms.length === 0) {
					const edgeId = `policy-edge-${edge.id}`;
					graphEdges.push({
						id: edgeId,
						from: fromNode.id,
						to: toNode.id,
						destinationSide: fromNode.role === 'target'
					});
					graphRules[edgeId] = ruleForPolicyEdge(rule, fromNode, toNode);
					continue;
				}
				transformIndex += 1;
				const transformNode = policyTransformNode(
					rule,
					edge.id,
					toNode,
					edgeTransforms,
					transformIndex
				);
				graphNodes.push(transformNode);
				graphRules[transformNode.ruleId] = ruleForPolicyTransform(rule, transformNode, toNode);
				graphEdges.push(
					{
						id: `policy-edge-${edge.id}-in`,
						from: fromNode.id,
						to: transformNode.id,
						destinationSide: fromNode.role === 'target'
					},
					{
						id: `policy-edge-${edge.id}-out`,
						from: transformNode.id,
						to: toNode.id,
						destinationSide: toNode.role === 'destination'
					}
				);
			}
		}

		return {
			...base,
			nodes: graphNodes,
			edges: graphEdges,
			rules: graphRules
		};
	}

	function shouldGroupPolicyTransformInputs(
		rule: PolicySelectorRule,
		resolvedEdges: Array<{
			edge: PolicySelectorEdge;
			fromNode: MappingNode;
			toNode: MappingNode;
		}>,
		transforms: PolicySelectorTransform[]
	): boolean {
		if (resolvedEdges.length <= 1) return false;
		const targetIds = new Set(resolvedEdges.map(({ toNode }) => toNode.id));
		if (targetIds.size !== 1) return false;
		if (rule.edges.some((edge) => edge.edgeKind === 'transform_input')) return true;
		const transformEdgeIds = new Set(
			transforms.flatMap((transform) => (transform.edgeId ? [transform.edgeId] : []))
		);
		return transformEdgeIds.size <= 1;
	}

	function policyTransformNode(
		rule: PolicySelectorRule,
		key: string,
		targetNode: MappingNode,
		transforms: PolicySelectorTransform[],
		index: number
	): MappingNode {
		const operation = transformOperation(transforms[0]?.operation ?? 'copy');
		const parameters = sanitizeTransformParameters(
			operation,
			stringParameters(transforms[0]?.parameters)
		);
		const stableKey = stableRuleKey([rule.id, key, targetNode.id]);
		return {
			id: `policy-transform-${stableKey}`,
			ruleId: `policy-transform-${stableKey}`,
			role: 'transform',
			label: transformSchema(operation).label,
			caption:
				transforms.length > 1
					? `${transformCaption(operation, parameters)} + ${transforms.length - 1}`
					: transformCaption(operation, parameters),
			transformOperation: operation,
			transformParameters: parameters,
			privacy: targetNode.privacy ?? 'Other',
			layoutPosition: {
				x: Number.NaN,
				y: graphBaseTop + (index - 1) * graphStep
			}
		};
	}

	function selectedPolicyRules(): PolicySelectorRule[] {
		const rulesByKey: PolicySelectorRule[] = [];
		for (const rule of [
			...rulesForPolicyOption(selectedSourcePolicy, 'source'),
			...rulesForPolicyOption(selectedDestinationPolicy, 'destination')
		]) {
			const existingIndex = rulesByKey.findIndex((candidate) => candidate.id === rule.id);
			if (existingIndex >= 0) {
				rulesByKey[existingIndex] = rule;
			} else {
				rulesByKey.push(rule);
			}
		}
		return rulesByKey;
	}

	function rulesForPolicyOption(
		option: SelectorOption | null,
		direction: 'source' | 'destination'
	): PolicySelectorRule[] {
		if (!option) return [];
		return (option.rules ?? []).filter((rule) =>
			direction === 'source'
				? rule.ruleKind.includes('source')
				: rule.ruleKind.includes('destination') || rule.ruleKind.includes('release')
		);
	}

	function nodeFromPolicyRef(
		candidates: MappingNode[],
		ref: Record<string, unknown>
	): MappingNode | undefined {
		const nodeId = stringRef(ref, 'nodeId');
		if (nodeId) {
			const exact = candidates.find((node) => node.id === nodeId);
			if (exact) return exact;
		}
		const role = stringRef(ref, 'role');
		const profileId = stringRef(ref, 'profileId');
		const label = stringRef(ref, 'label');
		const path = stringRef(ref, 'path');
		return candidates.find((node) => {
			if (role && node.role !== role) return false;
			if (profileId && node.profileId !== profileId) return false;
			if (label && node.label === label) return true;
			if (path && node.caption === path) return true;
			return false;
		});
	}

	function ruleForPolicyEdge(
		rule: PolicySelectorRule,
		fromNode: MappingNode,
		toNode: MappingNode
	): RuleDetail {
		return {
			...fallbackRule(),
			title: toNode.label,
			risk: toNode.privacy === 'PII' || fromNode.privacy === 'PII' ? 'medium' : 'low',
			source:
				fromNode.role === 'source'
					? `${fromNode.adapter ?? 'source'} / ${fromNode.label}`
					: fromNode.label,
			target: toNode.role === 'target' ? toNode.label : fromNode.label,
			destination:
				toNode.role === 'destination'
					? `${toNode.adapter ?? 'destination'} / ${toNode.label}`
					: $LL.admin_identity_mapping_flow_not_connected(),
			transform: $LL.admin_identity_mapping_flow_not_configured(),
			validation: $LL.admin_identity_mapping_flow_loaded_from({ ruleKey: rule.ruleKey }),
			release: rule.ruleKind.includes('release')
				? $LL.admin_identity_mapping_flow_configured()
				: $LL.admin_identity_mapping_flow_not_configured(),
			trace: $LL.admin_identity_mapping_flow_active_policy_edge_trace({ ruleKey: rule.ruleKey })
		};
	}

	function ruleForPolicyTransform(
		rule: PolicySelectorRule,
		transformNode: MappingNode,
		targetNode: MappingNode
	): RuleDetail {
		return {
			...fallbackRule(),
			title: transformNode.label,
			risk: targetNode.privacy === 'PII' ? 'medium' : 'low',
			source: $LL.admin_identity_mapping_flow_connected_policy_input(),
			target:
				targetNode.role === 'target'
					? targetNode.label
					: $LL.admin_identity_mapping_flow_transform_node(),
			destination:
				targetNode.role === 'destination'
					? `${targetNode.adapter ?? 'destination'} / ${targetNode.label}`
					: $LL.admin_identity_mapping_flow_not_connected(),
			transform: transformNode.caption,
			validation: $LL.admin_identity_mapping_flow_loaded_from({ ruleKey: rule.ruleKey }),
			release: rule.ruleKind.includes('release')
				? $LL.admin_identity_mapping_flow_configured()
				: $LL.admin_identity_mapping_flow_not_configured(),
			trace: $LL.admin_identity_mapping_flow_active_policy_transform_trace({
				ruleKey: rule.ruleKey
			})
		};
	}

	function stringRef(ref: Record<string, unknown>, key: string): string | null {
		const value = ref[key];
		return typeof value === 'string' && value.trim().length > 0 ? value : null;
	}

	function stringParameters(
		value: Record<string, unknown> | undefined
	): Record<string, TransformParameterValue> {
		return Object.fromEntries(
			Object.entries(value ?? {}).flatMap(([key, entry]) =>
				typeof entry === 'string' || typeof entry === 'boolean' ? [[key, entry]] : []
			)
		);
	}

	function destinationProfileOptionsForSample(candidate: MappingSample) {
		const seen: string[] = [];
		return candidate.nodes
			.filter((node) => node.role === 'destination')
			.flatMap((node) => {
				const id = node.profileId ?? node.adapter ?? node.id;
				if (seen.includes(id)) return [];
				seen.push(id);
				return [
					{
						id,
						title: node.profileTitle ?? `${node.adapter ?? 'Destination'} profile`,
						adapter: node.adapter ?? 'CSV'
					}
				];
			});
	}

	function targetGroupKey(node: MappingNode): string {
		return node.uiGroupKey ?? node.uiGroupLabel ?? `ungrouped:${node.id}`;
	}

	function targetGroupLabel(node: MappingNode): string {
		return node.uiGroupLabel ?? node.uiGroupKey ?? 'Other';
	}

	function groupTargetNodes(targets: MappingNode[]): TargetNodeGroup[] {
		const groupKeys: string[] = [];
		const grouped: Record<string, TargetNodeGroup> = {};
		for (const node of targets) {
			const key = targetGroupKey(node);
			if (!grouped[key]) {
				groupKeys.push(key);
				grouped[key] = { key, label: targetGroupLabel(node), nodes: [] };
			}
			grouped[key].nodes.push(node);
		}
		return groupKeys
			.map((key) => grouped[key])
			.filter((group): group is TargetNodeGroup => Boolean(group));
	}

	function isTargetGroupCollapsed(key: string): boolean {
		return collapsedTargetGroupKeys.includes(key);
	}

	function toggleTargetGroup(key: string) {
		collapsedTargetGroupKeys = isTargetGroupCollapsed(key)
			? collapsedTargetGroupKeys.filter((candidate) => candidate !== key)
			: [...collapsedTargetGroupKeys, key];
		clearSelection();
	}

	function targetGroupPosition(index: number, total: number): LayoutNode['targetGroupPosition'] {
		if (total <= 1) return 'single';
		if (index === 0) return 'first';
		if (index === total - 1) return 'last';
		return 'middle';
	}

	function transformSide(node: MappingNode): 'source' | 'destination' {
		if (node.role !== 'transform') return 'source';
		const incoming = edges
			.filter((edge) => edge.to === node.id)
			.map((edge) => nodeById(edge.from)?.role);
		const outgoing = edges
			.filter((edge) => edge.from === node.id)
			.map((edge) => nodeById(edge.to)?.role);
		if (incoming.includes('target') || outgoing.includes('destination')) return 'destination';
		return 'source';
	}

	function buildLayout(): {
		nodes: LayoutNode[];
		targetGroups: LayoutTargetGroup[];
		height: number;
	} {
		const rowTops: Record<string, number> = {};
		const targetPositions: Record<string, LayoutNode['targetGroupPosition']> = {};

		const width = Math.max(180, Math.min(240, canvasWidth * 0.2));
		const sourceLeft = viewMode === 'source' ? Math.max(26, canvasWidth * 0.08) : 26;
		const targetLeft =
			viewMode === 'destination'
				? Math.max(26, canvasWidth * 0.12)
				: viewMode === 'source'
					? Math.min(
							canvasWidth - width - 26,
							Math.max(sourceLeft + width + 100, canvasWidth * 0.66)
						)
					: (canvasWidth - width) / 2;
		const destinationLeft =
			viewMode === 'destination'
				? Math.min(canvasWidth - width - 26, Math.max(targetLeft + width + 100, canvasWidth * 0.72))
				: Math.max(targetLeft + width + 90, canvasWidth - width - 26);
		let cursor = graphBaseTop;
		const targetGroups: LayoutTargetGroup[] = [];

		for (const group of targetNodeGroups) {
			const collapsed = isTargetGroupCollapsed(group.key);
			targetGroups.push({
				key: group.key,
				label: group.label,
				top: cursor,
				left: targetLeft,
				width,
				height: targetGroupHeaderHeight,
				count: group.nodes.length,
				collapsed
			});
			cursor += targetGroupHeaderHeight;
			for (const [index, target] of group.nodes.entries()) {
				rowTops[target.id] = cursor + index * targetGroupRowStep;
				targetPositions[target.id] = targetGroupPosition(index, group.nodes.length);
			}
			if (!collapsed) {
				cursor += group.nodes.length * targetGroupRowStep;
			}
			cursor += targetGroupGap;
		}

		const minHeight = Math.max(520, cursor + 36);
		let visibleSourceOffset = 0;
		const hiddenSourceRowOffsets: Record<string, number> = {};

		const sourceLayout = sourceNodes.map((node) => {
			const selected =
				laneSelectorMode === 'policy' && !selectedSourcePolicyId
					? false
					: node.profileId
						? node.profileId === sample.id
						: node.adapter === sourceAdapter;
			const profileKey = node.profileId ?? node.adapter ?? 'source';
			const visibleOffset = selected ? visibleSourceOffset++ : 0;
			const hiddenRowOffset = hiddenSourceRowOffsets[profileKey] ?? 0;
			hiddenSourceRowOffsets[profileKey] = hiddenRowOffset + 1;
			const hiddenOffset = selected ? 0 : sourceProfileStackIndex(profileKey);
			return {
				...node,
				top: graphBaseTop + (selected ? visibleOffset : hiddenRowOffset) * graphStep,
				left: sourceLeft,
				width,
				height: nodeHeight,
				hidden: !selected,
				stackIndex: hiddenOffset
			};
		});

		const targetLayout = groupedTargetNodes.map((node) => ({
			...node,
			top: rowTops[node.id] ?? graphBaseTop,
			left: targetLeft,
			width,
			height: targetHeight,
			hidden: false,
			stackIndex: 0,
			collapsed: isTargetGroupCollapsed(targetGroupKey(node)),
			targetGroupKey: targetGroupKey(node),
			targetGroupPosition: targetPositions[node.id]
		}));

		const sourceTransformLeft = (sourceLeft + width + targetLeft) / 2 - transformWidth / 2;
		const destinationTransformLeft =
			(targetLeft + width + destinationLeft) / 2 - transformWidth / 2;
		const transformSideOffsets: Record<'source' | 'destination', number> = {
			source: 0,
			destination: 0
		};
		const transformLayout = transformNodes.map((node) => {
			const lane = transformSide(node);
			const laneOffset = transformSideOffsets[lane];
			transformSideOffsets[lane] = laneOffset + 1;
			const left =
				node.layoutPosition && Number.isFinite(node.layoutPosition.x)
					? node.layoutPosition.x
					: lane === 'destination'
						? destinationTransformLeft
						: sourceTransformLeft;
			return {
				...node,
				top: node.layoutPosition?.y ?? graphBaseTop + laneOffset * graphStep,
				left,
				width: transformWidth,
				height: transformHeight,
				hidden: false,
				stackIndex: 0
			};
		});

		let visibleDestinationOffset = 0;
		const hiddenDestinationRowOffsets: Record<string, number> = {};

		const destinationLayout = destinationNodes.map((node) => {
			const selected =
				laneSelectorMode === 'policy' && !selectedDestinationPolicyId
					? false
					: node.profileId
						? node.profileId === selectedDestinationProfileId
						: node.adapter === destinationAdapter;
			const profileKey = node.profileId ?? node.adapter ?? 'destination';
			const visibleOffset = selected ? visibleDestinationOffset++ : 0;
			const hiddenRowOffset = hiddenDestinationRowOffsets[profileKey] ?? 0;
			hiddenDestinationRowOffsets[profileKey] = hiddenRowOffset + 1;
			const hiddenOffset = selected ? 0 : destinationProfileStackIndex(profileKey);
			return {
				...node,
				top: graphBaseTop + (selected ? visibleOffset : hiddenRowOffset) * graphStep,
				left: destinationLeft,
				width,
				height: nodeHeight,
				hidden: !selected,
				stackIndex: hiddenOffset
			};
		});

		const laidOut = [...sourceLayout, ...transformLayout, ...targetLayout, ...destinationLayout];
		return {
			nodes: laidOut,
			targetGroups,
			height: Math.max(
				minHeight,
				...laidOut
					.filter((node) => !node.hidden && !node.collapsed)
					.map((node) => node.top + node.height + 36)
			)
		};
	}

	function laneLabelStyle(role: 'source' | 'canonical' | 'destination'): string {
		const width = Math.max(180, Math.min(240, canvasWidth * 0.2));
		const sourceLeft = viewMode === 'source' ? Math.max(26, canvasWidth * 0.08) : 26;
		const targetLeft =
			viewMode === 'destination'
				? Math.max(26, canvasWidth * 0.12)
				: viewMode === 'source'
					? Math.min(
							canvasWidth - width - 26,
							Math.max(sourceLeft + width + 100, canvasWidth * 0.66)
						)
					: (canvasWidth - width) / 2;
		const destinationLeft =
			viewMode === 'destination'
				? Math.min(canvasWidth - width - 26, Math.max(targetLeft + width + 100, canvasWidth * 0.72))
				: Math.max(targetLeft + width + 90, canvasWidth - width - 26);
		const left =
			role === 'source' ? sourceLeft : role === 'canonical' ? targetLeft : destinationLeft;
		return `left:${left + width / 2}px;width:${width}px;`;
	}

	function sourceProfileStackIndex(profileId: string): number {
		const hiddenIds = sourceProfileOptions
			.map((option) => option.id)
			.filter((id) => id !== sample.id);
		const index = hiddenIds.indexOf(profileId);
		return index >= 0 ? index + 1 : 1;
	}

	function destinationProfileStackIndex(profileId: string): number {
		const hiddenIds = destinationProfileOptions
			.map((option) => option.id)
			.filter((id) => id !== selectedDestinationProfileId);
		const index = hiddenIds.indexOf(profileId);
		return index >= 0 ? index + 1 : 1;
	}

	function nodeStyle(node: LayoutNode): string {
		const stackX = node.hidden ? 12 + node.stackIndex * 8 : 0;
		const stackY = node.hidden ? 7 + node.stackIndex * 6 : 0;
		const interactive =
			node.id === selectedNodeId ||
			node.id === hoverNodeId ||
			connectedNodeIds(selectedNodeId).has(node.id) ||
			connectedNodeIds(hoverNodeId).has(node.id) ||
			invalidEdgeTargetNodeIds.has(node.id) ||
			(dragState?.validTarget === false && dragState.targetNodeId === node.id);
		const zIndex =
			node.id === infoOverlayNodeId
				? 40
				: node.hidden
					? Math.max(1, 4 - node.stackIndex)
					: interactive
						? 8
						: node.role === 'target'
							? 3
							: 5;
		return [
			`left:${node.left}px`,
			`top:${node.top}px`,
			`width:${node.width}px`,
			`min-height:${node.height}px`,
			`z-index:${zIndex}`,
			`--stack-x:${stackX}px`,
			`--stack-y:${stackY}px`,
			`--stack-shadow-x:${22 + node.stackIndex * 8}px`,
			`--stack-shadow-y:${14 + node.stackIndex * 6}px`
		].join(';');
	}

	function nodeInfoPlacement(node: LayoutNode): 'above' | 'below' {
		const minimumReadableSpaceAbove = 96;
		return node.top < minimumReadableSpaceAbove ? 'below' : 'above';
	}

	function transformDeleteStyle(node: LayoutNode): string {
		return [`left:${node.left + node.width - 8}px`, `top:${node.top - 8}px`].join(';');
	}

	function targetGroupStyle(group: LayoutTargetGroup): string {
		return [
			`left:${group.left}px`,
			`top:${group.top}px`,
			`width:${group.width}px`,
			`height:${group.height}px`
		].join(';');
	}

	function edgePoint(node: LayoutNode, direction: 'from' | 'to'): Point {
		if (node.role === 'target' && node.collapsed && node.targetGroupKey) {
			const group = layoutTargetGroupByKey(node.targetGroupKey);
			if (group) {
				return {
					x: direction === 'from' ? group.left + group.width : group.left,
					y: group.top + group.height / 2
				};
			}
		}
		const offset = nodeVisualOffset(node);
		return {
			x: (direction === 'from' ? node.left + node.width : node.left) + offset.x,
			y: node.top + offset.y + node.height / 2
		};
	}

	function nodeVisualOffset(node: LayoutNode): Point {
		if (!node.hidden) return { x: 0, y: 0 };
		return {
			x: 12 + node.stackIndex * 8,
			y: 7 + node.stackIndex * 6
		};
	}

	function pathBetween(from: Point, to: Point): string {
		const dx = to.x - from.x;
		const distance = dx > 0 ? Math.max(8, Math.min(80, dx * 0.45)) : 24;
		return `M ${from.x} ${from.y} C ${from.x + distance} ${from.y}, ${to.x - distance} ${to.y}, ${to.x} ${to.y}`;
	}

	function pointBetween(from: Point, to: Point, t: number): Point {
		const dx = to.x - from.x;
		const distance = dx > 0 ? Math.max(8, Math.min(80, dx * 0.45)) : 24;
		const controlA = { x: from.x + distance, y: from.y };
		const controlB = { x: to.x - distance, y: to.y };
		const inverse = 1 - t;
		return {
			x:
				inverse ** 3 * from.x +
				3 * inverse ** 2 * t * controlA.x +
				3 * inverse * t ** 2 * controlB.x +
				t ** 3 * to.x,
			y:
				inverse ** 3 * from.y +
				3 * inverse ** 2 * t * controlA.y +
				3 * inverse * t ** 2 * controlB.y +
				t ** 3 * to.y
		};
	}

	function edgePath(edge: MappingEdge): string {
		const fromNode = layoutNodeById(edge.from);
		const toNode = layoutNodeById(edge.to);
		if (!fromNode || !toNode) return '';
		return pathBetween(edgePoint(fromNode, 'from'), edgePoint(toNode, 'to'));
	}

	function edgeDeletePoint(edge: MappingEdge): Point | null {
		const fromNode = layoutNodeById(edge.from);
		const toNode = layoutNodeById(edge.to);
		if (!fromNode || !toNode) return null;
		const point = pointBetween(edgePoint(fromNode, 'from'), edgePoint(toNode, 'to'), 0.92);
		return {
			x: point.x,
			y: point.y - 12
		};
	}

	function edgeInsertPoint(edge: MappingEdge): Point | null {
		const fromNode = layoutNodeById(edge.from);
		const toNode = layoutNodeById(edge.to);
		if (!fromNode || !toNode) return null;
		const point = pointBetween(edgePoint(fromNode, 'from'), edgePoint(toNode, 'to'), 0.5);
		return {
			x: point.x,
			y: point.y
		};
	}

	function edgeReconnectPoint(edge: MappingEdge, side: 'source' | 'target'): Point | null {
		const fromNode = layoutNodeById(edge.from);
		const toNode = layoutNodeById(edge.to);
		if (!fromNode || !toNode) return null;
		return side === 'source' ? edgePoint(fromNode, 'from') : edgePoint(toNode, 'to');
	}

	function canInsertTransformNode(edge: MappingEdge): boolean {
		const fromNode = nodeById(edge.from);
		const toNode = nodeById(edge.to);
		if (!fromNode || !toNode) return false;
		if (fromNode.role === 'transform' || toNode.role === 'transform') return false;
		return (
			(fromNode.role === 'source' && toNode.role === 'target') ||
			(fromNode.role === 'target' && toNode.role === 'destination')
		);
	}

	function edgeAccent(edge: MappingEdge): string {
		const adapter = edgeAdapter(edge);
		if (adapter === 'SAML') return 'var(--map-violet)';
		if (adapter === 'OIDC') return 'var(--map-amber)';
		if (adapter === 'SCIM') return 'var(--map-brand)';
		if (adapter === 'CSV') return 'var(--map-teal)';
		return 'var(--map-brand)';
	}

	function edgeAdapter(edge: MappingEdge): MappingAdapter | undefined {
		const fromNode = nodeById(edge.from) ?? layoutNodeById(edge.from);
		const toNode = nodeById(edge.to) ?? layoutNodeById(edge.to);
		if (fromNode?.role === 'source') return fromNode.adapter;
		if (toNode?.role === 'destination') return toNode.adapter;
		const transformNode =
			fromNode?.role === 'transform' ? fromNode : toNode?.role === 'transform' ? toNode : null;
		if (transformNode) {
			if (transformSide(transformNode) === 'destination') {
				return (
					connectedAdapter(transformNode, 'destination') ??
					selectedDestinationPolicy?.adapter ??
					destinationAdapter
				);
			}
			return (
				connectedAdapter(transformNode, 'source') ?? selectedSourcePolicy?.adapter ?? sourceAdapter
			);
		}
		if (edge.destinationSide) return selectedDestinationPolicy?.adapter ?? destinationAdapter;
		return selectedSourcePolicy?.adapter ?? sourceAdapter;
	}

	function connectedAdapter(
		node: MappingNode,
		role: 'source' | 'destination'
	): MappingAdapter | undefined {
		const relatedNodeIds = [node.id, ...connectedGraph(node.id).nodeIds];
		return relatedNodeIds.map((id) => nodeById(id)).find((candidate) => candidate?.role === role)
			?.adapter;
	}

	function edgeClasses(edge: MappingEdge): string {
		const fromNode = layoutNodeById(edge.from);
		const toNode = layoutNodeById(edge.to);
		return [
			'edge',
			isOverviewLayerEdge(edge) ? 'overview-layer-edge' : '',
			edge.destinationSide ? 'destination-edge' : '',
			edge.custom ? 'custom-edge' : '',
			edge.id === activeRuleId ? 'active' : '',
			edge.id === selectedEdgeId ? 'edge-picked' : '',
			hoverEdges.has(edge.id) ? 'edge-connected' : '',
			selectedEdges.has(edge.id) ? 'edge-selected' : '',
			edgeHasTypeMismatch(edge) ? 'edge-invalid' : '',
			fromNode?.hidden || toNode?.hidden ? 'edge-muted' : ''
		]
			.filter(Boolean)
			.join(' ');
	}

	function isOverviewLayerEdge(edge: MappingEdge): boolean {
		return edge.id.startsWith('overview-layer-edge-');
	}

	function nodeVisibleCaption(node: MappingNode): string | null {
		if (!node.caption) return null;
		if (node.role !== 'target' && isTypeOnlyCaption(node.caption)) return null;
		return node.caption;
	}

	function nodeInfoExamples(node: MappingNode): string[] {
		return (node.examples ?? []).slice(0, 3).map(formatNodeInfoValue);
	}

	function nodeInfoNote(node: MappingNode): string | null {
		return node.note?.trim() || null;
	}

	function nodeAllowedValues(node: MappingNode): string[] {
		return node.allowedValues ?? [];
	}

	function nodeMultiplicityLabel(node: MappingNode): string {
		if (node.valueMultiplicity === 'multi')
			return $LL.admin_identity_mapping_flow_multiple_values();
		if (node.valueMultiplicity === 'single') return $LL.admin_identity_mapping_flow_single_value();
		return node.inputCardinality === 'many'
			? $LL.admin_identity_mapping_flow_multiple_values()
			: $LL.admin_identity_mapping_flow_single_value();
	}

	function nodeNullableLabel(node: MappingNode): string {
		if (node.nullable === true) return $LL.admin_identity_mapping_flow_nullable();
		if (node.nullable === false) return $LL.admin_identity_mapping_flow_not_nullable();
		return node.required
			? $LL.admin_identity_mapping_flow_not_nullable_required()
			: $LL.admin_identity_mapping_flow_not_specified();
	}

	function formatNodeInfoValue(value: unknown): string {
		if (value === null) return 'null';
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	function isTypeOnlyCaption(value: string): boolean {
		const normalized = value.trim().toLowerCase();
		return [
			'string',
			'text',
			'email',
			'mail',
			'phone',
			'tel',
			'mobile',
			'boolean',
			'bool',
			'number',
			'integer',
			'int',
			'date',
			'datetime',
			'timestamp',
			'json',
			'object',
			'array',
			'list'
		].includes(normalized);
	}

	function edgeHasTypeMismatch(edge: MappingEdge): boolean {
		const fromNode = nodeById(edge.from);
		const toNode = nodeById(edge.to);
		if (!fromNode || !toNode) return false;
		return isConnectionTypeMismatch(fromNode, toNode) || isConnectionCardinalityMismatch(edge);
	}

	function nodeClasses(node: LayoutNode): string {
		const selectedRelated = connectedNodeIds(selectedNodeId).has(node.id);
		const hoverRelated = connectedNodeIds(hoverNodeId).has(node.id);
		return [
			'graph-node',
			`${node.role}-node`,
			node.role === 'target' ? `cardinality-${targetInputCardinality(node)}` : '',
			node.role === 'target' && node.targetGroupKey ? 'target-grouped-node' : '',
			node.targetGroupPosition ? `target-group-${node.targetGroupPosition}` : '',
			node.locked ? 'locked-node' : '',
			node.hidden ? 'adapter-hidden' : '',
			node.collapsed ? 'collapsed-node' : '',
			node.id === selectedNodeId ? 'active' : '',
			node.id === selectedNodeId ? 'selection-origin' : '',
			dragState?.validTarget === false && dragState.targetNodeId === node.id
				? 'connection-rejected'
				: '',
			invalidEdgeTargetNodeIds.has(node.id) ? 'connection-rejected' : '',
			selectedRelated ? 'selection-related' : '',
			node.id === hoverNodeId ? 'connection-origin' : '',
			hoverRelated ? 'connection-related' : '',
			swappingNodeIds.includes(node.id) ? 'node-swap-enter' : ''
		]
			.filter(Boolean)
			.join(' ');
	}

	function isValidConnection(
		fromNode: MappingNode | undefined,
		toNode: MappingNode | undefined
	): boolean {
		return isConnectionAllowed(fromNode, toNode);
	}

	function isConnectionAllowed(
		fromNode: MappingNode | undefined,
		toNode: MappingNode | undefined,
		ignoredEdgeIds = new Set<string>(),
		extraEdges: MappingEdge[] = []
	): boolean {
		if (!fromNode || !toNode || fromNode.id === toNode.id) return false;
		if (fromNode.locked || toNode.locked) return false;
		return (
			isConnectionDirectionAllowed(fromNode, toNode) &&
			!connectionExists(fromNode.id, toNode.id, ignoredEdgeIds, extraEdges) &&
			!isTargetInputFull(fromNode, toNode, ignoredEdgeIds, extraEdges)
		);
	}

	function isConnectionDirectionAllowed(fromNode: MappingNode, toNode: MappingNode): boolean {
		return (
			(fromNode.role === 'source' && toNode.role === 'target') ||
			(fromNode.role === 'source' && toNode.role === 'transform') ||
			(fromNode.role === 'transform' && toNode.role === 'target') ||
			(fromNode.role === 'target' && toNode.role === 'destination') ||
			(fromNode.role === 'target' && toNode.role === 'transform') ||
			(fromNode.role === 'transform' && toNode.role === 'destination')
		);
	}

	function connectionExists(
		fromNodeId: string,
		toNodeId: string,
		ignoredEdgeIds = new Set<string>(),
		extraEdges: MappingEdge[] = []
	): boolean {
		return [...edges, ...extraEdges].some(
			(edge) => !ignoredEdgeIds.has(edge.id) && edge.from === fromNodeId && edge.to === toNodeId
		);
	}

	function isConnectionTypeMismatch(fromNode: MappingNode, toNode: MappingNode): boolean {
		if (!isConnectionDirectionAllowed(fromNode, toNode)) return false;
		if (toNode.role === 'transform') return !isTypeCompatibleWithTransformInput(fromNode, toNode);
		if (fromNode.role === 'transform') return !isTransformOutputCompatible(fromNode, toNode);
		return !isTypeCompatible(fromNode, toNode) || isValueConstraintMismatch(fromNode, toNode);
	}

	function isValueConstraintMismatch(fromNode: MappingNode, toNode: MappingNode): boolean {
		if (toNode.valueMultiplicity === 'single' && fromNode.valueMultiplicity === 'multi')
			return true;
		const fromAllowed = nodeAllowedValues(fromNode);
		const toAllowed = nodeAllowedValues(toNode);
		if (fromAllowed.length === 0 || toAllowed.length === 0) return false;
		const toAllowedValues = new Set(toAllowed.map((value) => value.toLowerCase()));
		return fromAllowed.some((value) => !toAllowedValues.has(value.toLowerCase()));
	}

	function requiredTransformOperationForNode(node: MappingNode): TransformOperation | null {
		const fieldRef = node.fieldRef;
		if (!fieldRef) return null;
		const namespace = fieldRef.namespace.toLowerCase();
		const identifiers = [
			fieldRef.path,
			fieldRef.catalogEntryId,
			node.label,
			node.caption,
			node.storageTarget
		]
			.filter(Boolean)
			.map((value) => String(value).toLowerCase());
		if (
			namespace === 'oidc.claim' &&
			identifiers.some((value) => value === 'sub' || value.endsWith('.sub'))
		) {
			return 'oidc_pairwise_sub';
		}
		if (
			(namespace === 'saml.attribute' || node.adapter === 'SAML') &&
			identifiers.some(
				(value) =>
					value.includes('edupersontargetedid') || value.includes('1.3.6.1.4.1.5923.1.1.1.10')
			)
		) {
			return 'saml_edu_person_targeted_id';
		}
		return null;
	}

	function isConnectionCardinalityMismatch(edge: MappingEdge): boolean {
		const toNode = nodeById(edge.to);
		if (!toNode) return false;
		if (toNode.role === 'target' && targetInputCardinality(toNode) === 'one') {
			const incoming = targetInputEdges(toNode);
			return incoming.length > 1 && incoming.some((candidate) => candidate.id === edge.id);
		}
		if (toNode.role === 'transform' && transformInputCardinality(toNode) === 'one') {
			const incoming = transformInputEdges(toNode);
			return incoming.length > 1 && incoming.some((candidate) => candidate.id === edge.id);
		}
		return false;
	}

	function targetInputEdges(node: MappingNode): MappingEdge[] {
		return edges.filter((edge) => {
			if (edge.to !== node.id) return false;
			const edgeFromRole = nodeById(edge.from)?.role;
			return edgeFromRole === 'source' || edgeFromRole === 'transform';
		});
	}

	function transformInputEdges(node: MappingNode): MappingEdge[] {
		return edges.filter((edge) => edge.to === node.id && nodeById(edge.from));
	}

	function transformInputCardinality(node: MappingNode): 'one' | 'many' {
		if (node.role !== 'transform') return 'many';
		const operation = activeTransformOperation(node);
		return operation === 'concat' || operation === 'fallback' || operation === 'json_build'
			? 'many'
			: 'one';
	}

	function isTypeCompatibleWithTransformInput(
		fromNode: MappingNode,
		transformNode: MappingNode
	): boolean {
		const fromType = effectiveNodeOutputType(fromNode);
		if (!fromType) return true;
		const operation = activeTransformOperation(transformNode);
		if (operation === 'join' || operation === 'first') return fromType === 'multi-value';
		if (operation === 'split' || operation === 'as_array') return fromType !== 'multi-value';
		if (operation === 'json_extract_text') return fromType === 'json';
		if (operation === 'json_extract_boolean') return fromType === 'json';
		if (operation === 'json_extract_integer') return fromType === 'json';
		if (operation === 'affix_text') {
			return ['text', 'email', 'phone', 'identifier', 'enum', 'locale', 'number'].includes(
				fromType
			);
		}
		if (operation === 'oidc_pairwise_sub') return true;
		if (operation === 'saml_edu_person_targeted_id') return true;
		if (operation === 'text_to_boolean') {
			return ['text', 'email', 'phone', 'identifier', 'enum', 'locale', 'boolean'].includes(
				fromType
			);
		}
		return true;
	}

	function isTransformOutputCompatible(transformNode: MappingNode, toNode: MappingNode): boolean {
		const outputType = transformOutputType(transformNode);
		if (!outputType) return true;
		return isTypeCompatible({ ...transformNode, role: 'source', type: outputType }, toNode);
	}

	function isTargetInputFull(
		fromNode: MappingNode,
		toNode: MappingNode,
		ignoredEdgeIds = new Set<string>(),
		extraEdges: MappingEdge[] = []
	): boolean {
		if (fromNode.role !== 'source' && fromNode.role !== 'transform') return false;
		if (toNode.role !== 'target') return false;
		if (targetInputCardinality(toNode) !== 'one') return false;
		return [...edges, ...extraEdges].some((edge) => {
			if (ignoredEdgeIds.has(edge.id) || edge.to !== toNode.id) return false;
			const edgeFromRole = nodeById(edge.from)?.role;
			return edgeFromRole === 'source' || edgeFromRole === 'transform';
		});
	}

	function targetInputCardinality(node: MappingNode): 'one' | 'many' {
		if (node.role !== 'target') return 'many';
		return (
			node.inputCardinality ?? (normalizeNodeType(node.type) === 'multi-value' ? 'many' : 'one')
		);
	}

	function targetInputCardinalityLabel(node: MappingNode): string {
		return targetInputCardinality(node) === 'one' ? '1' : 'N';
	}

	function isTypeCompatible(fromNode: MappingNode, toNode: MappingNode): boolean {
		const fromType = effectiveNodeOutputType(fromNode);
		const toType = normalizeNodeType(toNode.type);
		if (!fromType || !toType) return true;
		if (fromType === toType) return true;
		if (toType === 'text')
			return ['text', 'email', 'phone', 'identifier', 'enum', 'locale'].includes(fromType);
		if (fromType === 'text') return ['text', 'identifier', 'locale'].includes(toType);
		if (toType === 'identifier') return ['identifier', 'text'].includes(fromType);
		if (toType === 'boolean') return fromType === 'boolean';
		if (toType === 'number') return fromType === 'number';
		if (toType === 'enum') return fromType === 'enum';
		if (toType === 'multi-value') return fromType === 'multi-value';
		if (toType === 'json') return fromType === 'json';
		return false;
	}

	function effectiveNodeOutputType(node: MappingNode | undefined): string | null {
		if (!node) return null;
		if (node.role === 'transform') return transformOutputType(node);
		return normalizeNodeType(node.type);
	}

	function transformOutputType(node: MappingNode): string | null {
		const operation = activeTransformOperation(node);
		if (operation === 'text_to_boolean' || operation === 'json_extract_boolean') return 'boolean';
		if (operation === 'json_extract_integer') return 'number';
		if (operation === 'split' || operation === 'as_array') return 'multi-value';
		if (
			operation === 'json_extract_text' ||
			operation === 'concat' ||
			operation === 'join' ||
			operation === 'affix_text' ||
			operation === 'oidc_pairwise_sub' ||
			operation === 'saml_edu_person_targeted_id'
		)
			return 'text';
		if (operation === 'json_build') return 'json';
		if (operation === 'first') return 'text';
		return firstTransformInputType(node);
	}

	function firstTransformInputType(node: MappingNode): string | null {
		for (const edge of transformInputEdges(node)) {
			const type = effectiveNodeOutputType(nodeById(edge.from));
			if (type) return type;
		}
		return null;
	}

	function normalizeNodeType(type: string | undefined): string | null {
		const normalized = type?.toLowerCase().trim();
		if (!normalized) return null;
		if (normalized === 'transform') return null;
		if (normalized.includes('boolean') || normalized.includes('bool')) return 'boolean';
		if (
			normalized.includes('number') ||
			normalized.includes('integer') ||
			normalized.includes('float') ||
			normalized.includes('double')
		) {
			return 'number';
		}
		if (['string', 'text', 'name'].some((needle) => normalized.includes(needle))) return 'text';
		if (normalized.includes('email') || normalized.includes('mail')) return 'email';
		if (
			normalized.includes('phone') ||
			normalized.includes('tel') ||
			normalized.includes('mobile')
		) {
			return 'phone';
		}
		if (normalized.includes('stable identifier') || normalized.includes('identifier'))
			return 'identifier';
		if (
			normalized.includes('multi') ||
			normalized.includes('array') ||
			normalized.includes('list')
		) {
			return 'multi-value';
		}
		if (normalized.includes('json') || normalized.includes('object')) return 'json';
		if (normalized.includes('enum')) return 'enum';
		if (normalized.includes('locale') || normalized.includes('timezone')) return 'locale';
		return normalized;
	}

	function connectionTargetForClientPoint(point: Point): MappingNode | undefined {
		const target = document.elementFromPoint(point.x, point.y) as HTMLElement | null;
		const handle = target?.closest?.('.node-handle.input') as HTMLElement | null;
		const nodeElement = target?.closest?.('.graph-node') as HTMLElement | null;
		const toNodeId = handle?.dataset.nodeId ?? nodeElement?.dataset.nodeId;
		return toNodeId ? nodeById(toNodeId) : undefined;
	}

	function connectionTargetForPointer(event: PointerEvent): MappingNode | undefined {
		return connectionTargetForClientPoint({ x: event.clientX, y: event.clientY });
	}

	function canvasPointForClientPoint(point: Point): Point {
		const rect = canvas.getBoundingClientRect();
		return {
			x: point.x - rect.left,
			y: point.y - rect.top
		};
	}

	function canvasPoint(event: PointerEvent): Point {
		return canvasPointForClientPoint({ x: event.clientX, y: event.clientY });
	}

	function scrollableCanvasAncestor(): HTMLElement | null {
		let element = canvas?.parentElement;
		while (element && element !== document.body && element !== document.documentElement) {
			const style = getComputedStyle(element);
			const scrollableY = ['auto', 'scroll', 'overlay'].includes(style.overflowY);
			if (scrollableY && element.scrollHeight > element.clientHeight) return element;
			element = element.parentElement;
		}
		return null;
	}

	function edgeDragAutoScrollDelta(pointerY: number, top: number, bottom: number): number {
		if (pointerY < top + connectionAutoScrollMargin) {
			const ratio = Math.min(
				1,
				(top + connectionAutoScrollMargin - pointerY) / connectionAutoScrollMargin
			);
			return -Math.ceil(connectionAutoScrollMinSpeed + ratio * connectionAutoScrollMaxSpeed);
		}
		if (pointerY > bottom - connectionAutoScrollMargin) {
			const ratio = Math.min(
				1,
				(pointerY - (bottom - connectionAutoScrollMargin)) / connectionAutoScrollMargin
			);
			return Math.ceil(connectionAutoScrollMinSpeed + ratio * connectionAutoScrollMaxSpeed);
		}
		return 0;
	}

	function updateDragStateForClientPoint(clientPoint: Point) {
		if (!dragState) return;
		const toNode = connectionTargetForClientPoint(clientPoint);
		const canvasTargetPoint = canvasPointForClientPoint(clientPoint);
		if (dragState.reconnectEdgeId && dragState.reconnectSide === 'source') {
			const fixedToNode = nodeById(dragState.fixedNodeId ?? '');
			const fixedToLayout = fixedToNode ? layoutNodeById(fixedToNode.id) : undefined;
			dragState = {
				...dragState,
				from: canvasTargetPoint,
				to: fixedToLayout ? edgePoint(fixedToLayout, 'to') : dragState.to,
				validTarget: toNode
					? isValidConnectionForReconnect(toNode, fixedToNode, new Set([dragState.reconnectEdgeId]))
					: null,
				targetNodeId: toNode?.id ?? null
			};
			return;
		}
		if (dragState.reconnectEdgeId && dragState.reconnectSide === 'target') {
			const fixedFromNode = nodeById(dragState.fixedNodeId ?? '');
			const fixedFromLayout = fixedFromNode ? layoutNodeById(fixedFromNode.id) : undefined;
			dragState = {
				...dragState,
				from: fixedFromLayout ? edgePoint(fixedFromLayout, 'from') : dragState.from,
				to: canvasTargetPoint,
				validTarget: toNode
					? isValidConnectionForReconnect(
							fixedFromNode,
							toNode,
							new Set([dragState.reconnectEdgeId])
						)
					: null,
				targetNodeId: toNode?.id ?? null
			};
			return;
		}
		const fromNode = nodeById(dragState.fromNodeId);
		dragState = {
			...dragState,
			to: canvasTargetPoint,
			validTarget: toNode ? isValidConnection(fromNode, toNode) : null,
			targetNodeId: toNode?.id ?? null
		};
	}

	function runConnectionAutoScroll() {
		connectionAutoScrollFrame = null;
		if (!dragState || !connectionDragPointer) return;

		let didScroll = false;
		const scrollContainer = scrollableCanvasAncestor();
		if (scrollContainer) {
			const rect = scrollContainer.getBoundingClientRect();
			const delta = edgeDragAutoScrollDelta(connectionDragPointer.y, rect.top, rect.bottom);
			if (delta !== 0) {
				const before = scrollContainer.scrollTop;
				scrollContainer.scrollTop += delta;
				didScroll = scrollContainer.scrollTop !== before;
			}
		}

		if (!didScroll) {
			const maxWindowScroll = document.documentElement.scrollHeight - window.innerHeight;
			const delta = edgeDragAutoScrollDelta(connectionDragPointer.y, 0, window.innerHeight);
			if (delta !== 0 && window.scrollY >= 0 && window.scrollY <= maxWindowScroll) {
				const before = window.scrollY;
				window.scrollBy({ top: delta, left: 0, behavior: 'instant' });
				didScroll = window.scrollY !== before;
			}
		}

		if (didScroll) updateDragStateForClientPoint(connectionDragPointer);
		if (dragState && connectionDragPointer) {
			connectionAutoScrollFrame = requestAnimationFrame(runConnectionAutoScroll);
		}
	}

	function updateConnectionAutoScrollPointer(event: PointerEvent) {
		connectionDragPointer = { x: event.clientX, y: event.clientY };
		if (connectionAutoScrollFrame === null) {
			connectionAutoScrollFrame = requestAnimationFrame(runConnectionAutoScroll);
		}
	}

	function stopConnectionAutoScroll() {
		connectionDragPointer = null;
		if (connectionAutoScrollFrame !== null) {
			cancelAnimationFrame(connectionAutoScrollFrame);
			connectionAutoScrollFrame = null;
		}
	}

	function startConnectionDrag(event: PointerEvent, node: LayoutNode) {
		if (!editable || node.hidden || node.locked || node.role === 'destination') return;
		event.preventDefault();
		event.stopPropagation();
		pendingConnectionStart = null;
		const from = edgePoint(node, 'from');
		dragState = {
			fromNodeId: node.id,
			from,
			to: canvasPoint(event),
			validTarget: null,
			targetNodeId: null
		};
		updateConnectionAutoScrollPointer(event);
		window.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('pointerup', handlePointerUp);
	}

	function startEasyConnectionDrag(event: PointerEvent, node: LayoutNode) {
		if (
			!editable ||
			node.hidden ||
			node.locked ||
			node.role === 'destination' ||
			event.button !== 0
		)
			return;
		if ((event.target as HTMLElement | null)?.closest('.node-handle')) return;
		pendingConnectionStart = {
			fromNodeId: node.id,
			startClient: { x: event.clientX, y: event.clientY },
			from: edgePoint(node, 'from')
		};
		window.addEventListener('pointermove', handleEasyConnectionPointerMove);
		window.addEventListener('pointerup', handleEasyConnectionPointerUp);
	}

	function handleEasyConnectionPointerMove(event: PointerEvent) {
		if (!pendingConnectionStart) return;
		const moved =
			Math.abs(event.clientX - pendingConnectionStart.startClient.x) +
			Math.abs(event.clientY - pendingConnectionStart.startClient.y);
		if (moved < 6) return;
		event.preventDefault();
		dragState = {
			fromNodeId: pendingConnectionStart.fromNodeId,
			from: pendingConnectionStart.from,
			to: canvasPoint(event),
			validTarget: null,
			targetNodeId: null
		};
		suppressNextNodeClickId = pendingConnectionStart.fromNodeId;
		pendingConnectionStart = null;
		window.removeEventListener('pointermove', handleEasyConnectionPointerMove);
		window.removeEventListener('pointerup', handleEasyConnectionPointerUp);
		window.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('pointerup', handlePointerUp);
		handlePointerMove(event);
	}

	function handleEasyConnectionPointerUp() {
		pendingConnectionStart = null;
		window.removeEventListener('pointermove', handleEasyConnectionPointerMove);
		window.removeEventListener('pointerup', handleEasyConnectionPointerUp);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!dragState) return;
		updateConnectionAutoScrollPointer(event);
		updateDragStateForClientPoint({ x: event.clientX, y: event.clientY });
	}

	function handlePointerUp(event: PointerEvent) {
		if (!dragState) {
			stopConnectionAutoScroll();
			return;
		}
		const reconnectState = dragState;
		const fromNode = nodeById(dragState.fromNodeId);
		const toNode = connectionTargetForPointer(event);
		if (reconnectState.reconnectEdgeId && reconnectState.reconnectSide && toNode) {
			reconnectEdge(reconnectState.reconnectEdgeId, reconnectState.reconnectSide, toNode.id);
			suppressCanvasClearOnce();
		} else if (isValidConnection(fromNode, toNode) && toNode) {
			addEdge(dragState.fromNodeId, toNode.id);
			suppressCanvasClearOnce();
		}
		dragState = null;
		stopConnectionAutoScroll();
		window.removeEventListener('pointermove', handlePointerMove);
		window.removeEventListener('pointerup', handlePointerUp);
	}

	function addEdge(from: string, to: string) {
		if (!editable) return;
		if (!isValidConnection(nodeById(from), nodeById(to))) return;
		if (connectionExists(from, to)) return;
		customCounter += 1;
		const edge = {
			id: `custom-edge-${customCounter}`,
			from,
			to,
			destinationSide: nodeById(from)?.role === 'target',
			custom: true
		};
		edges = [...edges, edge];
		selectedEdgeId = edge.id;
		selectedNodeId = null;
		dryRunResults = {};
		markDraftDirty();
	}

	function startReconnectDrag(event: PointerEvent, edge: MappingEdge, side: 'source' | 'target') {
		if (!editable || event.button !== 0) return;
		const fromNode = layoutNodeById(edge.from);
		const toNode = layoutNodeById(edge.to);
		if (!fromNode || !toNode) return;
		event.preventDefault();
		event.stopPropagation();
		selectedEdgeId = edge.id;
		selectedNodeId = null;
		dryRunResults = {};
		pendingConnectionStart = null;
		dragState = {
			fromNodeId: edge.from,
			from: side === 'source' ? canvasPoint(event) : edgePoint(fromNode, 'from'),
			to: side === 'source' ? edgePoint(toNode, 'to') : canvasPoint(event),
			validTarget: null,
			targetNodeId: null,
			reconnectEdgeId: edge.id,
			reconnectSide: side,
			fixedNodeId: side === 'source' ? edge.to : edge.from
		};
		updateConnectionAutoScrollPointer(event);
		window.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('pointerup', handlePointerUp);
	}

	function reconnectEdge(edgeId: string, side: 'source' | 'target', candidateNodeId: string) {
		const edge = edges.find((candidate) => candidate.id === edgeId);
		if (!edge) return;
		const fromNode = side === 'source' ? nodeById(candidateNodeId) : nodeById(edge.from);
		const toNode = side === 'target' ? nodeById(candidateNodeId) : nodeById(edge.to);
		if (!isValidConnectionForReconnect(fromNode, toNode, new Set([edgeId]))) return;
		edges = edges.map((candidate) =>
			candidate.id === edgeId
				? {
						...candidate,
						from: side === 'source' ? candidateNodeId : candidate.from,
						to: side === 'target' ? candidateNodeId : candidate.to,
						destinationSide:
							side === 'source'
								? nodeById(candidateNodeId)?.role === 'target'
								: candidate.destinationSide,
						custom: true
					}
				: candidate
		);
		selectedEdgeId = edgeId;
		selectedNodeId = null;
		dryRunResults = {};
		markDraftDirty();
	}

	function addTransformNode(edge: MappingEdge) {
		if (!editable || !canInsertTransformNode(edge)) return;
		const fromNode = layoutNodeById(edge.from);
		const toNode = layoutNodeById(edge.to);
		if (!fromNode || !toNode) return;
		customCounter += 1;
		const insertPoint = pointBetween(edgePoint(fromNode, 'from'), edgePoint(toNode, 'to'), 0.5);
		const nodeId = `transform-node-${customCounter}`;
		const ruleId = `transform-rule-${customCounter}`;
		const operation: TransformOperation = requiredTransformOperationForNode(toNode) ?? 'copy';
		const parameters = defaultTransformParameters(operation);
		const transformNode: MappingNode = {
			id: nodeId,
			ruleId,
			role: 'transform',
			label: `Transform ${customCounter}`,
			caption: transformCaption(operation, parameters),
			transformOperation: operation,
			transformParameters: parameters,
			privacy: 'Other',
			layoutPosition: {
				x: insertPoint.x - transformWidth / 2,
				y: insertPoint.y - transformHeight / 2
			}
		};
		nodes = [...nodes, transformNode];
		edges = [
			...edges.filter((candidate) => candidate.id !== edge.id),
			{
				id: `${edge.id}-in-${customCounter}`,
				from: edge.from,
				to: nodeId,
				destinationSide: edge.destinationSide,
				custom: true
			},
			{
				id: `${edge.id}-out-${customCounter}`,
				from: nodeId,
				to: edge.to,
				destinationSide: edge.destinationSide,
				custom: true
			}
		];
		sample.rules[ruleId] = {
			...fallbackRule(),
			title: transformNode.label,
			source: $LL.admin_identity_mapping_flow_inserted_edge_source(),
			target: $LL.admin_identity_mapping_flow_transform_node(),
			destination: $LL.admin_identity_mapping_flow_continues_original_target(),
			transform: transformSummary(operation, parameters),
			validation: $LL.admin_identity_mapping_flow_transform_inserted_validation(),
			trace: $LL.admin_identity_mapping_flow_transform_inserted_trace()
		};
		activeRuleId = ruleId;
		selectedNodeId = nodeId;
		selectedEdgeId = null;
		dryRunResults = {};
		markDraftDirty();
	}

	function deleteSelectedEdge() {
		if (!editable || !selectedEdgeId) return;
		deleteEdge(selectedEdgeId);
	}

	function deleteEdge(edgeId: string) {
		if (!editable) return;
		const edge = edges.find((candidate) => candidate.id === edgeId);
		if (!edge) return;
		const fromNode = nodeById(edge.from);
		const toNode = nodeById(edge.to);
		const transformNode =
			fromNode?.role === 'transform' ? fromNode : toNode?.role === 'transform' ? toNode : null;

		if (transformNode) {
			const incoming = edges.filter((candidate) => candidate.to === transformNode.id);
			const outgoing = edges.filter((candidate) => candidate.from === transformNode.id);
			const removesLastInput = edge.to === transformNode.id && incoming.length <= 1;
			const removesLastOutput = edge.from === transformNode.id && outgoing.length <= 1;

			if (removesLastInput || removesLastOutput) {
				deleteTransformNodeWithoutReconnect(transformNode.id);
				return;
			}
		}

		edges = edges.filter((candidate) => candidate.id !== edgeId);
		selectedEdgeId = null;
		dryRunResults = {};
		markDraftDirty();
	}

	function deleteTransformNodeWithoutReconnect(nodeId: string) {
		const transformNode = nodeById(nodeId);
		if (transformNode?.role !== 'transform') return;
		nodes = nodes.filter((node) => node.id !== nodeId);
		edges = edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
		if (selectedNodeId === nodeId) {
			selectedNodeId = null;
			activeRuleId = sample.activeRuleId;
		}
		selectedEdgeId = null;
		hoverNodeId = null;
		dryRunResults = {};
		markDraftDirty();
	}

	function deleteTransformNode(nodeId: string) {
		if (!editable) return;
		const transformNode = nodeById(nodeId);
		if (transformNode?.role !== 'transform') return;
		const incoming = edges.filter((edge) => edge.to === nodeId);
		const outgoing = edges.filter((edge) => edge.from === nodeId);
		const reconnectedEdges: MappingEdge[] = [];

		for (const inEdge of incoming) {
			for (const outEdge of outgoing) {
				const fromNode = nodeById(inEdge.from);
				const toNode = nodeById(outEdge.to);
				if (
					!isValidConnectionForReconnect(
						fromNode,
						toNode,
						new Set([inEdge.id, outEdge.id]),
						reconnectedEdges
					)
				) {
					continue;
				}
				if (
					edges.some((edge) => edge.from === inEdge.from && edge.to === outEdge.to) ||
					reconnectedEdges.some((edge) => edge.from === inEdge.from && edge.to === outEdge.to)
				) {
					continue;
				}
				customCounter += 1;
				reconnectedEdges.push({
					id: `transform-reconnect-${customCounter}`,
					from: inEdge.from,
					to: outEdge.to,
					destinationSide: outEdge.destinationSide || inEdge.destinationSide,
					custom: true
				});
			}
		}

		nodes = nodes.filter((node) => node.id !== nodeId);
		edges = [
			...edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
			...reconnectedEdges
		];
		if (selectedNodeId === nodeId) {
			selectedNodeId = null;
			activeRuleId = sample.activeRuleId;
		}
		selectedEdgeId = null;
		hoverNodeId = null;
		dryRunResults = {};
		markDraftDirty();
	}

	function deleteSelectedTransformNode() {
		if (!selectedNodeId) return;
		deleteTransformNode(selectedNodeId);
	}

	function isValidConnectionForReconnect(
		fromNode: MappingNode | undefined,
		toNode: MappingNode | undefined,
		ignoredEdgeIds = new Set<string>(),
		extraEdges: MappingEdge[] = []
	): boolean {
		return isConnectionAllowed(fromNode, toNode, ignoredEdgeIds, extraEdges);
	}

	function handleGlobalKeyDown(event: KeyboardEvent) {
		if (
			!editable ||
			(!selectedEdgeId && nodeById(selectedNodeId ?? '')?.role !== 'transform') ||
			(event.key !== 'Backspace' && event.key !== 'Delete')
		) {
			return;
		}
		const target = event.target as HTMLElement | null;
		if (
			target?.closest('input, textarea, select, [contenteditable="true"]') ||
			target?.isContentEditable
		) {
			return;
		}
		event.preventDefault();
		if (selectedEdgeId) {
			deleteSelectedEdge();
		} else {
			deleteSelectedTransformNode();
		}
	}

	function selectSample(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		const nextId = select.value;
		if (nextId === selectedSampleId) return;
		if (
			hasUnsavedDraftChanges &&
			!window.confirm($LL.admin_identity_mapping_flow_unsaved_switch_confirm())
		) {
			select.value = selectedSampleId ?? emptySample.id;
			return;
		}
		selectedSampleId = nextId;
		animateNextSampleSourceNodes = true;
	}

	function selectDestinationProfile(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		selectedDestinationProfileId = select.value;
		destinationAdapter =
			destinationProfileOptions.find((option) => option.id === selectedDestinationProfileId)
				?.adapter ?? destinationAdapter;
		animateVisibleNodeSwap('destination');
	}

	function selectSourcePolicy(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		applySourcePolicySelection(select.value || null);
	}

	function applySourcePolicySelection(optionId: string | null) {
		selectedSourcePolicyId = optionId;
		const selectedPolicy = sourcePolicyOptions.find(
			(option: SelectorOption) => option.id === selectedSourcePolicyId
		);
		const sourceProfileId = selectedPolicy?.sourceProfileIds?.find((id: string) =>
			samples.some((candidate: MappingSample) => candidate.id === id)
		);
		const sampleWillChange = Boolean(sourceProfileId && activeSampleRef?.id !== sourceProfileId);
		if (sampleWillChange) {
			animateNextSampleSourceNodes = true;
		}
		selectedSampleId = sourceProfileId ?? null;
		if (activeSampleRef && (!sourceProfileId || activeSampleRef.id === sourceProfileId)) {
			applyPolicyGraph(activeSampleRef);
		}
		if (!sampleWillChange) {
			animateVisibleNodeSwap('source');
		}
	}

	function selectDestinationPolicy(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		applyDestinationPolicySelection(select.value || null);
	}

	function applyDestinationPolicySelection(optionId: string | null) {
		selectedDestinationPolicyId = optionId;
		const selectedPolicy = destinationPolicyOptions.find(
			(option: SelectorOption) => option.id === selectedDestinationPolicyId
		);
		const destinationProfileId = selectedPolicy?.destinationProfileIds?.find((id: string) =>
			destinationProfileOptions.some((option) => option.id === id)
		);
		selectedDestinationProfileId = destinationProfileId ?? null;
		if (activeSampleRef) {
			applyPolicyGraph(activeSampleRef);
		}
		animateVisibleNodeSwap('destination');
	}

	function addNode(role: 'source' | 'destination') {
		if (!editable) return;
		customCounter += 1;
		const adapter = role === 'source' ? sourceAdapter : destinationAdapter;
		const node: MappingNode = {
			id: `${role}-${adapter.toLowerCase()}-custom-${customCounter}`,
			ruleId: `custom-${role}-${adapter.toLowerCase()}-${customCounter}`,
			role,
			adapter,
			label: role === 'source' ? `custom_field_${customCounter}` : `${adapter} custom projection`,
			caption: 'drag handle to connect'
		};
		nodes = [...nodes, node];
		markDraftDirty();
		sample.rules[node.ruleId] = {
			...fallbackRule(),
			title: node.label,
			source:
				role === 'source'
					? `${adapter} adapter / ${node.label}`
					: $LL.admin_identity_mapping_flow_custom_graph_edge(),
			destination:
				role === 'destination'
					? `${adapter} adapter / ${node.label}`
					: $LL.admin_identity_mapping_flow_not_connected_yet(),
			trace: $LL.admin_identity_mapping_flow_custom_node_trace()
		};
		selectRule(node.ruleId);
	}

	function transformSchema(operation: TransformOperation): TransformOperationSchema {
		return (
			transformOperationSchemas.find((schema) => schema.operation === operation) ??
			transformOperationSchemas[0]
		);
	}

	function transformOperation(value: string): TransformOperation {
		return transformOperationSchemas.some((schema) => schema.operation === value)
			? (value as TransformOperation)
			: 'copy';
	}

	function activeTransformOperation(node: MappingNode): TransformOperation {
		return transformOperation(node.transformOperation ?? 'copy');
	}

	function activeTransformSchema(node: MappingNode): TransformOperationSchema {
		return transformSchema(activeTransformOperation(node));
	}

	function transformOperationCategoryForOperation(
		operation: TransformOperation
	): TransformOperationCategory {
		return (
			transformOperationCategories.find((category) => category.operations.includes(operation)) ??
			transformOperationCategories[0]
		);
	}

	function activeTransformOperationCategory(node: MappingNode): TransformOperationCategory {
		return transformOperationCategoryForOperation(activeTransformOperation(node));
	}

	function transformOperationCategoryLabel(categoryId: TransformOperationCategoryId): string {
		const ja = getLocale() === 'ja';
		switch (categoryId) {
			case 'basic':
				return ja ? '基本' : 'Basic';
			case 'array':
				return ja ? '配列' : 'Array';
			case 'text':
				return ja ? 'テキスト' : 'Text';
			case 'identifier':
				return ja ? '識別子' : 'Identifier';
			case 'json':
				return 'JSON';
		}
	}

	function transformOperationCategoryFieldLabel(): string {
		return getLocale() === 'ja' ? 'カテゴリ' : 'Category';
	}

	function transformOperationOptionsForCategory(
		category: TransformOperationCategory
	): TransformOperationSchema[] {
		return category.operations.map(transformSchema);
	}

	function transformOperationLabel(operation: TransformOperation): string {
		switch (operation) {
			case 'copy':
				return $LL.admin_identity_mapping_flow_transform_copy_label();
			case 'as_array':
				return $LL.admin_identity_mapping_flow_transform_as_array_label();
			case 'split':
				return $LL.admin_identity_mapping_flow_transform_split_label();
			case 'join':
				return $LL.admin_identity_mapping_flow_transform_join_label();
			case 'first':
				return $LL.admin_identity_mapping_flow_transform_first_label();
			case 'oidc_pairwise_sub':
				return $LL.admin_identity_mapping_flow_transform_oidc_pairwise_sub_label();
			case 'saml_edu_person_targeted_id':
				return $LL.admin_identity_mapping_flow_transform_saml_edu_person_targeted_id_label();
			case 'affix_text':
				return $LL.admin_identity_mapping_flow_transform_affix_text_label();
			case 'trim':
				return $LL.admin_identity_mapping_flow_transform_trim_label();
			case 'normalize':
				return $LL.admin_identity_mapping_flow_transform_normalize_label();
			case 'case':
				return $LL.admin_identity_mapping_flow_transform_case_label();
			case 'concat':
				return $LL.admin_identity_mapping_flow_transform_concat_label();
			case 'fallback':
				return $LL.admin_identity_mapping_flow_transform_fallback_label();
			case 'text_to_boolean':
				return $LL.admin_identity_mapping_flow_transform_text_to_boolean_label();
			case 'json_build':
				return $LL.admin_identity_mapping_flow_transform_json_build_label();
			case 'json_extract_text':
				return $LL.admin_identity_mapping_flow_transform_json_extract_text_label();
			case 'json_extract_boolean':
				return $LL.admin_identity_mapping_flow_transform_json_extract_boolean_label();
			case 'json_extract_integer':
				return $LL.admin_identity_mapping_flow_transform_json_extract_integer_label();
		}
	}

	function transformOperationDescription(operation: TransformOperation): string {
		switch (operation) {
			case 'copy':
				return $LL.admin_identity_mapping_flow_transform_copy_desc();
			case 'as_array':
				return $LL.admin_identity_mapping_flow_transform_as_array_desc();
			case 'split':
				return $LL.admin_identity_mapping_flow_transform_split_desc();
			case 'join':
				return $LL.admin_identity_mapping_flow_transform_join_desc();
			case 'first':
				return $LL.admin_identity_mapping_flow_transform_first_desc();
			case 'oidc_pairwise_sub':
				return $LL.admin_identity_mapping_flow_transform_oidc_pairwise_sub_desc();
			case 'saml_edu_person_targeted_id':
				return $LL.admin_identity_mapping_flow_transform_saml_edu_person_targeted_id_desc();
			case 'affix_text':
				return $LL.admin_identity_mapping_flow_transform_affix_text_desc();
			case 'trim':
				return $LL.admin_identity_mapping_flow_transform_trim_desc();
			case 'normalize':
				return $LL.admin_identity_mapping_flow_transform_normalize_desc();
			case 'case':
				return $LL.admin_identity_mapping_flow_transform_case_desc();
			case 'concat':
				return $LL.admin_identity_mapping_flow_transform_concat_desc();
			case 'fallback':
				return $LL.admin_identity_mapping_flow_transform_fallback_desc();
			case 'text_to_boolean':
				return $LL.admin_identity_mapping_flow_transform_text_to_boolean_desc();
			case 'json_build':
				return $LL.admin_identity_mapping_flow_transform_json_build_desc();
			case 'json_extract_text':
				return $LL.admin_identity_mapping_flow_transform_json_extract_text_desc();
			case 'json_extract_boolean':
				return $LL.admin_identity_mapping_flow_transform_json_extract_boolean_desc();
			case 'json_extract_integer':
				return $LL.admin_identity_mapping_flow_transform_json_extract_integer_desc();
		}
	}

	function transformParameterLabel(parameter: TransformParameterSchema): string {
		switch (parameter.name) {
			case 'mode':
				return $LL.admin_identity_mapping_flow_transform_param_mode();
			case 'delimiter':
				return $LL.admin_identity_mapping_flow_transform_param_delimiter();
			case 'trimItems':
				return $LL.admin_identity_mapping_flow_transform_param_trim_items();
			case 'omitEmpty':
				return $LL.admin_identity_mapping_flow_transform_param_omit_empty();
			case 'unique':
				return $LL.admin_identity_mapping_flow_transform_param_unique();
			case 'persistentIdentifierProfileId':
				return $LL.admin_identity_mapping_flow_transform_param_persistent_identifier_profile();
			case 'prefix':
				return $LL.admin_identity_mapping_flow_transform_param_prefix();
			case 'suffix':
				return $LL.admin_identity_mapping_flow_transform_param_suffix();
			case 'trueValues':
				return $LL.admin_identity_mapping_flow_transform_param_true_values();
			case 'falseValues':
				return $LL.admin_identity_mapping_flow_transform_param_false_values();
			case 'nullValues':
				return $LL.admin_identity_mapping_flow_transform_param_null_values();
			case 'keyMap':
				return $LL.admin_identity_mapping_flow_transform_param_key_map();
			case 'nullHandling':
				return $LL.admin_identity_mapping_flow_transform_param_null_handling();
			case 'path':
				return $LL.admin_identity_mapping_flow_transform_param_json_path();
			default:
				return parameter.label;
		}
	}

	function persistentIdentifierProfileOptions(operation: TransformOperation) {
		const usage =
			operation === 'oidc_pairwise_sub'
				? 'oidc_pairwise_sub'
				: operation === 'saml_edu_person_targeted_id'
					? 'saml_edu_person_targeted_id'
					: null;
		const protocol =
			operation === 'oidc_pairwise_sub'
				? 'oidc'
				: operation === 'saml_edu_person_targeted_id'
					? 'saml'
					: null;
		return persistentIdentifierProfiles.filter((profile) => {
			const usageMatches = !usage || profile.usage.length === 0 || profile.usage.includes(usage);
			const protocolMatches =
				!protocol || profile.protocolScope === 'any' || profile.protocolScope === protocol;
			return usageMatches && protocolMatches;
		});
	}

	function transformOptionLabel(parameterName: string, value: string, fallback: string): string {
		if (parameterName === 'mode') {
			if (value === 'whitespace')
				return $LL.admin_identity_mapping_flow_transform_option_whitespace();
			if (value === 'unicode')
				return $LL.admin_identity_mapping_flow_transform_option_unicode_nfkc();
			if (value === 'lower') return $LL.admin_identity_mapping_flow_transform_option_lowercase();
			if (value === 'upper') return $LL.admin_identity_mapping_flow_transform_option_uppercase();
			if (value === 'title') return $LL.admin_identity_mapping_flow_transform_option_title_case();
		}
		if (parameterName === 'nullHandling') {
			if (value === 'omit') return $LL.admin_identity_mapping_flow_transform_option_omit_empty();
			if (value === 'include_null')
				return $LL.admin_identity_mapping_flow_transform_option_include_null();
		}
		return fallback;
	}

	function defaultTransformParameters(
		operation: TransformOperation
	): Record<string, TransformParameterValue> {
		if (operation === 'as_array') return { trimItems: true, omitEmpty: true, unique: false };
		if (operation === 'split')
			return { delimiter: ',', trimItems: true, omitEmpty: true, unique: false };
		if (operation === 'join')
			return { delimiter: ',', trimItems: true, omitEmpty: true, unique: false };
		if (operation === 'first') return { trimItems: true, omitEmpty: true };
		if (operation === 'oidc_pairwise_sub' || operation === 'saml_edu_person_targeted_id') {
			return { persistentIdentifierProfileId: '' };
		}
		if (operation === 'affix_text') return { prefix: '', suffix: '' };
		if (operation === 'normalize') return { mode: 'whitespace' };
		if (operation === 'case') return { mode: 'lower' };
		if (operation === 'concat') return { delimiter: 'space' };
		if (operation === 'text_to_boolean') {
			return {
				trueValues: 'true,1,yes,y,on,active,enabled',
				falseValues: 'false,0,no,n,off,inactive,disabled',
				nullValues: 'null,none,n/a,unknown'
			};
		}
		if (operation === 'json_build') return { keyMap: '', nullHandling: 'omit' };
		if (
			operation === 'json_extract_text' ||
			operation === 'json_extract_boolean' ||
			operation === 'json_extract_integer'
		) {
			return { path: '' };
		}
		return {};
	}

	function sanitizeTransformParameters(
		operation: TransformOperation,
		parameters: Record<string, TransformParameterValue> = {}
	): Record<string, TransformParameterValue> {
		const schema = transformSchema(operation);
		const defaults = defaultTransformParameters(operation);
		const sanitized: Record<string, TransformParameterValue> = {};
		for (const parameter of schema.parameters) {
			const value = parameters[parameter.name] ?? defaults[parameter.name] ?? '';
			if (parameter.kind === 'enum') {
				sanitized[parameter.name] = parameter.options.some((option) => option.value === value)
					? value
					: (parameter.options[0]?.value ?? '');
			} else if (parameter.kind === 'boolean') {
				sanitized[parameter.name] = value === true || value === 'true';
			} else {
				sanitized[parameter.name] = typeof value === 'string' ? value : String(value);
			}
		}
		return sanitized;
	}

	function transformParameterTextValue(node: MappingNode, parameterName: string): string {
		const value = sanitizeTransformParameters(
			activeTransformOperation(node),
			node.transformParameters
		)[parameterName];
		return typeof value === 'string' ? value : String(value ?? '');
	}

	function transformSummary(
		operation: TransformOperation,
		parameters: Record<string, TransformParameterValue> = {}
	): string {
		const schema = transformSchema(operation);
		const entries = schema.parameters
			.map((parameter) => {
				const value = parameters[parameter.name];
				return value !== undefined && value !== ''
					? `${parameter.name}=${JSON.stringify(value)}`
					: null;
			})
			.filter(Boolean);
		return entries.length > 0 ? `${operation}(${entries.join(', ')})` : operation;
	}

	function transformCaption(
		operation: TransformOperation,
		parameters: Record<string, TransformParameterValue> = {}
	): string {
		const schema = transformSchema(operation);
		const label = transformOperationLabel(operation).toLowerCase();
		if (schema.parameters.length === 0) return label;
		const values = schema.parameters
			.map((parameter) => parameters[parameter.name])
			.filter((value) => value !== undefined && value !== '' && value !== false)
			.map((value) => String(value));
		return [label, ...values].join(' / ');
	}

	function updateRuleDetail(ruleId: string, patch: Partial<RuleDetail>) {
		sample = {
			...sample,
			rules: {
				...sample.rules,
				[ruleId]: {
					...(sample.rules[ruleId] ?? fallbackRule()),
					...patch
				}
			}
		};
	}

	function updateTransformNode(
		nodeId: string,
		operation: TransformOperation,
		parameters: Record<string, TransformParameterValue>
	) {
		if (!editable) return;
		const sanitized = sanitizeTransformParameters(operation, parameters);
		let ruleId: string | null = null;
		nodes = nodes.map((node) => {
			if (node.id !== nodeId || node.role !== 'transform') return node;
			ruleId = node.ruleId;
			return {
				...node,
				transformOperation: operation,
				transformParameters: sanitized,
				caption: transformCaption(operation, sanitized)
			};
		});
		if (ruleId) {
			const summary = transformSummary(operation, sanitized);
			updateRuleDetail(ruleId, {
				transform: summary,
				validation: $LL.admin_identity_mapping_flow_transform_configured_validation(),
				output: $LL.admin_identity_mapping_flow_transform_output_pending({ summary }),
				trace: $LL.admin_identity_mapping_flow_transform_config_trace()
			});
		}
		markDraftDirty();
	}

	function updateTransformOperation(node: MappingNode, value: string) {
		const operation = transformOperation(value);
		updateTransformNode(node.id, operation, defaultTransformParameters(operation));
	}

	function updateTransformOperationCategory(node: MappingNode, value: string) {
		const category =
			transformOperationCategories.find((candidate) => candidate.id === value) ??
			transformOperationCategories[0];
		const activeOperation = activeTransformOperation(node);
		if (category.operations.includes(activeOperation)) return;
		updateTransformOperation(node, category.operations[0]);
	}

	function updateTransformParameter(
		node: MappingNode,
		parameterName: string,
		value: TransformParameterValue
	) {
		const operation = activeTransformOperation(node);
		updateTransformNode(node.id, operation, {
			...sanitizeTransformParameters(operation, node.transformParameters),
			[parameterName]: value
		});
	}

	function nodeFieldRef(
		node: MappingNode,
		side: 'source' | 'destination'
	): Record<string, unknown> {
		const fieldRef = node.fieldRef ?? {
			namespace: namespaceForNode(node),
			path: node.caption || node.label
		};
		return {
			side,
			namespace: fieldRef.namespace,
			path: fieldRef.path,
			catalogEntryId: fieldRef.catalogEntryId,
			nodeId: node.id,
			role: node.role,
			label: node.label,
			adapter: node.adapter,
			profileId: node.profileId,
			profileTitle: node.profileTitle,
			valueType: node.type,
			storageTarget: node.storageTarget,
			uiGroupKey: node.uiGroupKey,
			locked: node.locked
		};
	}

	function namespaceForNode(node: MappingNode): string {
		switch (node.adapter) {
			case 'OIDC':
				return 'oidc.claim';
			case 'SAML':
				return 'saml.attribute';
			case 'SCIM':
				return 'scim.attribute';
			case 'DIRECTORY':
				return 'directory';
			case 'CSV':
				return 'csv.column';
			default:
				return node.role === 'target' ? 'authrim.profile' : 'unknown';
		}
	}

	function stableRuleKey(parts: string[]): string {
		return parts
			.join('.')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 96);
	}

	function directDraftRule(edge: MappingEdge, fromNode: MappingNode, toNode: MappingNode) {
		const edgeKind = fromNode.role === 'target' ? 'destination_release' : 'source_mapping';
		return {
			ruleKey: stableRuleKey(['ui', sample.id, edge.id, fromNode.id, toNode.id]),
			ruleKind: edgeKind,
			action: 'map',
			priority: 0,
			metadata: {
				source: 'admin_ui_flow_editor',
				viewMode
			},
			edges: [
				{
					sourceRef: nodeFieldRef(fromNode, 'source'),
					targetRef: nodeFieldRef(toNode, 'destination'),
					edgeKind: 'direct'
				}
			]
		} satisfies MappingDraftRuleInput;
	}

	function transformDraftRules(transformNode: MappingNode): MappingDraftRuleInput[] {
		const incoming = edges.filter((edge) => edge.to === transformNode.id);
		const outgoing = edges.filter((edge) => edge.from === transformNode.id);
		const operation = activeTransformOperation(transformNode);
		const parameters = sanitizeTransformParameters(operation, transformNode.transformParameters);
		return outgoing.flatMap((outEdge) => {
			const toNode = nodeById(outEdge.to);
			if (!toNode) return [];
			const inputNodes = incoming
				.map((edge) => nodeById(edge.from))
				.filter((node): node is MappingNode => Boolean(node));
			if (inputNodes.length === 0) return [];
			const edgeKind = toNode.role === 'destination' ? 'destination_transform' : 'source_transform';
			return [
				{
					ruleKey: stableRuleKey(['ui', sample.id, transformNode.id, toNode.id]),
					ruleKind: edgeKind,
					action: 'map',
					priority: 0,
					metadata: {
						source: 'admin_ui_flow_editor',
						viewMode,
						transformNodeId: transformNode.id
					},
					edges: inputNodes.map((fromNode) => ({
						sourceRef: nodeFieldRef(fromNode, 'source'),
						targetRef: nodeFieldRef(toNode, 'destination'),
						edgeKind: 'transform_input'
					})),
					transforms: [
						{
							edgeIndex: 0,
							operation,
							parameters
						}
					]
				}
			];
		});
	}

	function buildDraftPayload(): MappingDraftPayload {
		const transformIds = new Set(
			nodes.filter((node) => node.role === 'transform').map((node) => node.id)
		);
		const directRules = edges.flatMap((edge) => {
			if (transformIds.has(edge.from) || transformIds.has(edge.to)) return [];
			const fromNode = nodeById(edge.from);
			const toNode = nodeById(edge.to);
			if (!fromNode || !toNode) return [];
			return [directDraftRule(edge, fromNode, toNode)];
		});
		const transformRules = nodes
			.filter((node) => node.role === 'transform')
			.flatMap((node) => transformDraftRules(node));
		return {
			versionLabel: `ui-draft-${new Date().toISOString()}`,
			compatibilityRange: '>=0.2.0',
			rules: [...directRules, ...transformRules],
			metadata: {
				sampleId: sample.id,
				sampleTitle: sample.title,
				viewMode,
				edgeCount: edges.length,
				transformCount: transformRules.length
			}
		};
	}

	async function submitDraftForCompile() {
		if (!editable || draftSubmitStatus === 'saving') return;
		const draft = buildDraftPayload();
		if (draft.rules.length === 0) {
			draftSubmitStatus = 'error';
			draftSubmitMessage = $LL.admin_identity_mapping_flow_connect_edge_before_compile();
			return;
		}
		if (!onCompileDraft) {
			draftSubmitStatus = 'error';
			draftSubmitMessage = $LL.admin_identity_mapping_flow_compile_not_connected();
			return;
		}
		draftSubmitStatus = 'saving';
		draftSubmitMessage = $LL.admin_identity_mapping_flow_saving_draft_policy();
		try {
			await onCompileDraft(draft);
			draftSubmitStatus = 'saved';
			draftSubmitMessage = $LL.admin_identity_mapping_flow_draft_saved_compiled();
			hasUnsavedDraftChanges = false;
			onDraftDirtyChange?.(false);
		} catch (error) {
			draftSubmitStatus = 'error';
			draftSubmitMessage =
				error instanceof Error ? error.message : $LL.admin_identity_mapping_flow_compile_failed();
		}
	}

	function edgeInspectorRule(edge: MappingEdge) {
		const fromNode = nodeById(edge.from);
		const toNode = nodeById(edge.to);
		const base = sample.rules[fromNode?.ruleId ?? toNode?.ruleId ?? activeRuleId] ?? fallbackRule();
		const source =
			fromNode?.role === 'source'
				? `${fromNode.adapter} / ${fromNode.label}`
				: (base.source ?? $LL.admin_identity_mapping_flow_not_connected());
		const target =
			fromNode?.role === 'target'
				? fromNode.label
				: toNode?.role === 'target'
					? toNode.label
					: (base.target ?? $LL.admin_identity_mapping_flow_no_schema_field_selected());
		const destination =
			toNode?.role === 'destination'
				? `${toNode.adapter} / ${toNode.label}`
				: (base.destination ?? $LL.admin_identity_mapping_flow_not_connected());
		return {
			...base,
			title: `${fromNode?.label ?? $LL.admin_identity_mapping_flow_mapping_edge()} -> ${toNode?.label ?? $LL.admin_identity_mapping_flow_target()}`,
			source,
			target,
			destination,
			validation: edge.custom
				? $LL.admin_identity_mapping_flow_selected_edge_custom_validation()
				: $LL.admin_identity_mapping_flow_selected_edge_loaded_validation(),
			trace: $LL.admin_identity_mapping_flow_selected_edge_trace()
		};
	}

	function inspectorConnectionDirection(): 'source_to_schema' | 'schema_to_destination' | 'other' {
		if (selectedEdge) {
			const fromNode = nodeById(selectedEdge.from);
			const toNode = nodeById(selectedEdge.to);
			if (toNode?.role === 'target') return 'source_to_schema';
			if (fromNode?.role === 'target' || toNode?.role === 'destination') {
				return 'schema_to_destination';
			}
		}
		const selectedNode = nodes.find((node) => node.id === selectedNodeId);
		if (selectedNode?.role === 'source') return 'source_to_schema';
		if (selectedNode?.role === 'destination') return 'schema_to_destination';
		if (selectedNode?.role === 'target') {
			return viewMode === 'destination' ? 'schema_to_destination' : 'source_to_schema';
		}
		return 'other';
	}

	function runInspectorDryRun() {
		const edge = selectedDryRunEdge();
		const result = edge ? evaluateDryRunEdge(edge) : evaluateDryRunNode(selectedInspectorNode());
		logDryRunDebug('manual', result);
		dryRunResults = {
			...dryRunResults,
			[inspectorRuleKey]: dryRunRulePatch(result)
		};
	}

	function logDryRunDebug(
		mode: 'manual' | 'live',
		result: { ok: boolean; input: string; output: string; trace: string }
	) {
		logDebug('[IdentityMappingDryRun]', {
			mode,
			activeTab,
			inspectorRuleKey,
			activeRuleId,
			selectedNodeId,
			selectedEdgeId,
			selectedEdge,
			selectedNode: selectedInspectorNode() ? debugNode(selectedInspectorNode()) : null,
			graphEdgeCount: graphEdges.length,
			graphEdges,
			editableEdgeCount: edges.length,
			editableEdges: edges,
			result
		});
	}

	function logDebug(label: string, payload: unknown) {
		try {
			console.log(label, JSON.stringify(payload, null, 2));
		} catch {
			console.log(label, payload);
		}
	}

	function debugNode(node: MappingNode | undefined) {
		if (!node) return null;
		return {
			id: node.id,
			role: node.role,
			label: node.label,
			caption: node.caption,
			type: node.type,
			adapter: node.adapter,
			profileId: node.profileId,
			fieldRef: node.fieldRef
		};
	}

	function selectedInspectorNode(): MappingNode | undefined {
		return selectedNodeId ? nodeById(selectedNodeId) : nodeForRule(activeRuleId);
	}

	function selectedDryRunEdge(): MappingEdge | null {
		if (selectedEdge) return selectedEdge;
		if (selectedEdgeId) {
			return graphEdges.find((edge) => edge.id === selectedEdgeId) ?? null;
		}
		if (selectedNodeId) return null;
		return graphEdges.length === 1 ? graphEdges[0] : null;
	}

	function dryRunRulePatch(result: {
		ok: boolean;
		input: string;
		output: string;
		trace: string;
	}): Pick<RuleDetail, 'dryrunStatus' | 'dryrunTone' | 'input' | 'output' | 'trace'> {
		return {
			dryrunStatus: result.ok
				? $LL.admin_identity_mapping_flow_configured()
				: $LL.admin_identity_mapping_flow_not_configured(),
			dryrunTone: result.ok ? 'ok' : 'warn',
			input: result.input,
			output: result.output,
			trace: result.trace
		};
	}

	function evaluateDryRunEdge(edge: MappingEdge): {
		ok: boolean;
		input: string;
		output: string;
		trace: string;
	} {
		const fromNode = nodeById(edge.from);
		const toNode = nodeById(edge.to);
		logDebug('[IdentityMappingDryRun:evaluateEdge]', {
			edge,
			fromNode: debugNode(fromNode),
			toNode: debugNode(toNode)
		});
		if (!fromNode || !toNode) {
			return disconnectedDryRunResult();
		}
		const inputValue = evaluateNodeOutput(fromNode);
		if (!inputValue.ok) {
			return disconnectedDryRunResult(inputValue.trace);
		}
		if (toNode.role === 'transform') {
			const outputValue = evaluateNodeOutput(toNode);
			return {
				ok: outputValue.ok,
				input: outputValue.input ?? inputValue.value,
				output: outputValue.value,
				trace: outputValue.trace ?? $LL.admin_identity_mapping_flow_selected_edge_trace()
			};
		}
		return {
			ok: true,
			input: inputValue.value,
			output: inputValue.value,
			trace: $LL.admin_identity_mapping_flow_selected_edge_trace()
		};
	}

	function evaluateDryRunNode(node: MappingNode | undefined): {
		ok: boolean;
		input: string;
		output: string;
		trace: string;
	} {
		logDebug('[IdentityMappingDryRun:evaluateNode]', {
			node: debugNode(node),
			incoming: node ? graphEdges.filter((edge) => edge.to === node.id) : [],
			outgoing: node ? graphEdges.filter((edge) => edge.from === node.id) : []
		});
		if (!node) {
			return disconnectedDryRunResult();
		}
		if (node.role === 'source' || (node.role === 'target' && viewMode === 'destination')) {
			if (!graphEdges.some((edge) => edge.from === node.id)) {
				return disconnectedDryRunResult();
			}
			const value = evaluateNodeOutput(node);
			return {
				ok: value.ok,
				input: value.value,
				output: value.value,
				trace: $LL.admin_identity_mapping_flow_select_node_trace()
			};
		}
		const value = evaluateNodeOutput(node);
		if (!value.ok) {
			return disconnectedDryRunResult(value.trace);
		}
		return {
			ok: true,
			input: value.input ?? value.value,
			output: value.value,
			trace: value.trace ?? $LL.admin_identity_mapping_flow_select_node_trace()
		};
	}

	function disconnectedDryRunResult(
		trace = String($LL.admin_identity_mapping_flow_select_node_trace())
	) {
		return {
			ok: false,
			input: $LL.admin_identity_mapping_flow_no_runtime_input(),
			output: $LL.admin_identity_mapping_flow_no_mapping_edge(),
			trace
		};
	}

	function evaluateNodeOutput(node: MappingNode, seen: readonly string[] = []): DryRunValue {
		if (seen.includes(node.id)) {
			return {
				ok: false,
				value: $LL.admin_identity_mapping_flow_no_mapping_edge(),
				trace: $LL.admin_identity_mapping_flow_no_mapping_edge()
			};
		}
		const nextSeen = [...seen, node.id];
		if (node.role === 'source' || (node.role === 'target' && viewMode === 'destination')) {
			return { ok: true, value: firstNodeExample(node) };
		}
		const incoming = graphEdges.filter((edge) => edge.to === node.id);
		if (incoming.length === 0) {
			return {
				ok: false,
				value: $LL.admin_identity_mapping_flow_no_mapping_edge(),
				trace: $LL.admin_identity_mapping_flow_no_mapping_edge()
			};
		}
		const inputs = incoming
			.map((edge) => {
				const fromNode = nodeById(edge.from);
				return fromNode ? evaluateNodeOutput(fromNode, nextSeen) : null;
			})
			.filter((value): value is DryRunValue => Boolean(value?.ok));
		if (inputs.length === 0) {
			return {
				ok: false,
				value: $LL.admin_identity_mapping_flow_no_runtime_input(),
				trace: $LL.admin_identity_mapping_flow_no_runtime_input()
			};
		}
		const inputValues = inputs.map((inputValue) => inputValue.value);
		if (node.role === 'transform') {
			const input = formatDryRunValues(inputValues);
			return {
				ok: true,
				input,
				value: transformDryRunOutput(node, inputValues),
				trace: transformSummary(
					activeTransformOperation(node),
					sanitizeTransformParameters(activeTransformOperation(node), node.transformParameters)
				)
			};
		}
		return {
			ok: true,
			input: formatDryRunValues(inputValues),
			value: inputValues[0],
			trace: $LL.admin_identity_mapping_flow_select_node_trace()
		};
	}

	function formatDryRunValues(values: string[]): string {
		return values.length === 1 ? values[0] : JSON.stringify(values);
	}

	function transformDryRunOutput(node: MappingNode, inputs: string[]): string {
		const input = inputs[0] ?? '';
		const params = sanitizeTransformParameters(
			activeTransformOperation(node),
			node.transformParameters
		);
		switch (activeTransformOperation(node)) {
			case 'copy':
				return input;
			case 'trim':
				return input.trim();
			case 'normalize':
				return String(params.mode) === 'unicode'
					? input.normalize('NFKC')
					: input.trim().replace(/\s+/g, ' ');
			case 'case':
				return params.mode === 'upper'
					? input.toUpperCase()
					: params.mode === 'lower'
						? input.toLowerCase()
						: titleCase(input);
			case 'split':
				return JSON.stringify(
					normalizeDryRunList(
						input.split(delimiterFromParameter(params.delimiter)),
						params.trimItems === true,
						params.omitEmpty === true,
						params.unique === true
					)
				);
			case 'join':
				return normalizeDryRunList(
					inputs,
					params.trimItems === true,
					params.omitEmpty === true,
					false
				).join(delimiterTextFromParameter(params.delimiter, ','));
			case 'first':
				return (
					normalizeDryRunList(
						inputs,
						params.trimItems === true,
						params.omitEmpty === true,
						false
					)[0] ?? ''
				);
			case 'affix_text':
				return `${String(params.prefix ?? '')}${input}${String(params.suffix ?? '')}`;
			case 'concat':
				return inputs.join(delimiterTextFromParameter(params.delimiter, ' '));
			case 'fallback':
				return inputs.find((value) => value.trim().length > 0) ?? '';
			case 'as_array':
				return JSON.stringify(
					normalizeDryRunList(
						inputs,
						params.trimItems === true,
						params.omitEmpty === true,
						params.unique === true
					)
				);
			case 'text_to_boolean':
				return textToBooleanDryRun(input, params);
			case 'json_build':
				return jsonBuildDryRun(inputs, params);
			case 'json_extract_text':
			case 'json_extract_boolean':
			case 'json_extract_integer':
				return jsonExtractDryRun(input, String(params.path ?? ''), activeTransformOperation(node));
			case 'oidc_pairwise_sub':
				return `pairwise:${input}`;
			case 'saml_edu_person_targeted_id':
				return `https://idp.example.edu/idp/shibboleth!https://sp.example.org!${input}`;
			default:
				return input;
		}
	}

	function delimiterFromParameter(value: TransformParameterValue | undefined): string | RegExp {
		const delimiter = String(value || ',');
		if (delimiter === 'space') return /\s+/;
		if (delimiter === 'comma') return ',';
		if (delimiter === 'tab') return '\t';
		if (delimiter === 'newline') return /\r?\n/;
		return delimiter;
	}

	function delimiterTextFromParameter(
		value: TransformParameterValue | undefined,
		fallback: string
	): string {
		if (value === undefined) return fallback;
		const delimiter = String(value);
		if (delimiter === 'space') return ' ';
		if (delimiter === 'comma') return ',';
		if (delimiter === 'tab') return '\t';
		if (delimiter === 'newline') return '\n';
		return delimiter;
	}

	function normalizeDryRunList(
		values: string[],
		trimItems: boolean,
		omitEmpty: boolean,
		unique: boolean
	): string[] {
		const normalized = values
			.map((value) => (trimItems ? value.trim() : value))
			.filter((value) => !omitEmpty || value.length > 0);
		return unique ? [...new Set(normalized)] : normalized;
	}

	function titleCase(value: string): string {
		return value.replace(
			/\S+/g,
			(word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1).toLowerCase()}`
		);
	}

	function textToBooleanDryRun(
		value: string,
		params: Record<string, TransformParameterValue>
	): string {
		const normalized = value.trim().toLowerCase();
		const trueValues = commaList(params.trueValues);
		const falseValues = commaList(params.falseValues);
		const nullValues = commaList(params.nullValues);
		if (trueValues.includes(normalized)) return 'true';
		if (falseValues.includes(normalized)) return 'false';
		if (nullValues.includes(normalized) || normalized === '') return 'null';
		return 'null';
	}

	function commaList(value: TransformParameterValue | undefined): string[] {
		return String(value ?? '')
			.split(',')
			.map((item) => item.trim().toLowerCase())
			.filter(Boolean);
	}

	function jsonBuildDryRun(
		inputs: string[],
		params: Record<string, TransformParameterValue>
	): string {
		const keyMap = parseKeyMap(String(params.keyMap ?? ''));
		const nullHandling = params.nullHandling;
		const object = Object.fromEntries(
			inputs
				.map((value, index) => [keyMap[index] ?? `value${index + 1}`, value] as const)
				.filter(([, value]) => nullHandling === 'include_null' || value.trim().length > 0)
		);
		return JSON.stringify(object);
	}

	function parseKeyMap(value: string): Record<number, string> {
		if (!value.trim()) return {};
		try {
			const parsed = JSON.parse(value) as Record<string, string>;
			return Object.fromEntries(Object.values(parsed).map((key, index) => [index, key]));
		} catch {
			return {};
		}
	}

	function jsonExtractDryRun(input: string, path: string, operation: TransformOperation): string {
		try {
			const parsed = JSON.parse(input) as unknown;
			const value = readJsonPath(parsed, path);
			if (operation === 'json_extract_boolean') return String(Boolean(value));
			if (operation === 'json_extract_integer') return String(Number.parseInt(String(value), 10));
			return value === undefined || value === null ? '' : String(value);
		} catch {
			return '';
		}
	}

	function readJsonPath(value: unknown, path: string): unknown {
		return path
			.replace(/\[(\d+)\]/g, '.$1')
			.split('.')
			.filter(Boolean)
			.reduce<unknown>((current, key) => {
				if (current && typeof current === 'object') {
					return (current as Record<string, unknown>)[key];
				}
				return undefined;
			}, value);
	}

	function fallbackRule() {
		return {
			title: $LL.admin_identity_mapping_flow_mapping_node(),
			risk: 'medium' as const,
			source: $LL.admin_identity_mapping_flow_selected_graph_node(),
			target: $LL.admin_identity_mapping_flow_connected_schema_field(),
			destination: $LL.admin_identity_mapping_flow_connected_destination(),
			transform: $LL.admin_identity_mapping_flow_not_configured(),
			validation: $LL.admin_identity_mapping_flow_not_configured(),
			release: $LL.admin_identity_mapping_flow_not_configured(),
			storageTarget: $LL.admin_identity_mapping_flow_not_configured(),
			consentStatus: 'not_required' as const,
			legalBasis: 'legitimate_interest' as const,
			purpose: $LL.admin_identity_mapping_flow_not_configured(),
			attributeSetHash: $LL.admin_identity_mapping_flow_not_configured(),
			consentMode: 'not_applicable' as const,
			releaseFieldMappingVersion: $LL.admin_identity_mapping_flow_not_configured(),
			termsVersion: $LL.admin_identity_mapping_flow_not_configured(),
			privacyFieldMappingVersion: $LL.admin_identity_mapping_flow_not_configured(),
			denyReason: 'none',
			runtime: 'graph preview',
			conflict: 'not evaluated',
			disclosure: 'redacted summary',
			dryrunStatus: 'pending',
			dryrunTone: 'warn' as const,
			input: $LL.admin_identity_mapping_flow_no_runtime_input(),
			output: $LL.admin_identity_mapping_flow_no_mapping_edge(),
			trace: $LL.admin_identity_mapping_flow_select_node_trace(),
			review: '0 tasks',
			replay: 'no',
			diffSeverity: 'medium' as const,
			diffTitle: $LL.admin_identity_mapping_flow_draft_only_node(),
			diff: [$LL.admin_identity_mapping_flow_draft_only_node_diff()]
		};
	}
</script>

<section class="mapping-shell">
	<div class={`workspace ${showInspector ? '' : 'no-inspector'}`}>
		<section class="pane graph-pane" aria-label={$LL.admin_identity_mapping_flow_graph_aria()}>
			<div class="graph-toolbar">
				<div>
					{#if showGraphPolicyDraftLabel}
						<p class="section-kicker">{$LL.admin_identity_mapping_flow_policy_draft()}</p>
					{/if}
					<h2>{graphTitle}</h2>
				</div>
				<div class="graph-actions">
					{#if showToolbarSourceProfile}
						<label class="source-profile-select" for="sourceProfile">
							<span>{$LL.admin_identity_mapping_source_profile()}</span>
							<select
								id="sourceProfile"
								value={selectedSampleId ?? emptySample.id}
								disabled={loading || samples.length === 0}
								onchange={selectSample}
							>
								{#if samples.length === 0}
									<option value={emptySample.id}>
										{$LL.admin_identity_mapping_flow_no_profiles()}
									</option>
								{:else}
									{#each samples as option (option.id)}
										<option value={option.id}>{option.title}</option>
									{/each}
								{/if}
							</select>
						</label>
					{/if}
					{#if showToolbarModeToggle}
						<div class="mode-toggle" aria-label={$LL.admin_identity_mapping_flow_view_mode_aria()}>
							{#each enabledViewModes as mode (mode)}
								<button
									class={mode === 'source'
										? 'view-source'
										: mode === 'destination'
											? 'view-destination'
											: 'view-overview'}
									class:active={viewMode === mode}
									type="button"
									onclick={() => (viewMode = mode)}
								>
									{mode === 'overview'
										? $LL.admin_identity_mapping_flow_overview()
										: mode === 'source'
											? $LL.admin_identity_mapping_flow_source_mapping()
											: $LL.admin_identity_mapping_flow_destination_release()}
								</button>
							{/each}
						</div>
					{/if}
					{#if editable}
						<button class="secondary-action" type="button" onclick={autoMapConnections}>
							{$LL.admin_identity_mapping_flow_auto_map()}
						</button>
					{/if}
					{#if showCompileDraftButton}
						<button
							class="primary-action"
							type="button"
							disabled={!editable || draftSubmitStatus === 'saving'}
							onclick={submitDraftForCompile}
						>
							{draftSubmitStatus === 'saving' ? primaryActionBusyLabel : primaryActionLabel}
						</button>
					{/if}
				</div>
			</div>
			{#if draftSubmitMessage}
				<p class={`draft-submit-message ${draftSubmitStatus}`}>{draftSubmitMessage}</p>
			{/if}

			<div class="health-strip">
				<span><strong>{$LL.admin_identity_mapping_flow_snapshot()}</strong> {sample.snapshot}</span>
				<span class="status-ok">{sample.status}</span>
				<span class="status-warn">{sample.reviewGates}</span>
			</div>

			{#if showMetrics}
				<div class="metric-row">
					<div class="metric">
						<span>{$LL.admin_identity_mapping_flow_mapped_fields()}</span>
						<strong>{sample.metrics[0]}</strong>
					</div>
					<div class="metric">
						<span>{$LL.admin_identity_mapping_flow_hot_path_reads()}</span>
						<strong>{sample.metrics[1]}</strong>
					</div>
					<div class="metric">
						<span>{$LL.admin_identity_mapping_flow_release_denies()}</span>
						<strong>{sample.metrics[2]}</strong>
					</div>
					<div class="metric">
						<span>{$LL.admin_identity_mapping_flow_catalog_version()}</span>
						<strong>{sample.metrics[3]}</strong>
					</div>
				</div>
			{/if}

			<div
				class={`graph-canvas view-${viewMode}`}
				bind:this={canvas}
				style={`height:${layout.height}px`}
			>
				{#if loading || loadError || !hasRenderableGraph}
					<div class="graph-empty-state">
						<strong
							>{loading
								? $LL.admin_identity_mapping_flow_loading_schemas()
								: loadError
									? $LL.admin_identity_mapping_flow_schema_load_failed()
									: resolvedEmptyGraphTitle}</strong
						>
						<span
							>{loading
								? $LL.admin_identity_mapping_flow_loading_schemas_desc()
								: loadError
									? loadError
									: resolvedEmptyGraphDescription}</span
						>
						{#if !loading && !loadError && emptyStateActionHref && emptyStateActionLabel}
							<a class="graph-empty-action" href={emptyStateActionHref}>
								{emptyStateActionLabel}
							</a>
						{/if}
					</div>
				{/if}
				{#if viewMode !== 'destination'}
					<div class="lane-label lane-source" style={laneLabelStyle('source')}>
						<span>
							{laneSelectorMode === 'policy'
								? $LL.admin_identity_mapping_flow_source_policy()
								: $LL.admin_identity_mapping_source_profile()}
						</span>
						{#if showLaneProfileSelectors}
							{#if laneSelectorMode === 'policy'}
								<select
									value={selectedSourcePolicyId ?? ''}
									disabled={sourcePolicyOptions.length === 0}
									onchange={selectSourcePolicy}
								>
									<option value="">{$LL.admin_identity_mapping_flow_select_source_policy()}</option>
									{#each sourcePolicyOptions as option (option.id)}
										<option value={option.id}>{option.title}</option>
									{/each}
								</select>
							{:else}
								<select
									value={selectedSampleId ?? emptySample.id}
									disabled={sourceProfileOptions.length === 0}
									onchange={selectSample}
								>
									{#each sourceProfileOptions as option (option.id)}
										<option value={option.id}>{option.title}</option>
									{/each}
								</select>
							{/if}
							{#if editable}
								<button class="mini-tool-button" type="button" onclick={() => addNode('source')}
									>+</button
								>
							{/if}
						{/if}
					</div>
				{/if}
				<div class="lane-label lane-canonical" style={laneLabelStyle('canonical')}>
					<span>{$LL.admin_identity_mapping_flow_identity_schema()}</span>
				</div>
				{#each layout.targetGroups as group (group.key)}
					<button
						class={`target-group-header ${group.collapsed ? 'collapsed' : ''} ${activeTargetGroupKeys.includes(group.key) ? 'group-hovered' : ''}`}
						style={targetGroupStyle(group)}
						type="button"
						aria-expanded={!group.collapsed}
						aria-label={group.collapsed
							? $LL.admin_identity_mapping_flow_expand_schema_group({ group: group.label })
							: $LL.admin_identity_mapping_flow_collapse_schema_group({ group: group.label })}
						onclick={(event) => {
							event.stopPropagation();
							toggleTargetGroup(group.key);
						}}
						onpointerover={() => (hoverTargetGroupKey = group.key)}
						onpointerout={() => (hoverTargetGroupKey = null)}
					>
						<span class="target-group-title">{group.label}</span>
						<span class="target-group-count">{group.count}</span>
						<span class="target-group-chevron" aria-hidden="true"></span>
					</button>
				{/each}
				{#if viewMode !== 'source'}
					<div class="lane-label lane-destination" style={laneLabelStyle('destination')}>
						<span>
							{laneSelectorMode === 'policy'
								? $LL.admin_identity_mapping_flow_destination_policy()
								: $LL.admin_identity_mapping_destination_profile()}
						</span>
						{#if showLaneProfileSelectors}
							{#if laneSelectorMode === 'policy'}
								<select
									value={selectedDestinationPolicyId ?? ''}
									disabled={destinationPolicyOptions.length === 0}
									onchange={selectDestinationPolicy}
								>
									<option value="">
										{$LL.admin_identity_mapping_flow_select_destination_policy()}
									</option>
									{#each destinationPolicyOptions as option (option.id)}
										<option value={option.id}>{option.title}</option>
									{/each}
								</select>
							{:else}
								<select
									value={selectedDestinationProfileId ?? ''}
									disabled={destinationProfileOptions.length === 0}
									onchange={selectDestinationProfile}
								>
									{#each destinationProfileOptions as option (option.id)}
										<option value={option.id}>{option.title}</option>
									{/each}
								</select>
							{/if}
							{#if editable}
								<button
									class="mini-tool-button"
									type="button"
									onclick={() => addNode('destination')}>+</button
								>
							{/if}
						{/if}
					</div>
				{/if}

				<svg
					class="edge-layer"
					viewBox={`0 0 ${canvasWidth} ${layout.height}`}
					aria-label={$LL.admin_identity_mapping_flow_edges_aria()}
				>
					<rect
						class="edge-blank-hit"
						x="0"
						y="0"
						width={canvasWidth}
						height={layout.height}
						role="button"
						tabindex="0"
						aria-label={$LL.admin_identity_mapping_flow_clear_selection_aria()}
						onclick={clearCanvasSelection}
						onkeydown={handleClearSelectionKeyDown}
					/>
					{#each graphEdges as edge (edge.id)}
						{#if !isOverviewLayerEdge(edge)}
							<path
								class="edge-hit"
								d={edgePath(edge)}
								role="button"
								tabindex="0"
								aria-label={$LL.admin_identity_mapping_flow_select_edge_aria({
									from: nodeById(edge.from)?.label ?? edge.from,
									to: nodeById(edge.to)?.label ?? edge.to
								})}
								onclick={(event) => {
									event.stopPropagation();
									selectEdge(edge);
								}}
								onpointerover={() => (hoverEdgeId = edge.id)}
								onpointerout={() => (hoverEdgeId = null)}
								onkeydown={(event) => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										selectEdge(edge);
									}
								}}
							/>
						{/if}
						<path
							class={edgeClasses(edge)}
							style={`--edge-accent:${edgeAccent(edge)}`}
							d={edgePath(edge)}
						/>
						{#if editable && edge.id === selectedEdgeId}
							{#each ['source', 'target'] as side (side)}
								{@const reconnectPoint = edgeReconnectPoint(edge, side as 'source' | 'target')}
								{#if reconnectPoint}
									<g
										class={`edge-reconnect-control reconnect-${side}`}
										transform={`translate(${reconnectPoint.x} ${reconnectPoint.y})`}
										style={`--edge-accent:${edgeAccent(edge)}`}
										role="button"
										tabindex="0"
										aria-label={$LL.admin_identity_mapping_flow_reconnect_edge_aria({
											side
										})}
										onpointerdown={(event) =>
											startReconnectDrag(event, edge, side as 'source' | 'target')}
									>
										<circle r="6" />
									</g>
								{/if}
							{/each}
						{/if}
						{#if editable && selectedEdges.has(edge.id) && canInsertTransformNode(edge)}
							{@const insertPoint = edgeInsertPoint(edge)}
							{#if insertPoint}
								<g
									class="edge-insert-control"
									transform={`translate(${insertPoint.x} ${insertPoint.y})`}
									style={`--edge-accent:${edgeAccent(edge)}`}
									role="button"
									tabindex="0"
									aria-label={$LL.admin_identity_mapping_flow_insert_transform_aria()}
									onclick={(event) => {
										event.stopPropagation();
										addTransformNode(edge);
									}}
									onkeydown={(event) => {
										if (event.key === 'Enter' || event.key === ' ') {
											event.preventDefault();
											addTransformNode(edge);
										}
									}}
								>
									<rect x="-9" y="-9" width="18" height="18" rx="3" />
									<path d="M -4 0 H 4 M 0 -4 V 4" />
								</g>
							{/if}
						{/if}
						{#if editable && edge.id === selectedEdgeId}
							{@const deletePoint = edgeDeletePoint(edge)}
							{#if deletePoint}
								<g
									class="edge-delete-control"
									transform={`translate(${deletePoint.x} ${deletePoint.y})`}
									role="button"
									tabindex="0"
									aria-label={$LL.admin_identity_mapping_flow_delete_edge_aria()}
									onclick={(event) => {
										event.stopPropagation();
										deleteSelectedEdge();
									}}
									onkeydown={(event) => {
										if (event.key === 'Enter' || event.key === ' ') {
											event.preventDefault();
											deleteSelectedEdge();
										}
									}}
								>
									<circle r="9" />
									<path d="M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5" />
								</g>
							{/if}
						{/if}
					{/each}
					{#if editable && dragState}
						<path
							class={`edge drag-edge ${dragState.validTarget === false ? 'drag-edge-invalid' : ''}`}
							d={pathBetween(dragState.from, dragState.to)}
						/>
						{#if dragState.validTarget === false}
							<g
								class="drag-reject-marker"
								transform={`translate(${dragState.to.x - 12} ${dragState.to.y - 12})`}
								aria-hidden="true"
							>
								<circle r="8" />
								<path d="M -3 -3 L 3 3 M 3 -3 L -3 3" />
							</g>
						{/if}
					{/if}
				</svg>

				{#each laidOutNodes as node (node.id)}
					{#if !node.collapsed}
						<button
							class={nodeClasses(node)}
							style={nodeStyle(node)}
							type="button"
							data-node-id={node.id}
							data-adapter={node.adapter}
							aria-hidden={node.hidden}
							tabindex={node.hidden ? -1 : 0}
							onclick={(event) => {
								event.stopPropagation();
								if (suppressNextNodeClickId === node.id) {
									suppressNextNodeClickId = null;
									return;
								}
								if (!node.hidden) selectRule(node.ruleId);
							}}
							onpointerdown={(event) => startEasyConnectionDrag(event, node)}
							onpointerover={() => !node.hidden && (hoverNodeId = node.id)}
							onpointerout={() => (hoverNodeId = null)}
						>
							{#if !node.locked && (node.role === 'destination' || node.role === 'transform' || (node.role === 'target' && viewMode !== 'destination'))}
								<span class="node-handle input" data-node-id={node.id} aria-hidden="true"></span>
							{/if}
							{#if node.locked}
								<span
									class="node-lock-icon"
									aria-hidden="true"
									title={$LL.admin_identity_mapping_flow_managed_by_subject()}
								></span>
							{/if}
							{#if node.role !== 'transform' && !node.hidden}
								<span
									class="node-info"
									data-tooltip-placement={nodeInfoPlacement(node)}
									aria-hidden="true"
									onpointerenter={() => (infoOverlayNodeId = node.id)}
									onpointerleave={() => {
										if (infoOverlayNodeId === node.id) infoOverlayNodeId = null;
									}}
									onpointerdown={(event) => event.stopPropagation()}
								>
									<span class="node-info-mark">i</span>
									<span class="node-info-overlay">
										<strong>{$LL.admin_identity_mapping_flow_sample_value()}</strong>
										{#each nodeInfoExamples(node) as example (example)}
											<code>{example}</code>
										{:else}
											<small>{$LL.admin_identity_mapping_flow_no_sample_value()}</small>
										{/each}
										<strong>{$LL.admin_identity_mapping_flow_note()}</strong>
										<small>{nodeInfoNote(node) ?? $LL.admin_identity_mapping_flow_no_note()}</small>
										<strong>{$LL.admin_identity_mapping_flow_allowed_values()}</strong>
										{#if nodeAllowedValues(node).length > 0}
											<small>{nodeAllowedValues(node).join(', ')}</small>
										{:else}
											<small>{$LL.admin_identity_mapping_flow_no_fixed_values()}</small>
										{/if}
										<strong>{$LL.admin_identity_mapping_flow_value_rule()}</strong>
										<small>{nodeMultiplicityLabel(node)} / {nodeNullableLabel(node)}</small>
									</span>
								</span>
							{/if}
							<span>{node.label}</span>
							{#if nodeVisibleCaption(node)}
								<small>{nodeVisibleCaption(node)}</small>
							{/if}
							{#if node.role !== 'target' && node.type}
								<span class="node-badge-row">
									<span class="target-badges">
										<span class="target-badge type">{node.type}</span>
									</span>
								</span>
							{/if}
							{#if node.role === 'target'}
								<span class="target-badge-row">
									<span class="target-badges">
										{#if node.type}<span class="target-badge type">{node.type}</span>{/if}
										<span
											class={`target-badge cardinality cardinality-${targetInputCardinality(node)}`}
											aria-label={targetInputCardinality(node) === 'one'
												? $LL.admin_identity_mapping_flow_accepts_one_input()
												: $LL.admin_identity_mapping_flow_accepts_multiple_inputs()}
										>
											{targetInputCardinalityLabel(node)}
										</span>
									</span>
									<span class="target-badges meta-badges">
										{#if node.required}
											<span class="target-badge required">
												{$LL.admin_identity_mapping_flow_required()}
											</span>
										{/if}
										{#if node.privacy}
											<span
												class={`target-badge ${node.privacy.toLowerCase().replace(/[^a-z]+/g, '-')}`}
											>
												{node.privacy}
											</span>
										{/if}
									</span>
								</span>
							{/if}
							{#if !node.locked && (node.role === 'source' || node.role === 'transform' || (node.role === 'target' && viewMode !== 'source'))}
								<span
									class="node-handle output"
									data-node-id={node.id}
									aria-hidden="true"
									onpointerdown={(event) => startConnectionDrag(event, node)}
								></span>
							{/if}
						</button>
					{/if}
					{#if editable && node.role === 'transform' && node.id === selectedNodeId && !node.hidden && !node.collapsed}
						<button
							class="transform-delete-control"
							style={transformDeleteStyle(node)}
							type="button"
							aria-label={$LL.admin_identity_mapping_flow_delete_node_aria({
								node: node.label
							})}
							onclick={(event) => {
								event.stopPropagation();
								deleteTransformNode(node.id);
							}}
						>
							<span aria-hidden="true">×</span>
						</button>
					{/if}
				{/each}
			</div>
		</section>

		{#if showInspector}
			<aside class="pane right-pane" aria-label={$LL.admin_identity_mapping_flow_inspector_aria()}>
				<div class="pane-header">
					<div>
						<p class="section-kicker">{$LL.admin_identity_mapping_flow_inspector()}</p>
						<h2>{rule.title}</h2>
					</div>
					<span class={`risk-badge risk-${rule.risk}`}>{rule.risk}</span>
				</div>

				<div
					class="tab-bar"
					role="tablist"
					aria-label={$LL.admin_identity_mapping_flow_tabs_aria()}
				>
					<button
						class:active={activeTab === 'rule'}
						type="button"
						onclick={() => (activeTab = 'rule')}
					>
						{$LL.admin_identity_mapping_flow_tab_rule()}
					</button>
					<button
						class:active={activeTab === 'dryrun'}
						type="button"
						onclick={() => (activeTab = 'dryrun')}
					>
						{$LL.admin_identity_mapping_flow_tab_dryrun()}
					</button>
					<button
						class:active={activeTab === 'diff'}
						type="button"
						onclick={() => (activeTab = 'diff')}
					>
						{$LL.admin_identity_mapping_flow_tab_diff()}
					</button>
				</div>

				{#if activeTab === 'rule'}
					{#if selectedTransformNode}
						{@const schema = activeTransformSchema(selectedTransformNode)}
						{@const activeTransformCategory =
							activeTransformOperationCategory(selectedTransformNode)}
						<section
							class="transform-config-card"
							aria-label={$LL.admin_identity_mapping_flow_transform_config_aria()}
						>
							<div class="transform-config-header">
								<div>
									<p class="section-kicker">{$LL.admin_identity_mapping_flow_transform_step()}</p>
									<h3>{transformOperationLabel(schema.operation)}</h3>
								</div>
							</div>
							<label
								class="inspector-field"
								for={`transform-operation-category-${selectedTransformNode.id}`}
							>
								<span>{transformOperationCategoryFieldLabel()}</span>
								<select
									id={`transform-operation-category-${selectedTransformNode.id}`}
									value={activeTransformCategory.id}
									disabled={!editable}
									onchange={(event) =>
										updateTransformOperationCategory(
											selectedTransformNode,
											(event.currentTarget as HTMLSelectElement).value
										)}
								>
									{#each transformOperationCategories as category (category.id)}
										<option value={category.id}
											>{transformOperationCategoryLabel(category.id)}</option
										>
									{/each}
								</select>
							</label>
							<label
								class="inspector-field"
								for={`transform-operation-${selectedTransformNode.id}`}
							>
								<span>{$LL.admin_identity_mapping_flow_operation()}</span>
								<select
									id={`transform-operation-${selectedTransformNode.id}`}
									value={activeTransformOperation(selectedTransformNode)}
									disabled={!editable}
									onchange={(event) =>
										updateTransformOperation(
											selectedTransformNode,
											(event.currentTarget as HTMLSelectElement).value
										)}
								>
									{#each transformOperationOptionsForCategory(activeTransformCategory) as option (option.operation)}
										<option value={option.operation}
											>{transformOperationLabel(option.operation)}</option
										>
									{/each}
								</select>
							</label>
							<p class="transform-description">
								{transformOperationDescription(schema.operation)}
							</p>
							{#each schema.parameters as parameter (parameter.name)}
								<label
									class="inspector-field"
									for={`transform-${selectedTransformNode.id}-${parameter.name}`}
								>
									<span>
										{transformParameterLabel(parameter)}
										{#if parameter.required}<em
												>{$LL.admin_identity_mapping_flow_required_badge()}</em
											>{/if}
									</span>
									{#if parameter.kind === 'enum'}
										<select
											id={`transform-${selectedTransformNode.id}-${parameter.name}`}
											value={sanitizeTransformParameters(
												activeTransformOperation(selectedTransformNode),
												selectedTransformNode.transformParameters
											)[parameter.name]}
											disabled={!editable}
											onchange={(event) =>
												updateTransformParameter(
													selectedTransformNode,
													parameter.name,
													(event.currentTarget as HTMLSelectElement).value
												)}
										>
											{#each parameter.options as option (option.value)}
												<option value={option.value}
													>{transformOptionLabel(
														parameter.name,
														option.value,
														option.label
													)}</option
												>
											{/each}
										</select>
									{:else if parameter.kind === 'boolean'}
										<span class="inline-check">
											<input
												id={`transform-${selectedTransformNode.id}-${parameter.name}`}
												type="checkbox"
												checked={Boolean(
													sanitizeTransformParameters(
														activeTransformOperation(selectedTransformNode),
														selectedTransformNode.transformParameters
													)[parameter.name]
												)}
												disabled={!editable}
												onchange={(event) =>
													updateTransformParameter(
														selectedTransformNode,
														parameter.name,
														(event.currentTarget as HTMLInputElement).checked
													)}
											/>
											<span>{transformParameterLabel(parameter)}</span>
										</span>
									{:else if parameter.name === 'persistentIdentifierProfileId'}
										<select
											id={`transform-${selectedTransformNode.id}-${parameter.name}`}
											value={transformParameterTextValue(selectedTransformNode, parameter.name)}
											disabled={!editable}
											onchange={(event) =>
												updateTransformParameter(
													selectedTransformNode,
													parameter.name,
													(event.currentTarget as HTMLSelectElement).value
												)}
										>
											<option value="">
												{$LL.admin_identity_mapping_flow_transform_tenant_default_profile()}
											</option>
											{#each persistentIdentifierProfileOptions(activeTransformOperation(selectedTransformNode)) as profile (profile.id)}
												<option value={profile.id}>{profile.displayName}</option>
											{/each}
										</select>
									{:else}
										<input
											id={`transform-${selectedTransformNode.id}-${parameter.name}`}
											value={transformParameterTextValue(selectedTransformNode, parameter.name)}
											placeholder={parameter.placeholder}
											disabled={!editable}
											oninput={(event) =>
												updateTransformParameter(
													selectedTransformNode,
													parameter.name,
													(event.currentTarget as HTMLInputElement).value
												)}
										/>
									{/if}
								</label>
							{/each}
						</section>
					{/if}
					<dl class="detail-list">
						{#if inspectorConnectionDirection() !== 'schema_to_destination'}
							<div>
								<dt>{$LL.admin_identity_mapping_source()}</dt>
								<dd>{rule.source}</dd>
							</div>
						{/if}
						<div>
							<dt>{$LL.admin_identity_mapping_flow_schema_field()}</dt>
							<dd>{rule.target}</dd>
						</div>
						{#if inspectorConnectionDirection() !== 'source_to_schema'}
							<div>
								<dt>{$LL.admin_identity_mapping_destination()}</dt>
								<dd>{rule.destination}</dd>
							</div>
						{/if}
						<div>
							<dt>{$LL.admin_identity_mapping_flow_transform()}</dt>
							<dd>{rule.transform}</dd>
						</div>
						<div>
							<dt>{$LL.admin_identity_mapping_flow_validation()}</dt>
							<dd>{rule.validation}</dd>
						</div>
						<div>
							<dt>{$LL.admin_identity_mapping_flow_release()}</dt>
							<dd>{rule.release}</dd>
						</div>
						<div>
							<dt>{$LL.admin_identity_mapping_flow_storage()}</dt>
							<dd>{rule.storageTarget ?? $LL.admin_identity_mapping_flow_not_configured()}</dd>
						</div>
					</dl>
				{:else if activeTab === 'dryrun'}
					<section class="dryrun-card">
						<div class="dryrun-header">
							<h3>{$LL.admin_identity_mapping_flow_sample_evaluation()}</h3>
							<span class={`dryrun-status ${rule.dryrunTone}`}>{rule.dryrunStatus}</span>
						</div>
						<button type="button" class="dryrun-action" onclick={runInspectorDryRun}>
							{$LL.admin_identity_mapping_flow_tab_dryrun()}
						</button>
						<div class="value-pair">
							<span>{$LL.admin_identity_mapping_flow_input()}</span>
							<code>{rule.input}</code>
						</div>
						<div class="value-pair">
							<span>{$LL.admin_identity_mapping_flow_output()}</span>
							<code>{rule.output}</code>
						</div>
						<p class="trace-box">{rule.trace}</p>
					</section>
				{:else}
					<section class="diff-card">
						<div class="diff-summary">
							<h3>{rule.diffTitle}</h3>
							<span class={`risk-badge risk-${rule.diffSeverity}`}>{rule.diffSeverity}</span>
						</div>
						<ul class="diff-list">
							{#each rule.diff as item (item)}
								<li>{item}</li>
							{/each}
						</ul>
					</section>
				{/if}
			</aside>
		{/if}
	</div>
</section>

<style>
	.mapping-shell {
		--map-bg: var(--color-surface);
		--map-surface: var(--color-surface);
		--map-surface-muted: var(--color-surface-muted);
		--map-canvas: color-mix(in srgb, var(--color-surface) 78%, var(--color-bg-page));
		--map-line: var(--color-border);
		--map-line-strong: color-mix(in srgb, var(--color-border) 70%, var(--color-text-muted));
		--map-text: var(--color-text);
		--map-muted: var(--color-text-muted);
		--map-brand: var(--color-accent);
		--map-teal: #0f766e;
		--map-green: #15803d;
		--map-amber: #b45309;
		--map-red: var(--color-danger);
		--map-violet: #6d28d9;
		--map-radius: 4px;
		--map-target-surface: color-mix(in srgb, var(--map-brand) 2%, var(--map-surface));
		--map-target-group-surface: color-mix(in srgb, var(--map-brand) 6%, var(--map-surface));
		--map-target-group-active-surface: color-mix(in srgb, var(--map-brand) 9%, var(--map-surface));
		--map-target-active-surface: color-mix(in srgb, var(--map-brand) 11%, var(--map-surface));
		--map-target-related-surface: color-mix(in srgb, var(--map-brand) 7%, var(--map-surface));
		--map-edge-flow-distance: -24;
		--map-edge-flow-speed: 720ms;
		--map-edge-pulse-speed: 1.2s;
		--map-drag-edge-flow-speed: 620ms;
		--map-edge-dash-pattern: 6 6;
		--map-drag-edge-dash-pattern: 4 3;
		--map-layer-edge-opacity: 0.24;
		--map-layer-destination-edge-opacity: 0.16;
		overflow: hidden;
		border: 1px solid var(--map-line);
		border-radius: 8px;
		background: var(--map-bg);
		color: var(--map-text);
	}

	:global([data-theme='dark']) .mapping-shell {
		--map-bg: color-mix(in srgb, var(--color-surface) 76%, #030712);
		--map-surface: color-mix(in srgb, var(--color-surface) 84%, #05070d);
		--map-surface-muted: color-mix(in srgb, var(--color-surface-muted) 70%, #060914);
		--map-canvas: color-mix(in srgb, var(--color-bg-page) 34%, #05070d);
		--map-line: color-mix(in srgb, var(--color-border) 60%, #344156);
		--map-line-strong: #344156;
		--map-text: #e5edf6;
		--map-muted: #8ea0b7;
		--map-brand: #60a5fa;
		--map-teal: #2dd4bf;
		--map-green: #4ade80;
		--map-amber: #fbbf24;
		--map-red: #f87171;
		--map-violet: #a78bfa;
		--map-target-surface: var(--map-surface);
		--map-target-group-surface: color-mix(in srgb, var(--map-brand) 15%, var(--map-surface));
		--map-target-group-active-surface: color-mix(in srgb, var(--map-brand) 15%, var(--map-surface));
		--map-target-active-surface: color-mix(in srgb, var(--map-brand) 42%, var(--map-surface));
		--map-target-related-surface: color-mix(in srgb, var(--map-brand) 18%, var(--map-surface));
		--map-layer-edge-opacity: 0.38;
		--map-layer-destination-edge-opacity: 0.42;
	}

	.graph-toolbar,
	.graph-actions,
	.pane-header,
	.dryrun-header,
	.diff-summary,
	.control-row {
		display: flex;
		align-items: center;
	}

	.section-kicker {
		margin: 0;
		color: var(--map-muted);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	h2,
	h3 {
		margin: 0;
		letter-spacing: 0;
	}

	h2 {
		font-size: 16px;
		line-height: 1.3;
	}

	h3 {
		font-size: 12px;
	}

	.graph-actions {
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 10px;
	}

	.mode-toggle {
		min-height: 40px;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px;
		border: 1px solid var(--map-line);
		border-radius: var(--map-radius);
		background: var(--map-surface-muted);
	}

	.source-profile-select {
		display: grid;
		gap: 4px;
		min-width: 220px;
	}

	.source-profile-select span {
		color: var(--map-muted);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	select,
	input,
	button {
		font: inherit;
	}

	select,
	input {
		height: 30px;
		border: 1px solid var(--map-line);
		border-radius: 4px;
		color: var(--map-text);
		background: var(--map-surface);
		font-size: 12px;
		font-weight: 700;
	}

	input {
		padding: 0 8px;
	}

	button {
		cursor: pointer;
	}

	.mode-toggle button,
	.secondary-action,
	.primary-action {
		height: 30px;
		border: 0;
		border-radius: 4px;
		color: var(--map-muted);
		background: transparent;
		font-size: 12px;
		font-weight: 800;
	}

	.mode-toggle button {
		min-width: 72px;
	}

	.mode-toggle button.active {
		color: var(--map-text);
		background: var(--map-surface);
		box-shadow: inset 0 0 0 1px var(--map-line);
	}

	.secondary-action {
		height: 40px;
		padding: 0 14px;
		border: 1px solid color-mix(in srgb, var(--map-brand) 48%, var(--map-line));
		color: var(--map-brand);
		background: color-mix(in srgb, var(--map-brand) 8%, var(--map-surface));
	}

	.secondary-action:hover,
	.secondary-action:focus-visible {
		background: color-mix(in srgb, var(--map-brand) 14%, var(--map-surface));
	}

	.primary-action {
		height: 40px;
		padding: 0 16px;
		color: #ffffff;
		background: var(--map-brand);
	}

	.primary-action:disabled {
		cursor: progress;
		opacity: 0.66;
	}

	.draft-submit-message {
		margin: 0;
		padding: 9px 16px;
		border-top: 1px solid var(--map-line);
		color: var(--map-muted);
		background: var(--map-surface-muted);
		font-size: 12px;
		font-weight: 700;
	}

	.draft-submit-message.saved {
		color: var(--map-green);
	}

	.draft-submit-message.info {
		color: var(--map-brand);
	}

	.draft-submit-message.error {
		color: var(--map-red);
	}

	.workspace {
		display: grid;
		grid-template-columns: minmax(720px, 1fr) minmax(300px, 360px);
		gap: 14px;
		padding: 14px;
	}

	.workspace.no-inspector {
		grid-template-columns: minmax(0, 1fr);
	}

	.pane {
		min-width: 0;
		border: 1px solid var(--map-line);
		border-radius: var(--map-radius);
		background: var(--map-surface);
	}

	.graph-toolbar,
	.pane-header {
		justify-content: space-between;
		gap: 12px;
		padding: 14px 16px;
	}

	.health-strip {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 12px;
		padding: 0 16px 14px;
		color: var(--map-muted);
		font-size: 12px;
		font-weight: 700;
	}

	.status-ok,
	.status-warn,
	.risk-badge,
	.dryrun-status {
		padding: 5px 10px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 900;
	}

	.status-ok {
		color: var(--map-green);
		background: color-mix(in srgb, var(--map-green) 15%, transparent);
	}

	.status-warn {
		color: var(--map-amber);
		background: color-mix(in srgb, var(--map-amber) 15%, transparent);
	}

	.metric-row {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		border-top: 1px solid var(--map-line);
		border-bottom: 1px solid var(--map-line);
	}

	.metric {
		display: grid;
		gap: 4px;
		padding: 10px 16px;
		border-right: 1px solid var(--map-line);
	}

	.metric:last-child {
		border-right: 0;
	}

	.metric span,
	.control-row span,
	.value-pair span {
		color: var(--map-muted);
		font-size: 12px;
	}

	.metric strong {
		font-size: 19px;
	}

	.graph-canvas {
		position: relative;
		overflow: visible;
		background: var(--map-canvas);
	}

	.graph-empty-state {
		position: absolute;
		top: 92px;
		left: 50%;
		z-index: 6;
		display: grid;
		gap: 4px;
		width: min(520px, calc(100% - 48px));
		max-width: 520px;
		padding: 14px 16px;
		border: 1px solid var(--map-line);
		border-radius: var(--map-radius);
		color: var(--map-text);
		background: color-mix(in srgb, var(--map-surface) 92%, transparent);
		box-shadow: 0 16px 40px rgb(0 0 0 / 0.18);
		transform: translateX(-50%);
	}

	.graph-empty-state span {
		color: var(--map-muted);
		font-size: 12px;
		line-height: 1.45;
	}

	.graph-empty-action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: fit-content;
		margin-top: 6px;
		padding: var(--button-sm-padding, 8px 14px);
		border: var(--button-secondary-border, 1px solid var(--color-border));
		border-radius: var(--button-radius, var(--radius-sm));
		background: var(--button-secondary-bg, var(--color-surface));
		color: var(--button-secondary-text, var(--color-accent));
		font-size: var(--button-sm-font-size, 0.82rem);
		font-weight: var(--button-font-weight, 700);
		text-decoration: none;
	}

	.graph-empty-action:hover {
		border-color: var(--button-secondary-hover-border, var(--color-accent));
		background: var(--button-secondary-hover-bg, var(--color-surface-muted));
		color: var(--button-secondary-hover-text, var(--color-accent));
	}

	.lane-label {
		position: absolute;
		top: 12px;
		z-index: 4;
		display: grid;
		grid-template-columns: auto auto;
		align-items: center;
		justify-content: center;
		justify-items: center;
		gap: 7px;
		color: var(--map-muted);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-align: center;
		text-transform: uppercase;
		transform: translateX(-50%);
	}

	.lane-label > span {
		grid-column: 1 / -1;
	}

	.target-group-header {
		--target-group-accent: var(--map-brand);
		position: absolute;
		z-index: 4;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 7px;
		padding: 0 8px;
		border: 1px solid color-mix(in srgb, var(--target-group-accent) 70%, transparent);
		border-radius: 5px 5px 0 0;
		color: var(--map-text);
		background: var(--map-target-group-surface);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--target-group-accent) 8%, transparent),
			0 4px 10px rgb(0 0 0 / 0.2);
		text-align: left;
	}

	.target-group-header:hover,
	.target-group-header:focus-visible,
	.target-group-header.group-hovered {
		border-color: var(--target-group-accent);
		background: var(--map-target-group-active-surface);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--target-group-accent) 70%, transparent),
			0 0 0 4px color-mix(in srgb, var(--target-group-accent) 14%, transparent),
			0 0 22px 2px color-mix(in srgb, var(--target-group-accent) 36%, transparent),
			0 8px 18px rgba(0, 0, 0, 0.3);
		outline: none;
	}

	.target-group-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		font-weight: 900;
		letter-spacing: 0;
	}

	.target-group-count {
		min-width: 18px;
		height: 16px;
		padding: 0 5px;
		border-radius: 999px;
		color: var(--map-brand);
		background: color-mix(in srgb, var(--map-brand) 14%, transparent);
		font-size: 10px;
		font-weight: 900;
		line-height: 16px;
		text-align: center;
	}

	.target-group-chevron {
		width: 7px;
		height: 7px;
		border-right: 2px solid currentColor;
		border-bottom: 2px solid currentColor;
		opacity: 0.72;
		transform: translateY(-1px) rotate(45deg);
		transition: transform 160ms ease;
	}

	.target-group-header.collapsed {
		border-radius: 5px;
	}

	.target-group-header.collapsed .target-group-chevron {
		transform: translateX(-1px) rotate(-45deg);
	}

	.mini-tool-button {
		height: 24px;
		min-width: 24px;
		padding: 0 7px;
		border: 1px solid var(--map-line);
		border-radius: 6px;
		color: var(--map-text);
		background: var(--map-surface);
		font-size: 11px;
		font-weight: 900;
	}

	.edge-layer {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		z-index: 1;
		pointer-events: auto;
	}

	.edge-hit {
		fill: none;
		stroke: transparent;
		stroke-width: 14;
		cursor: pointer;
		outline: none;
		pointer-events: stroke;
	}

	.edge-hit:focus,
	.edge-hit:focus-visible,
	.edge-delete-control:focus,
	.edge-delete-control:focus-visible {
		outline: none;
	}

	.edge-blank-hit {
		fill: transparent;
		cursor: default;
		pointer-events: all;
	}

	.edge-delete-control {
		color: var(--map-text);
		cursor: pointer;
		pointer-events: auto;
	}

	.edge-insert-control {
		color: var(--map-text);
		cursor: pointer;
		pointer-events: auto;
	}

	.edge-reconnect-control {
		color: var(--map-text);
		cursor: grab;
		pointer-events: auto;
	}

	.edge-reconnect-control:active {
		cursor: grabbing;
	}

	.edge-reconnect-control circle {
		fill: var(--map-surface);
		stroke: var(--edge-accent, var(--map-brand));
		stroke-width: 2;
		filter: drop-shadow(
			0 0 8px color-mix(in srgb, var(--edge-accent, var(--map-brand)) 40%, transparent)
		);
	}

	.edge-reconnect-control:hover circle,
	.edge-reconnect-control:focus-visible circle {
		fill: color-mix(in srgb, var(--edge-accent, var(--map-brand)) 16%, var(--map-surface));
		outline: none;
	}

	.edge-delete-control circle {
		fill: var(--map-surface);
		stroke: var(--edge-accent, var(--map-red));
		stroke-width: 1.5;
		filter: drop-shadow(0 3px 8px rgb(0 0 0 / 0.28));
		transform: scale(0.75);
	}

	.edge-delete-control path {
		fill: none;
		stroke: var(--map-red);
		stroke-linecap: round;
		stroke-width: 1.8;
		transform: scale(0.75);
	}

	.edge-delete-control:hover circle,
	.edge-delete-control:focus-visible circle {
		fill: color-mix(in srgb, var(--map-red) 12%, var(--map-surface));
		stroke: var(--map-red);
	}

	.edge-insert-control rect {
		fill: var(--map-surface);
		stroke: var(--edge-accent, var(--map-brand));
		stroke-width: 1.5;
		filter: drop-shadow(
			0 0 10px color-mix(in srgb, var(--edge-accent, var(--map-brand)) 32%, transparent)
		);
	}

	.edge-insert-control path {
		fill: none;
		stroke: var(--edge-accent, var(--map-brand));
		stroke-linecap: round;
		stroke-width: 2;
	}

	.edge-insert-control:hover rect,
	.edge-insert-control:focus-visible rect {
		fill: color-mix(in srgb, var(--edge-accent, var(--map-brand)) 16%, var(--map-surface));
	}

	.edge {
		fill: none;
		stroke: var(--edge-accent, #5f7085);
		stroke-width: 1.2;
		opacity: 0.72;
		pointer-events: none;
		transition:
			opacity 180ms ease,
			stroke 180ms ease,
			stroke-width 180ms ease;
	}

	@keyframes edge-flow {
		to {
			stroke-dashoffset: var(--map-edge-flow-distance);
		}
	}

	@keyframes connection-pulse {
		0%,
		100% {
			stroke-opacity: 0.72;
		}

		50% {
			stroke-opacity: 1;
		}
	}

	@keyframes node-swap-in {
		0% {
			opacity: 0.28;
			filter: saturate(0.68);
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
		}

		58% {
			opacity: 1;
			filter: saturate(1);
			box-shadow:
				0 0 0 1px color-mix(in srgb, var(--node-accent) 52%, transparent),
				0 0 14px color-mix(in srgb, var(--node-accent) 18%, transparent),
				0 6px 14px rgba(0, 0, 0, 0.24);
		}

		100% {
			opacity: 1;
			filter: saturate(1);
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
		}
	}

	.edge-muted {
		stroke: #5f7085;
		stroke-dasharray: 0;
		opacity: 0.12;
	}

	.overview-layer-edge {
		stroke: #5f7085;
		stroke-width: 1;
		stroke-dasharray: 0;
		opacity: var(--map-layer-edge-opacity);
	}

	.edge.edge-muted.active {
		stroke: #5f7085;
		stroke-width: 1.2;
		opacity: 0.12;
	}

	.edge.edge-muted.edge-connected {
		opacity: 0.5;
	}

	.edge.edge-muted.edge-selected {
		opacity: 0.62;
	}

	.edge.active {
		stroke: var(--edge-accent, var(--map-brand));
		stroke-width: 1.45;
		opacity: 1;
	}

	.edge.edge-connected,
	.edge.edge-selected,
	.edge.edge-picked {
		stroke: var(--edge-accent, var(--map-brand));
		stroke-dasharray: var(--map-edge-dash-pattern);
		opacity: 1;
		animation:
			edge-flow var(--map-edge-flow-speed) linear infinite,
			connection-pulse var(--map-edge-pulse-speed) ease-in-out infinite;
	}

	.edge.edge-connected {
		stroke-width: 1.55;
	}

	.edge.edge-selected {
		stroke-width: 1.75;
	}

	.edge.edge-picked {
		stroke-width: 1.9;
		filter: drop-shadow(
			0 0 4px color-mix(in srgb, var(--edge-accent, var(--map-brand)) 56%, transparent)
		);
	}

	.destination-edge {
		opacity: 0.62;
	}

	.edge.overview-layer-edge.destination-edge {
		opacity: var(--map-layer-destination-edge-opacity);
	}

	.custom-edge {
		stroke: var(--edge-accent, var(--map-teal));
		stroke-width: 1.7;
	}

	.edge.edge-invalid {
		stroke: var(--map-red);
		stroke-dasharray: var(--map-edge-dash-pattern);
		opacity: 1;
	}

	.drag-edge {
		stroke: var(--map-brand);
		stroke-width: 1.9;
		stroke-dasharray: var(--map-drag-edge-dash-pattern);
		opacity: 0.82;
		animation: edge-flow var(--map-drag-edge-flow-speed) linear infinite;
	}

	.drag-edge-invalid {
		stroke: var(--map-red);
	}

	.drag-reject-marker {
		pointer-events: none;
	}

	.drag-reject-marker circle {
		fill: var(--map-surface);
		stroke: var(--map-red);
		stroke-width: 1.6;
		filter: drop-shadow(0 3px 8px rgb(0 0 0 / 0.28));
	}

	.drag-reject-marker path {
		fill: none;
		stroke: var(--map-red);
		stroke-linecap: round;
		stroke-width: 1.8;
	}

	.graph-node {
		--node-accent: var(--map-brand);
		--node-glow: color-mix(in srgb, var(--node-accent) 36%, transparent);
		position: absolute;
		box-sizing: border-box;
		display: grid;
		gap: 1px;
		padding: 3px 8px;
		border: 1px solid var(--map-line-strong);
		border-radius: 3px;
		color: var(--map-text);
		background: var(--map-surface);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
		overflow: visible;
		text-align: left;
		cursor: pointer;
		transition:
			opacity 180ms ease,
			transform 220ms ease,
			top 220ms ease,
			border-color 180ms ease,
			box-shadow 180ms ease;
	}

	.graph-node[data-adapter='SAML'] {
		--node-accent: var(--map-violet);
	}

	.graph-node[data-adapter='OIDC'] {
		--node-accent: var(--map-amber);
	}

	.graph-node[data-adapter='SCIM'] {
		--node-accent: var(--map-brand);
	}

	.graph-node[data-adapter='CSV'] {
		--node-accent: var(--map-teal);
	}

	.source-node,
	.destination-node {
		padding-bottom: 13px;
		border-color: color-mix(in srgb, var(--node-accent) 72%, transparent);
		background: color-mix(in srgb, var(--map-canvas) 88%, var(--node-accent) 8%);
	}

	.target-node {
		padding-bottom: 20px;
		border-color: rgba(96, 165, 250, 0.64);
		background: var(--map-target-surface);
	}

	.target-grouped-node {
		border-radius: 0;
		background: var(--map-target-surface);
		box-shadow: none;
	}

	.target-grouped-node::after {
		content: '';
		position: absolute;
		right: 0;
		bottom: -1px;
		left: 0;
		z-index: 2;
		height: 2px;
		background: color-mix(in srgb, var(--map-brand) 44%, var(--map-line));
		pointer-events: none;
	}

	.target-grouped-node.target-group-single,
	.target-grouped-node.target-group-last {
		border-radius: 0 0 5px 5px;
		box-shadow: 0 4px 10px rgb(0 0 0 / 0.16);
	}

	.target-grouped-node.target-group-first,
	.target-grouped-node.target-group-middle,
	.target-grouped-node.target-group-single {
		border-bottom-color: color-mix(in srgb, var(--map-brand) 46%, var(--map-line));
	}

	.target-grouped-node.target-group-middle,
	.target-grouped-node.target-group-last {
		border-top-color: color-mix(in srgb, var(--map-brand) 22%, transparent);
	}

	.target-grouped-node:hover,
	.target-grouped-node.active,
	.target-grouped-node.connection-origin,
	.target-grouped-node.selection-origin,
	.target-grouped-node.connection-rejected,
	.target-grouped-node.connection-related,
	.target-grouped-node.selection-related {
		z-index: 6;
	}

	.transform-node {
		--node-accent: var(--map-green);
		place-content: center;
		border-color: color-mix(in srgb, var(--map-green) 74%, transparent);
		background: color-mix(in srgb, var(--map-green) 14%, var(--map-surface));
		text-align: center;
	}

	.transform-delete-control {
		position: absolute;
		z-index: 8;
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		padding: 0;
		border: 1px solid color-mix(in srgb, var(--map-red) 72%, transparent);
		border-radius: 999px;
		color: var(--map-red);
		background: var(--map-surface);
		box-shadow:
			0 0 0 2px color-mix(in srgb, var(--map-red) 12%, transparent),
			0 6px 14px rgb(0 0 0 / 0.3);
		font-size: 12px;
		font-weight: 900;
		line-height: 1;
	}

	.transform-delete-control:hover,
	.transform-delete-control:focus-visible {
		background: color-mix(in srgb, var(--map-red) 12%, var(--map-surface));
		outline: none;
	}

	.transform-delete-control span {
		display: block;
		transform: translateY(-0.5px);
	}

	.target-node.cardinality-one .node-handle.input {
		box-shadow:
			0 0 0 1px rgba(213, 224, 238, 0.18),
			inset 0 0 0 2px var(--map-canvas);
	}

	.target-node.cardinality-many .node-handle.input {
		box-shadow:
			0 0 0 1px rgba(213, 224, 238, 0.18),
			inset 0 0 0 2px var(--map-canvas);
	}

	.adapter-hidden {
		opacity: 0.28;
		filter: saturate(0.68);
		transform: translate(var(--stack-x), var(--stack-y));
		pointer-events: none;
	}

	.adapter-hidden::before,
	.adapter-hidden::after {
		content: '';
		position: absolute;
		inset: 0;
		border: 1px solid var(--map-line-strong);
		border-radius: inherit;
		background: color-mix(in srgb, var(--map-surface) 70%, transparent);
		pointer-events: none;
	}

	.adapter-hidden::before {
		transform: translate(var(--stack-shadow-x), var(--stack-shadow-y));
		opacity: 0.38;
	}

	.adapter-hidden::after {
		transform: translate(calc(var(--stack-shadow-x) + 18px), calc(var(--stack-shadow-y) + 12px));
		opacity: 0.18;
	}

	.graph-node
		span:not(.node-handle):not(.node-badge-row):not(.target-badge-row):not(.target-badge):not(
			.target-badges
		):not(.node-info):not(.node-info-mark):not(.node-info-overlay) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		font-weight: 650;
		line-height: 1.15;
	}

	.graph-node small {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 9.6px;
		font-weight: 400;
		line-height: 1.2;
	}

	.graph-node:hover,
	.graph-node.active,
	.graph-node.connection-origin,
	.graph-node.selection-origin,
	.graph-node.connection-rejected {
		border-color: var(--node-accent);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--node-accent) 70%, transparent),
			0 0 0 4px color-mix(in srgb, var(--node-accent) 14%, transparent),
			0 0 22px 2px var(--node-glow),
			0 8px 18px rgba(0, 0, 0, 0.3);
	}

	.graph-node.connection-rejected {
		border-color: var(--map-red);
		--node-glow: color-mix(in srgb, var(--map-red) 38%, transparent);
		background: color-mix(in srgb, var(--map-red) 16%, var(--map-surface));
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--map-red) 70%, transparent),
			0 0 0 4px color-mix(in srgb, var(--map-red) 16%, transparent),
			0 0 22px 2px var(--node-glow),
			0 8px 18px rgba(0, 0, 0, 0.3);
	}

	.graph-node.node-swap-enter:not(.adapter-hidden) {
		border-color: color-mix(in srgb, var(--node-accent) 86%, transparent);
		animation: node-swap-in 260ms ease-out both;
	}

	.graph-node.selection-origin,
	.graph-node.active.selection-origin {
		background: color-mix(in srgb, var(--node-accent) 42%, var(--map-surface));
	}

	.graph-node.connection-related,
	.graph-node.selection-related {
		border-color: color-mix(in srgb, var(--node-accent) 84%, transparent);
		background: color-mix(in srgb, var(--node-accent) 18%, var(--map-surface));
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--node-accent) 58%, transparent),
			0 0 0 3px color-mix(in srgb, var(--node-accent) 10%, transparent),
			0 0 18px 1px color-mix(in srgb, var(--node-accent) 28%, transparent),
			0 8px 18px rgba(0, 0, 0, 0.26);
	}

	.target-node.connection-related,
	.target-node.selection-related {
		background: var(--map-target-related-surface);
	}

	.target-node.active,
	.target-node.connection-origin,
	.target-node.selection-origin {
		background: var(--map-target-active-surface);
	}

	.target-grouped-node:hover,
	.target-grouped-node.active,
	.target-grouped-node.connection-origin,
	.target-grouped-node.selection-origin,
	.target-grouped-node.connection-related,
	.target-grouped-node.selection-related {
		background: var(--map-target-related-surface);
		outline: 2px solid color-mix(in srgb, var(--node-accent) 88%, transparent);
		outline-offset: -2px;
		box-shadow:
			inset 0 0 0 1px color-mix(in srgb, var(--node-accent) 42%, transparent),
			0 0 0 2px color-mix(in srgb, var(--node-accent) 16%, transparent),
			0 0 18px 1px color-mix(in srgb, var(--node-accent) 28%, transparent);
	}

	.target-grouped-node.active,
	.target-grouped-node.connection-origin,
	.target-grouped-node.selection-origin {
		background: var(--map-target-active-surface);
	}

	.target-grouped-node.connection-rejected {
		background: color-mix(in srgb, var(--map-red) 16%, var(--map-surface));
		outline: 2px solid color-mix(in srgb, var(--map-red) 88%, transparent);
		outline-offset: -2px;
		box-shadow:
			inset 0 0 0 1px color-mix(in srgb, var(--map-red) 44%, transparent),
			0 0 0 2px color-mix(in srgb, var(--map-red) 16%, transparent),
			0 0 18px 1px color-mix(in srgb, var(--map-red) 30%, transparent);
	}

	.target-grouped-node.connection-rejected::after {
		z-index: 3;
		background: color-mix(in srgb, var(--map-red) 76%, var(--map-line));
	}

	.graph-node.locked-node {
		cursor: default;
	}

	.node-lock-icon {
		position: absolute;
		top: 5px;
		right: 6px;
		width: 10px;
		height: 9px;
		border: 1.5px solid var(--map-muted);
		border-radius: 2px;
		opacity: 0.86;
		pointer-events: none;
	}

	.node-lock-icon::before {
		content: '';
		position: absolute;
		left: 1px;
		top: -6px;
		width: 5px;
		height: 6px;
		border: 1.5px solid var(--map-muted);
		border-bottom: 0;
		border-radius: 5px 5px 0 0;
	}

	.node-lock-icon::after {
		content: '';
		position: absolute;
		left: 3px;
		top: 2px;
		width: 2px;
		height: 3px;
		border-radius: 999px;
		background: var(--map-muted);
	}

	.node-info {
		position: absolute;
		top: 4px;
		right: 5px;
		z-index: 7;
		display: grid;
		place-items: center;
		width: 13px;
		height: 13px;
		pointer-events: auto;
	}

	.locked-node .node-info {
		right: 20px;
	}

	.node-info-mark {
		display: grid;
		place-items: center;
		width: 11px;
		height: 11px;
		border: 1px solid color-mix(in srgb, var(--node-accent) 72%, var(--map-muted));
		border-radius: 999px;
		color: var(--node-accent);
		background: color-mix(in srgb, var(--map-surface) 86%, transparent);
		font-family: ui-sans-serif, system-ui, sans-serif;
		font-size: 8px;
		font-weight: 900;
		line-height: 1;
		opacity: 0.86;
	}

	.node-info-overlay {
		position: absolute;
		right: -8px;
		bottom: 12px;
		z-index: 20;
		display: none;
		width: max-content;
		min-width: 190px;
		max-width: min(280px, calc(100vw - 40px));
		padding: 9px 10px;
		border: 1px solid color-mix(in srgb, var(--node-accent) 48%, var(--map-line));
		border-radius: 6px;
		color: var(--map-text);
		background: color-mix(in srgb, var(--map-surface) 96%, var(--map-canvas));
		box-shadow: 0 12px 30px rgba(0, 0, 0, 0.34);
		text-align: left;
	}

	.node-info[data-tooltip-placement='below'] .node-info-overlay {
		top: 12px;
		bottom: auto;
	}

	.node-info:hover .node-info-overlay {
		display: grid;
		gap: 5px;
	}

	.node-info-overlay strong {
		color: var(--map-muted);
		font-size: 10px;
		font-weight: 900;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.node-info-overlay code,
	.node-info-overlay small {
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--map-text);
		font-size: 11px;
		font-weight: 650;
		line-height: 1.35;
		white-space: normal;
	}

	.node-info-overlay code {
		padding: 2px 4px;
		border: 1px solid var(--map-line);
		border-radius: 4px;
		background: var(--map-canvas);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	.node-info-overlay small {
		color: var(--map-muted);
		font-weight: 600;
	}

	.node-handle {
		position: absolute;
		top: 50%;
		width: 9px;
		height: 9px;
		border: 2px solid var(--map-canvas);
		border-radius: 999px;
		background: #7f8ea3;
		box-shadow:
			0 0 0 1px rgba(213, 224, 238, 0.34),
			0 0 0 4px color-mix(in srgb, var(--node-accent) 10%, transparent);
		cursor: crosshair;
		transform: translateY(-50%);
		z-index: 3;
	}

	.node-handle.output {
		right: -6px;
	}

	.node-handle.input {
		left: -6px;
	}

	.source-node .node-handle.output,
	.destination-node .node-handle.input {
		background: var(--node-accent);
	}

	.target-node .node-handle {
		background: var(--map-brand);
	}

	.graph-node:hover .node-handle,
	.graph-node.active .node-handle,
	.graph-node.connection-origin .node-handle,
	.graph-node.selection-origin .node-handle,
	.graph-node.connection-related .node-handle,
	.graph-node.selection-related .node-handle {
		box-shadow:
			0 0 0 1px rgba(213, 224, 238, 0.48),
			0 0 0 4px color-mix(in srgb, var(--node-accent) 18%, transparent),
			0 0 12px color-mix(in srgb, var(--node-accent) 42%, transparent);
	}

	.node-badge-row,
	.target-badge-row {
		position: absolute;
		left: 7px;
		right: 7px;
		bottom: 6px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 3px;
		pointer-events: none;
	}

	.node-badge-row {
		justify-content: flex-start;
	}

	.target-badges {
		display: flex;
		align-items: center;
		gap: 3px;
	}

	.target-badge {
		height: 9px;
		padding: 0 3px;
		border: 1px solid color-mix(in srgb, var(--map-brand) 36%, transparent);
		border-radius: 2px;
		color: var(--map-muted);
		background: color-mix(in srgb, var(--map-surface-muted) 86%, transparent);
		font-family:
			ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
			monospace;
		font-size: 7px;
		font-weight: 700;
		line-height: 8px;
	}

	.target-badge.required {
		color: var(--map-amber);
		border-color: color-mix(in srgb, var(--map-amber) 56%, transparent);
	}

	.target-badge.type {
		color: var(--map-brand);
		border-color: color-mix(in srgb, var(--map-brand) 52%, transparent);
	}

	.target-badge.cardinality {
		min-width: 20px;
		text-align: center;
	}

	.target-badge.cardinality-one {
		color: var(--map-muted);
		border-color: color-mix(in srgb, var(--map-muted) 42%, transparent);
	}

	.target-badge.cardinality-many {
		color: var(--map-teal);
		border-color: color-mix(in srgb, var(--map-teal) 54%, transparent);
	}

	.target-badge.pii {
		color: var(--map-red);
		border-color: color-mix(in srgb, var(--map-red) 52%, transparent);
	}

	.target-badge.non-pii {
		color: var(--map-green);
		border-color: color-mix(in srgb, var(--map-green) 52%, transparent);
	}

	.right-pane {
		overflow: auto;
	}

	.tab-bar {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 4px;
		margin: 14px 14px 0;
		padding: 4px;
		border: 1px solid var(--map-line);
		border-radius: var(--map-radius);
		background: var(--map-surface-muted);
	}

	.tab-bar button {
		height: 32px;
		border: 0;
		border-radius: 4px;
		color: var(--map-muted);
		background: transparent;
		font-size: 12px;
		font-weight: 900;
	}

	.tab-bar button.active {
		color: var(--map-text);
		background: var(--map-surface);
	}

	.detail-list {
		display: grid;
		gap: 10px;
		margin: 0;
		padding: 14px;
	}

	.transform-config-card {
		display: grid;
		gap: 12px;
		margin: 14px 14px 0;
		padding: 12px;
		border: 1px solid color-mix(in srgb, var(--map-green) 48%, var(--map-line));
		border-radius: var(--map-radius);
		background: color-mix(in srgb, var(--map-green) 7%, var(--map-surface-muted));
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--map-green) 16%, transparent);
	}

	.transform-config-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
	}

	.transform-config-header > div {
		min-width: 0;
	}

	.transform-config-header h3 {
		margin: 2px 0 0;
		font-size: 14px;
		overflow-wrap: anywhere;
	}

	.transform-description {
		margin: 0;
		color: var(--map-muted);
		font-size: 12px;
		line-height: 1.45;
	}

	.inspector-field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.inspector-field select,
	.inspector-field input {
		width: 100%;
		min-width: 0;
	}

	.inspector-field > span {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: var(--map-muted);
		font-size: 11px;
		font-weight: 900;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.inspector-field em {
		color: var(--map-amber);
		font-style: normal;
		font-size: 10px;
		letter-spacing: 0;
		text-transform: none;
	}

	.inline-check {
		display: inline-flex;
		align-items: center;
		justify-content: flex-start;
		gap: 8px;
		color: var(--map-text);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0;
		text-transform: none;
	}

	.inline-check input {
		width: 15px;
		height: 15px;
		accent-color: var(--map-brand);
	}

	.detail-list div,
	.dryrun-card,
	.diff-card,
	.control-block {
		border: 1px solid var(--map-line);
		border-radius: var(--map-radius);
		background: var(--map-surface-muted);
	}

	.detail-list div {
		padding: 10px;
	}

	.detail-list dt {
		margin-bottom: 4px;
		color: var(--map-muted);
		font-size: 11px;
		font-weight: 900;
		text-transform: uppercase;
	}

	.detail-list dd {
		margin: 0;
		font-size: 13px;
		font-weight: 700;
		line-height: 1.4;
	}

	.dryrun-card,
	.diff-card,
	.control-block {
		margin: 14px;
		padding: 12px;
	}

	.value-pair {
		display: grid;
		gap: 5px;
		margin-bottom: 10px;
	}

	.dryrun-action {
		width: fit-content;
		min-height: 32px;
		margin-bottom: 12px;
		padding: 0 12px;
		border: 1px solid var(--map-brand);
		border-radius: var(--map-radius);
		color: var(--map-brand);
		background: color-mix(in srgb, var(--map-brand) 8%, var(--map-surface));
		font-size: 12px;
		font-weight: 800;
	}

	.dryrun-action:hover,
	.dryrun-action:focus-visible {
		background: color-mix(in srgb, var(--map-brand) 14%, var(--map-surface));
	}

	code {
		display: block;
		padding: 10px;
		border: 1px solid var(--map-line);
		border-radius: 4px;
		background: #0b1220;
		color: #f8fafc;
		font-family: SFMono-Regular, Consolas, monospace;
		font-size: 12px;
		line-height: 1.5;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.trace-box {
		padding: 10px;
		border-left: 3px solid var(--map-brand);
		border-radius: 4px;
		background: rgba(96, 165, 250, 0.12);
		font-size: 13px;
		line-height: 1.45;
	}

	.diff-list {
		display: grid;
		gap: 8px;
		margin: 12px 0 0;
		padding: 0;
		list-style: none;
	}

	.diff-list li,
	.control-row {
		padding: 10px 12px;
		border: 1px solid var(--map-line);
		border-radius: var(--map-radius);
		background: var(--map-surface);
		font-size: 13px;
		line-height: 1.45;
	}

	.control-block {
		display: grid;
		gap: 8px;
	}

	.control-row {
		justify-content: space-between;
		gap: 12px;
	}

	.risk-low,
	.dryrun-status.ok {
		color: var(--map-green);
		background: rgba(74, 222, 128, 0.12);
	}

	.risk-medium,
	.dryrun-status.warn {
		color: var(--map-amber);
		background: rgba(251, 191, 36, 0.12);
	}

	.risk-high,
	.dryrun-status.stop {
		color: var(--map-red);
		background: rgba(248, 113, 113, 0.12);
	}

	@media (max-width: 1180px) {
		.workspace {
			grid-template-columns: 1fr;
		}
	}
</style>
