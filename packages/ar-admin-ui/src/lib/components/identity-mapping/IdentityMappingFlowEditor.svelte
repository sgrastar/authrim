<script lang="ts">
	import { beforeNavigate } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import {
		type MappingAdapter,
		type MappingDraftPayload,
		type MappingDraftRuleInput,
		type MappingEdge,
		type MappingNode,
		type MappingSample,
		type TransformOperation
	} from './types';

	type ViewMode = 'overview' | 'inbound' | 'outbound';
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
		  };
	type TransformOperationSchema = {
		operation: TransformOperation;
		label: string;
		description: string;
		parameters: TransformParameterSchema[];
	};

	const transformOperationSchemas: TransformOperationSchema[] = [
		{
			operation: 'copy',
			label: 'Copy',
			description: 'Pass the first input value through unchanged.',
			parameters: []
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
					placeholder: 'space, comma, or custom text'
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

	const {
		samples = [],
		loading = false,
		loadError = null,
		allowedViewModes = ['overview', 'inbound', 'outbound'],
		initialViewMode = 'overview',
		editable = true,
		showToolbarSourceProfile = true,
		showToolbarModeToggle = true,
		showMetrics = true,
		showLaneProfileSelectors = true,
		selectedViewMode = null,
		selectedProfileId = null,
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
		showLaneProfileSelectors?: boolean;
		selectedViewMode?: ViewMode | null;
		selectedProfileId?: string | null;
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
		inboundAdapter: 'CSV',
		outboundAdapter: 'OIDC',
		activeRuleId: 'empty-flow',
		metrics: ['0 / 0', '0 schemas', '0', 'no catalog'],
		nodes: [],
		edges: [],
		rules: {}
	};
	const nodeHeight = 30;
	const targetHeight = 46;
	const transformWidth = 168;
	const transformHeight = 38;
	const graphBaseTop = $derived(showLaneProfileSelectors ? 76 : 48);
	const graphStep = 50;
	const targetGroupHeaderHeight = 28;
	const targetGroupRowStep = targetHeight - 1;
	const targetGroupGap = 10;

	let canvas: HTMLDivElement;
	let canvasWidth = $state(1000);
	let sample = $state(emptySample);
	let selectedSampleId = $state<string | null>(null);
	let activeSampleRef: MappingSample | null = null;
	let inboundAdapter = $state<MappingAdapter>(emptySample.inboundAdapter);
	let outboundAdapter = $state<MappingAdapter>(emptySample.outboundAdapter);
	let selectedDestinationProfileId = $state<string | null>(null);
	let activeRuleId = $state(emptySample.activeRuleId);
	let activeTab = $state<'rule' | 'dryrun' | 'diff'>('rule');
	let viewMode = $state<ViewMode>('overview');
	let viewModeInitialized = false;
	let customCounter = $state(0);
	let nodes = $state<MappingNode[]>([...emptySample.nodes]);
	let edges = $state<MappingEdge[]>([...emptySample.edges]);
	let hoverNodeId = $state<string | null>(null);
	let selectedNodeId = $state<string | null>(null);
	let selectedEdgeId = $state<string | null>(null);
	let collapsedTargetGroupKeys = $state<string[]>([]);
	let hasUnsavedDraftChanges = $state(false);
	let activeDraftResetKey = $state<number | null>(null);
	let draftSubmitStatus = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
	let draftSubmitMessage = $state<string | null>(null);
	let dragState = $state<{
		fromNodeId: string;
		from: Point;
		to: Point;
		validTarget: boolean | null;
		targetNodeId: string | null;
	} | null>(null);
	let pendingConnectionStart: {
		fromNodeId: string;
		startClient: Point;
		from: Point;
	} | null = null;
	let suppressNextNodeClickId: string | null = null;

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

	const visibleNodes = $derived(
		nodes.filter(
			(node) =>
				node.role === 'target' ||
				node.role === 'transform' ||
				(node.role === 'source' && viewMode !== 'outbound') ||
				(node.role === 'destination' && viewMode !== 'inbound')
		)
	);
	const overviewLayerSourceNodes = $derived(
		viewMode === 'overview'
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
				adapter: candidate.inboundAdapter
			})
		)
	);
	const destinationProfileOptions = $derived(destinationProfileOptionsForSample(sample));
	const hasControlPlaneData = $derived(samples.length > 0);
	const layout = $derived(buildLayout());
	const laidOutNodes = $derived(layout.nodes);
	const graphEdges = $derived(
		edges.filter((edge) => {
			const fromNode = layoutNodeById(edge.from);
			const toNode = layoutNodeById(edge.to);
			return fromNode && toNode && !fromNode.hidden && !toNode.hidden;
		})
	);
	const selectedEdge = $derived(
		selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) : null
	);
	const selectedEdges = $derived(
		new Set([...connectedEdgeIds(selectedNodeId), ...(selectedEdgeId ? [selectedEdgeId] : [])])
	);
	const hoverEdges = $derived(connectedEdgeIds(hoverNodeId));
	const enabledViewModes = $derived(
		allowedViewModes.length > 0 ? allowedViewModes : (['overview'] satisfies ViewMode[])
	);
	const rule = $derived(
		selectedEdge ? edgeInspectorRule(selectedEdge) : (sample.rules[activeRuleId] ?? fallbackRule())
	);
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
			selectedViewMode === 'inbound' &&
			selectedProfileId &&
			selectedProfileId !== selectedSampleId
		) {
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
		if (selectedViewMode === 'outbound' && selectedProfileId) {
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
		const shouldLeave = window.confirm(
			'You have unsaved mapping draft changes. Leave this page and discard them?'
		);
		if (!shouldLeave) {
			navigation.cancel();
		}
	});

	onMount(() => {
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

	function activateSample(next: MappingSample) {
		activeSampleRef = next;
		sample = {
			...next,
			nodes: [...next.nodes],
			edges: [...next.edges],
			rules: { ...next.rules }
		};
		selectedSampleId = next.id;
		inboundAdapter = next.inboundAdapter;
		outboundAdapter = next.outboundAdapter;
		selectedDestinationProfileId =
			destinationProfileOptionsForSample(next).find((option) => option.adapter === 'OIDC')?.id ??
			destinationProfileOptionsForSample(next)[0]?.id ??
			null;
		activeRuleId = next.activeRuleId;
		nodes = [...next.nodes];
		edges = [...next.edges];
		selectedEdgeId = null;
		selectedNodeId = null;
		hasUnsavedDraftChanges = false;
	}

	function resetDraftFromCurrentSample() {
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
	}

	onDestroy(() => {
		window.removeEventListener('pointermove', handlePointerMove);
		window.removeEventListener('pointerup', handlePointerUp);
		window.removeEventListener('pointermove', handleEasyConnectionPointerMove);
		window.removeEventListener('pointerup', handleEasyConnectionPointerUp);
	});

	function nodeById(id: string): MappingNode | undefined {
		return nodes.find((node) => node.id === id);
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
	}

	function selectEdge(edge: MappingEdge) {
		selectedEdgeId = edge.id;
		selectedNodeId = null;
	}

	function clearSelection() {
		selectedEdgeId = null;
		selectedNodeId = null;
		hoverNodeId = null;
	}

	function markDraftDirty() {
		hasUnsavedDraftChanges = true;
		draftSubmitStatus = 'idle';
		draftSubmitMessage = null;
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

	function buildLayout(): {
		nodes: LayoutNode[];
		targetGroups: LayoutTargetGroup[];
		height: number;
	} {
		const rowTops: Record<string, number> = {};
		const targetPositions: Record<string, LayoutNode['targetGroupPosition']> = {};

		const width = Math.max(190, canvasWidth * 0.23);
		const sourceLeft = viewMode === 'inbound' ? Math.max(26, canvasWidth * 0.08) : 26;
		const targetLeft =
			viewMode === 'outbound'
				? Math.max(26, canvasWidth * 0.12)
				: viewMode === 'inbound'
					? Math.min(
							canvasWidth - width - 26,
							Math.max(sourceLeft + width + 100, canvasWidth * 0.66)
						)
					: canvasWidth * 0.385;
		const destinationLeft =
			viewMode === 'outbound'
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
			const selected = node.profileId
				? node.profileId === sample.id
				: node.adapter === inboundAdapter;
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

		const transformLayout = transformNodes.map((node) => ({
			...node,
			top: node.layoutPosition?.y ?? graphBaseTop,
			left: node.layoutPosition?.x ?? (sourceLeft + targetLeft + width) / 2 - transformWidth / 2,
			width: transformWidth,
			height: transformHeight,
			hidden: false,
			stackIndex: 0
		}));

		let visibleDestinationOffset = 0;
		const hiddenDestinationRowOffsets: Record<string, number> = {};

		const destinationLayout = destinationNodes.map((node) => {
			const selected = node.profileId
				? node.profileId === selectedDestinationProfileId
				: node.adapter === outboundAdapter;
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
			(dragState?.validTarget === false && dragState.targetNodeId === node.id);
		const zIndex = node.hidden
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
		return {
			x: direction === 'from' ? node.left + node.width : node.left,
			y: node.top + node.height / 2
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
		const fromNode = nodeById(edge.from);
		const toNode = nodeById(edge.to);
		const adapter = fromNode?.role === 'target' ? toNode?.adapter : fromNode?.adapter;
		if (adapter === 'SAML') return 'var(--map-violet)';
		if (adapter === 'OIDC') return 'var(--map-amber)';
		if (adapter === 'SCIM') return 'var(--map-brand)';
		if (adapter === 'CSV') return 'var(--map-teal)';
		return 'var(--map-brand)';
	}

	function edgeClasses(edge: MappingEdge): string {
		const fromNode = layoutNodeById(edge.from);
		const toNode = layoutNodeById(edge.to);
		return [
			'edge',
			edge.outbound ? 'outbound-edge' : '',
			edge.custom ? 'custom-edge' : '',
			edge.id === activeRuleId ? 'active' : '',
			edge.id === selectedEdgeId ? 'edge-picked' : '',
			hoverEdges.has(edge.id) ? 'edge-connected' : '',
			selectedEdges.has(edge.id) ? 'edge-selected' : '',
			fromNode?.hidden || toNode?.hidden ? 'edge-muted' : ''
		]
			.filter(Boolean)
			.join(' ');
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
			selectedRelated ? 'selection-related' : '',
			node.id === hoverNodeId ? 'connection-origin' : '',
			hoverRelated ? 'connection-related' : ''
		]
			.filter(Boolean)
			.join(' ');
	}

	function isValidConnection(
		fromNode: MappingNode | undefined,
		toNode: MappingNode | undefined
	): boolean {
		if (!fromNode || !toNode || fromNode.id === toNode.id) return false;
		if (fromNode.locked || toNode.locked) return false;
		const validDirection =
			(fromNode.role === 'source' && toNode.role === 'target') ||
			(fromNode.role === 'source' && toNode.role === 'transform') ||
			(fromNode.role === 'transform' && toNode.role === 'target') ||
			(fromNode.role === 'target' && toNode.role === 'destination') ||
			(fromNode.role === 'target' && toNode.role === 'transform') ||
			(fromNode.role === 'transform' && toNode.role === 'destination');
		return (
			validDirection &&
			isTypeCompatible(fromNode, toNode) &&
			!isDuplicateConnection(fromNode.id, toNode.id) &&
			!isTargetInputFull(fromNode, toNode)
		);
	}

	function isDuplicateConnection(fromNodeId: string, toNodeId: string): boolean {
		return edges.some((edge) => edge.from === fromNodeId && edge.to === toNodeId);
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
		const fromType = normalizeNodeType(fromNode.type);
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

	function connectionTargetForPointer(event: PointerEvent): MappingNode | undefined {
		const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
		const handle = target?.closest?.('.node-handle.input') as HTMLElement | null;
		const nodeElement = target?.closest?.('.graph-node') as HTMLElement | null;
		const toNodeId = handle?.dataset.nodeId ?? nodeElement?.dataset.nodeId;
		return toNodeId ? nodeById(toNodeId) : undefined;
	}

	function canvasPoint(event: PointerEvent): Point {
		const rect = canvas.getBoundingClientRect();
		return {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top
		};
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
		const fromNode = nodeById(dragState.fromNodeId);
		const toNode = connectionTargetForPointer(event);
		dragState = {
			...dragState,
			to: canvasPoint(event),
			validTarget: toNode ? isValidConnection(fromNode, toNode) : null,
			targetNodeId: toNode?.id ?? null
		};
	}

	function handlePointerUp(event: PointerEvent) {
		if (!dragState) return;
		const fromNode = nodeById(dragState.fromNodeId);
		const toNode = connectionTargetForPointer(event);
		if (isValidConnection(fromNode, toNode) && toNode) {
			addEdge(dragState.fromNodeId, toNode.id);
		}
		dragState = null;
		window.removeEventListener('pointermove', handlePointerMove);
		window.removeEventListener('pointerup', handlePointerUp);
	}

	function addEdge(from: string, to: string) {
		if (!editable) return;
		if (!isValidConnection(nodeById(from), nodeById(to))) return;
		if (edges.some((edge) => edge.from === from && edge.to === to)) return;
		customCounter += 1;
		const edge = {
			id: `custom-edge-${customCounter}`,
			from,
			to,
			outbound: nodeById(from)?.role === 'target',
			custom: true
		};
		edges = [...edges, edge];
		selectedEdgeId = edge.id;
		selectedNodeId = null;
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
		const operation: TransformOperation = 'copy';
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
				outbound: edge.outbound,
				custom: true
			},
			{
				id: `${edge.id}-out-${customCounter}`,
				from: nodeId,
				to: edge.to,
				outbound: edge.outbound,
				custom: true
			}
		];
		sample.rules[ruleId] = {
			...fallbackRule(),
			title: transformNode.label,
			source: 'Inserted on selected mapping edge',
			target: 'Transform node',
			destination: 'Continues to the original edge target',
			transform: transformSummary(operation, parameters),
			validation: 'draft transform node inserted',
			trace: 'This transform node was inserted into an existing mapping edge.'
		};
		activeRuleId = ruleId;
		selectedNodeId = nodeId;
		selectedEdgeId = null;
		markDraftDirty();
	}

	function deleteSelectedEdge() {
		if (!editable || !selectedEdgeId) return;
		edges = edges.filter((edge) => edge.id !== selectedEdgeId);
		selectedEdgeId = null;
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
					outbound: outEdge.outbound || inEdge.outbound,
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
		if (!fromNode || !toNode || fromNode.id === toNode.id) return false;
		if (fromNode.locked || toNode.locked) return false;
		const validDirection =
			(fromNode.role === 'source' && toNode.role === 'target') ||
			(fromNode.role === 'target' && toNode.role === 'destination');
		return (
			validDirection &&
			isTypeCompatible(fromNode, toNode) &&
			!isTargetInputFull(fromNode, toNode, ignoredEdgeIds, extraEdges)
		);
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
			!window.confirm('You have unsaved mapping draft changes. Switch profiles and discard them?')
		) {
			select.value = selectedSampleId ?? emptySample.id;
			return;
		}
		selectedSampleId = nextId;
	}

	function selectDestinationProfile(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		selectedDestinationProfileId = select.value;
		outboundAdapter =
			destinationProfileOptions.find((option) => option.id === selectedDestinationProfileId)
				?.adapter ?? outboundAdapter;
	}

	function addNode(role: 'source' | 'destination') {
		if (!editable) return;
		customCounter += 1;
		const adapter = role === 'source' ? inboundAdapter : outboundAdapter;
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
			source: role === 'source' ? `${adapter} adapter / ${node.label}` : 'Custom graph edge',
			destination:
				role === 'destination' ? `${adapter} adapter / ${node.label}` : 'Not connected yet',
			trace: 'Custom draft node added. Drag a connection handle to attach it to canonical schema.'
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

	function defaultTransformParameters(operation: TransformOperation): Record<string, string> {
		if (operation === 'normalize') return { mode: 'whitespace' };
		if (operation === 'case') return { mode: 'lower' };
		if (operation === 'concat') return { delimiter: ' ' };
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
		parameters: Record<string, string> = {}
	): Record<string, string> {
		const schema = transformSchema(operation);
		const defaults = defaultTransformParameters(operation);
		const sanitized: Record<string, string> = {};
		for (const parameter of schema.parameters) {
			const value = parameters[parameter.name] ?? defaults[parameter.name] ?? '';
			if (parameter.kind === 'enum') {
				sanitized[parameter.name] = parameter.options.some((option) => option.value === value)
					? value
					: (parameter.options[0]?.value ?? '');
			} else {
				sanitized[parameter.name] = value;
			}
		}
		return sanitized;
	}

	function transformSummary(
		operation: TransformOperation,
		parameters: Record<string, string> = {}
	): string {
		const schema = transformSchema(operation);
		const entries = schema.parameters
			.map((parameter) => {
				const value = parameters[parameter.name];
				return value ? `${parameter.name}=${JSON.stringify(value)}` : null;
			})
			.filter(Boolean);
		return entries.length > 0 ? `${operation}(${entries.join(', ')})` : operation;
	}

	function transformCaption(
		operation: TransformOperation,
		parameters: Record<string, string> = {}
	): string {
		const schema = transformSchema(operation);
		if (schema.parameters.length === 0) return schema.label.toLowerCase();
		const values = schema.parameters
			.map((parameter) => parameters[parameter.name])
			.filter((value) => value && value.length > 0);
		return [schema.label.toLowerCase(), ...values].join(' / ');
	}

	function updateRuleDetail(ruleId: string, patch: Partial<ReturnType<typeof fallbackRule>>) {
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
		parameters: Record<string, string>
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
			updateRuleDetail(ruleId, {
				transform: transformSummary(operation, sanitized),
				validation: 'draft transform configured; compile validation pending',
				output: `Transform output preview pending for ${transformSummary(operation, sanitized)}.`,
				trace:
					'Transform configuration is stored on the draft node and will be persisted as a mapping transform step.'
			});
		}
		markDraftDirty();
	}

	function updateTransformOperation(node: MappingNode, value: string) {
		const operation = transformOperation(value);
		updateTransformNode(node.id, operation, defaultTransformParameters(operation));
	}

	function updateTransformParameter(node: MappingNode, parameterName: string, value: string) {
		const operation = activeTransformOperation(node);
		updateTransformNode(node.id, operation, {
			...sanitizeTransformParameters(operation, node.transformParameters),
			[parameterName]: value
		});
	}

	function nodeFieldRef(node: MappingNode): Record<string, unknown> {
		return {
			nodeId: node.id,
			role: node.role,
			label: node.label,
			path: node.caption || node.label,
			adapter: node.adapter,
			profileId: node.profileId,
			profileTitle: node.profileTitle,
			valueType: node.type,
			storageTarget: node.storageTarget,
			uiGroupKey: node.uiGroupKey,
			locked: node.locked
		};
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
		const edgeKind = fromNode.role === 'target' ? 'outbound_release' : 'inbound_mapping';
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
					sourceRef: nodeFieldRef(fromNode),
					targetRef: nodeFieldRef(toNode),
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
			const edgeKind = toNode.role === 'destination' ? 'outbound_transform' : 'inbound_transform';
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
						sourceRef: nodeFieldRef(fromNode),
						targetRef: nodeFieldRef(toNode),
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
			draftSubmitMessage = 'Connect at least one mapping edge before compiling a draft.';
			return;
		}
		if (!onCompileDraft) {
			draftSubmitStatus = 'error';
			draftSubmitMessage = 'Compile draft is not connected on this page.';
			return;
		}
		draftSubmitStatus = 'saving';
		draftSubmitMessage = 'Saving draft policy version...';
		try {
			await onCompileDraft(draft);
			draftSubmitStatus = 'saved';
			draftSubmitMessage = 'Draft policy version saved and compiled.';
			hasUnsavedDraftChanges = false;
			onDraftDirtyChange?.(false);
		} catch (error) {
			draftSubmitStatus = 'error';
			draftSubmitMessage =
				error instanceof Error ? error.message : 'Failed to compile mapping draft.';
		}
	}

	function edgeInspectorRule(edge: MappingEdge) {
		const fromNode = nodeById(edge.from);
		const toNode = nodeById(edge.to);
		const base = sample.rules[fromNode?.ruleId ?? toNode?.ruleId ?? activeRuleId] ?? fallbackRule();
		const source =
			fromNode?.role === 'source'
				? `${fromNode.adapter} / ${fromNode.label}`
				: (base.source ?? 'Not connected');
		const target =
			fromNode?.role === 'target'
				? fromNode.label
				: toNode?.role === 'target'
					? toNode.label
					: (base.target ?? 'No canonical target selected');
		const destination =
			toNode?.role === 'destination'
				? `${toNode.adapter} / ${toNode.label}`
				: (base.destination ?? 'Not connected');
		return {
			...base,
			title: `${fromNode?.label ?? 'Mapping edge'} -> ${toNode?.label ?? 'Target'}`,
			source,
			target,
			destination,
			validation: edge.custom
				? 'draft edge selected; Backspace/Delete removes it'
				: 'loaded edge selected; Backspace/Delete removes it from this draft',
			trace: 'Selected edge. Press Backspace or Delete to remove this connection from the draft.'
		};
	}

	function fallbackRule() {
		return {
			title: 'Mapping node',
			risk: 'medium' as const,
			source: 'Selected graph node',
			target: 'Connected canonical target',
			destination: 'Connected destination',
			transform: 'not configured',
			validation: 'not configured',
			release: 'not configured',
			storageTarget: 'not configured',
			consentStatus: 'not_required' as const,
			legalBasis: 'legitimate_interest' as const,
			purpose: 'not configured',
			attributeSetHash: 'not configured',
			consentMode: 'not_applicable' as const,
			releasePolicyVersion: 'not configured',
			termsVersion: 'not configured',
			privacyPolicyVersion: 'not configured',
			denyReason: 'none',
			runtime: 'graph preview',
			conflict: 'not evaluated',
			disclosure: 'redacted summary',
			dryrunStatus: 'pending',
			dryrunTone: 'warn' as const,
			input: 'No runtime input selected.',
			output: 'No mapping edge yet.',
			trace: 'Select a mapping node to inspect rule behavior.',
			review: '0 tasks',
			replay: 'no',
			diffSeverity: 'medium' as const,
			diffTitle: 'Draft-only node',
			diff: ['This node exists only in the local draft preview.']
		};
	}
</script>

<section class="mapping-shell">
	<div class="workspace">
		<section class="pane graph-pane" aria-label="Mapping graph">
			<div class="graph-toolbar">
				<div>
					<p class="section-kicker">Policy draft</p>
					<h2>{sample.title}</h2>
				</div>
				<div class="graph-actions">
					{#if showToolbarSourceProfile}
						<label class="source-profile-select" for="sourceProfile">
							<span>Source profile</span>
							<select
								id="sourceProfile"
								value={selectedSampleId ?? emptySample.id}
								disabled={loading || samples.length === 0}
								onchange={selectSample}
							>
								{#if samples.length === 0}
									<option value={emptySample.id}>No profiles</option>
								{:else}
									{#each samples as option (option.id)}
										<option value={option.id}>{option.title}</option>
									{/each}
								{/if}
							</select>
						</label>
					{/if}
					{#if showToolbarModeToggle}
						<div class="mode-toggle" aria-label="Flow view mode">
							{#each enabledViewModes as mode (mode)}
								<button
									class:active={viewMode === mode}
									type="button"
									onclick={() => (viewMode = mode)}
								>
									{mode === 'overview'
										? 'Overview'
										: mode === 'inbound'
											? 'Inbound mapping'
											: 'Outbound release'}
								</button>
							{/each}
						</div>
					{/if}
					<button
						class="primary-action"
						type="button"
						disabled={!editable || draftSubmitStatus === 'saving'}
						onclick={submitDraftForCompile}
					>
						{draftSubmitStatus === 'saving' ? 'Compiling...' : 'Compile draft'}
					</button>
				</div>
			</div>
			{#if draftSubmitMessage}
				<p class={`draft-submit-message ${draftSubmitStatus}`}>{draftSubmitMessage}</p>
			{/if}

			<div class="health-strip">
				<span><strong>Snapshot</strong> {sample.snapshot}</span>
				<span class="status-ok">{sample.status}</span>
				<span class="status-warn">{sample.reviewGates}</span>
			</div>

			{#if showMetrics}
				<div class="metric-row">
					<div class="metric">
						<span>Mapped fields</span>
						<strong>{sample.metrics[0]}</strong>
					</div>
					<div class="metric">
						<span>Hot-path reads</span>
						<strong>{sample.metrics[1]}</strong>
					</div>
					<div class="metric">
						<span>Release denies</span>
						<strong>{sample.metrics[2]}</strong>
					</div>
					<div class="metric">
						<span>Catalog version</span>
						<strong>{sample.metrics[3]}</strong>
					</div>
				</div>
			{/if}

			<div
				class={`graph-canvas view-${viewMode}`}
				bind:this={canvas}
				style={`height:${layout.height}px`}
			>
				{#if loading || loadError || !hasControlPlaneData}
					<div class="graph-empty-state">
						<strong
							>{loading
								? 'Loading control-plane schemas'
								: loadError
									? 'Control-plane schema load failed'
									: 'No source or destination profiles registered'}</strong
						>
						<span
							>{loading
								? 'The graph will render protocol, external, and canonical schemas when loading completes.'
								: loadError
									? loadError
									: 'Register source and destination profiles, or add a field catalog, to populate this graph.'}</span
						>
					</div>
				{/if}
				{#if viewMode !== 'outbound'}
					<div class="lane-label lane-inbound">
						<span>Inbound profile</span>
						{#if showLaneProfileSelectors}
							<select
								value={selectedSampleId ?? emptySample.id}
								disabled={sourceProfileOptions.length === 0}
								onchange={selectSample}
							>
								{#each sourceProfileOptions as option (option.id)}
									<option value={option.id}>{option.title}</option>
								{/each}
							</select>
							{#if editable}
								<button class="mini-tool-button" type="button" onclick={() => addNode('source')}
									>+</button
								>
							{/if}
						{/if}
					</div>
				{/if}
				<div class="lane-label lane-canonical">
					<span>Canonical targets</span>
				</div>
				{#each layout.targetGroups as group (group.key)}
					<button
						class={`target-group-header ${group.collapsed ? 'collapsed' : ''}`}
						style={targetGroupStyle(group)}
						type="button"
						aria-expanded={!group.collapsed}
						aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} ${group.label} target group`}
						onclick={(event) => {
							event.stopPropagation();
							toggleTargetGroup(group.key);
						}}
					>
						<span class="target-group-title">{group.label}</span>
						<span class="target-group-count">{group.count}</span>
						<span class="target-group-chevron" aria-hidden="true"></span>
					</button>
				{/each}
				{#if viewMode !== 'inbound'}
					<div class="lane-label lane-outbound">
						<span>Outbound profile</span>
						{#if showLaneProfileSelectors}
							<select
								value={selectedDestinationProfileId ?? ''}
								disabled={destinationProfileOptions.length === 0}
								onchange={selectDestinationProfile}
							>
								{#each destinationProfileOptions as option (option.id)}
									<option value={option.id}>{option.title}</option>
								{/each}
							</select>
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
					aria-label="Mapping edges"
				>
					<rect
						class="edge-blank-hit"
						x="0"
						y="0"
						width={canvasWidth}
						height={layout.height}
						role="button"
						tabindex="0"
						aria-label="Clear mapping selection"
						onclick={clearSelection}
						onkeydown={handleClearSelectionKeyDown}
					/>
					{#each graphEdges as edge (edge.id)}
						<path
							class="edge-hit"
							d={edgePath(edge)}
							role="button"
							tabindex="0"
							aria-label={`Select mapping edge ${nodeById(edge.from)?.label ?? edge.from} to ${nodeById(edge.to)?.label ?? edge.to}`}
							onclick={(event) => {
								event.stopPropagation();
								selectEdge(edge);
							}}
							onkeydown={(event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									selectEdge(edge);
								}
							}}
						/>
						<path
							class={edgeClasses(edge)}
							style={`--edge-accent:${edgeAccent(edge)}`}
							d={edgePath(edge)}
						/>
						{#if editable && selectedEdges.has(edge.id) && canInsertTransformNode(edge)}
							{@const insertPoint = edgeInsertPoint(edge)}
							{#if insertPoint}
								<g
									class="edge-insert-control"
									transform={`translate(${insertPoint.x} ${insertPoint.y})`}
									style={`--edge-accent:${edgeAccent(edge)}`}
									role="button"
									tabindex="0"
									aria-label="Insert transform node on selected mapping edge"
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
									aria-label="Delete selected mapping edge"
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
							{#if !node.locked && (node.role === 'destination' || node.role === 'transform' || (node.role === 'target' && viewMode !== 'outbound'))}
								<span class="node-handle input" data-node-id={node.id} aria-hidden="true"></span>
							{/if}
							{#if node.locked}
								<span
									class="node-lock-icon"
									aria-hidden="true"
									title="Managed by subject identifier strategy"
								></span>
							{/if}
							<span>{node.label}</span>
							{#if node.caption}
								<small>{node.caption}</small>
							{/if}
							{#if node.role === 'target'}
								<span class="target-badge-row">
									<span class="target-badges">
										{#if node.type}<span class="target-badge type">{node.type}</span>{/if}
										<span
											class={`target-badge cardinality cardinality-${targetInputCardinality(node)}`}
											aria-label={`Accepts ${targetInputCardinality(node) === 'one' ? 'one input' : 'multiple inputs'}`}
										>
											{targetInputCardinalityLabel(node)}
										</span>
									</span>
									<span class="target-badges meta-badges">
										{#if node.required}<span class="target-badge required">Required</span>{/if}
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
							{#if editable && !node.locked && (node.role === 'source' || node.role === 'transform' || (node.role === 'target' && viewMode !== 'inbound'))}
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
							aria-label={`Delete ${node.label}`}
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

		<aside class="pane right-pane" aria-label="Mapping inspector">
			<div class="pane-header">
				<div>
					<p class="section-kicker">Inspector</p>
					<h2>{rule.title}</h2>
				</div>
				<span class={`risk-badge risk-${rule.risk}`}>{rule.risk}</span>
			</div>

			<div class="tab-bar" role="tablist" aria-label="Inspector tabs">
				<button
					class:active={activeTab === 'rule'}
					type="button"
					onclick={() => (activeTab = 'rule')}
				>
					Rule
				</button>
				<button
					class:active={activeTab === 'dryrun'}
					type="button"
					onclick={() => (activeTab = 'dryrun')}
				>
					Dry-run
				</button>
				<button
					class:active={activeTab === 'diff'}
					type="button"
					onclick={() => (activeTab = 'diff')}
				>
					Diff
				</button>
			</div>

			{#if activeTab === 'rule'}
				{#if selectedTransformNode}
					{@const schema = activeTransformSchema(selectedTransformNode)}
					<section class="transform-config-card" aria-label="Transform configuration">
						<div class="transform-config-header">
							<div>
								<p class="section-kicker">Transform step</p>
								<h3>{schema.label}</h3>
							</div>
							<span class="transform-operation-pill"
								>{activeTransformOperation(selectedTransformNode)}</span
							>
						</div>
						<label class="inspector-field" for={`transform-operation-${selectedTransformNode.id}`}>
							<span>Operation</span>
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
								{#each transformOperationSchemas as option (option.operation)}
									<option value={option.operation}>{option.label}</option>
								{/each}
							</select>
						</label>
						<p class="transform-description">{schema.description}</p>
						{#each schema.parameters as parameter (parameter.name)}
							<label
								class="inspector-field"
								for={`transform-${selectedTransformNode.id}-${parameter.name}`}
							>
								<span>
									{parameter.label}
									{#if parameter.required}<em>Required</em>{/if}
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
											<option value={option.value}>{option.label}</option>
										{/each}
									</select>
								{:else}
									<input
										id={`transform-${selectedTransformNode.id}-${parameter.name}`}
										value={sanitizeTransformParameters(
											activeTransformOperation(selectedTransformNode),
											selectedTransformNode.transformParameters
										)[parameter.name]}
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
					<div>
						<dt>Source</dt>
						<dd>{rule.source}</dd>
					</div>
					<div>
						<dt>Target</dt>
						<dd>{rule.target}</dd>
					</div>
					<div>
						<dt>Destination</dt>
						<dd>{rule.destination}</dd>
					</div>
					<div>
						<dt>Transform</dt>
						<dd>{rule.transform}</dd>
					</div>
					<div>
						<dt>Validation</dt>
						<dd>{rule.validation}</dd>
					</div>
					<div>
						<dt>Release</dt>
						<dd>{rule.release}</dd>
					</div>
					<div>
						<dt>Storage</dt>
						<dd>{rule.storageTarget ?? 'not configured'}</dd>
					</div>
				</dl>
			{:else if activeTab === 'dryrun'}
				<section class="dryrun-card">
					<div class="dryrun-header">
						<h3>Sample Evaluation</h3>
						<span class={`dryrun-status ${rule.dryrunTone}`}>{rule.dryrunStatus}</span>
					</div>
					<div class="value-pair">
						<span>Input</span>
						<code>{rule.input}</code>
					</div>
					<div class="value-pair">
						<span>Output</span>
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

			<div class="control-block">
				<div class="control-row">
					<span>Consent status</span>
					<strong>{rule.consentStatus.replaceAll('_', ' ')}</strong>
				</div>
				<div class="control-row">
					<span>Legal basis</span>
					<strong>{rule.legalBasis.replaceAll('_', ' ')}</strong>
				</div>
				<div class="control-row">
					<span>Purpose</span>
					<strong>{rule.purpose}</strong>
				</div>
				<div class="control-row">
					<span>Attribute set</span>
					<strong>{rule.attributeSetHash}</strong>
				</div>
				<div class="control-row">
					<span>Challenge mode</span>
					<strong>{rule.consentMode.replaceAll('_', ' ')}</strong>
				</div>
				<div class="control-row">
					<span>Release policy</span>
					<strong>{rule.releasePolicyVersion}</strong>
				</div>
				<div class="control-row">
					<span>Terms</span>
					<strong>{rule.termsVersion}</strong>
				</div>
				<div class="control-row">
					<span>Privacy Policy</span>
					<strong>{rule.privacyPolicyVersion}</strong>
				</div>
				<div class="control-row">
					<span>Deny reason</span>
					<strong>{rule.denyReason}</strong>
				</div>
			</div>

			<div class="control-block">
				<div class="control-row">
					<span>Runtime exposure</span>
					<strong>{rule.runtime}</strong>
				</div>
				<div class="control-row">
					<span>Conflict policy</span>
					<strong>{rule.conflict}</strong>
				</div>
				<div class="control-row">
					<span>Trace disclosure</span>
					<strong>{rule.disclosure}</strong>
				</div>
			</div>
		</aside>
	</div>
</section>

<style>
	.mapping-shell {
		--map-bg: var(--bg-card);
		--map-surface: var(--bg-card);
		--map-surface-muted: var(--bg-subtle);
		--map-canvas: color-mix(in srgb, var(--bg-card) 78%, var(--bg-page));
		--map-line: var(--border-color);
		--map-line-strong: color-mix(in srgb, var(--border-color) 70%, var(--text-muted));
		--map-text: var(--text-primary);
		--map-muted: var(--text-secondary);
		--map-brand: var(--primary);
		--map-teal: #0f766e;
		--map-green: #15803d;
		--map-amber: #b45309;
		--map-red: #b91c1c;
		--map-violet: #6d28d9;
		--map-radius: 4px;
		--map-edge-flow-distance: -24;
		--map-edge-flow-speed: 720ms;
		--map-edge-pulse-speed: 1.2s;
		--map-drag-edge-flow-speed: 620ms;
		--map-edge-dash-pattern: 6 6;
		--map-drag-edge-dash-pattern: 4 3;
		overflow: hidden;
		border: 1px solid var(--map-line);
		border-radius: 8px;
		background: var(--map-bg);
		color: var(--map-text);
	}

	:global([data-theme='dark']) .mapping-shell {
		--map-bg: color-mix(in srgb, var(--bg-card) 76%, #030712);
		--map-surface: color-mix(in srgb, var(--bg-card) 84%, #05070d);
		--map-surface-muted: color-mix(in srgb, var(--bg-subtle) 70%, #060914);
		--map-canvas: color-mix(in srgb, var(--bg-page) 34%, #05070d);
		--map-line: color-mix(in srgb, var(--border-color) 60%, #344156);
		--map-line-strong: #344156;
		--map-text: #e5edf6;
		--map-muted: #8ea0b7;
		--map-brand: #60a5fa;
		--map-teal: #2dd4bf;
		--map-green: #4ade80;
		--map-amber: #fbbf24;
		--map-red: #f87171;
		--map-violet: #a78bfa;
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
		font-size: 14px;
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

	.draft-submit-message.error {
		color: var(--map-red);
	}

	.workspace {
		display: grid;
		grid-template-columns: minmax(720px, 1fr) minmax(300px, 360px);
		gap: 14px;
		padding: 14px;
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
		overflow: hidden;
		background: var(--map-canvas);
	}

	.graph-empty-state {
		position: absolute;
		inset: 68px 24px auto;
		z-index: 6;
		display: grid;
		gap: 4px;
		max-width: 520px;
		padding: 14px 16px;
		border: 1px solid var(--map-line);
		border-radius: var(--map-radius);
		color: var(--map-text);
		background: color-mix(in srgb, var(--map-surface) 92%, transparent);
		box-shadow: 0 16px 40px rgb(0 0 0 / 0.18);
	}

	.graph-empty-state span {
		color: var(--map-muted);
		font-size: 12px;
		line-height: 1.45;
	}

	.lane-label {
		position: absolute;
		top: 12px;
		z-index: 4;
		display: grid;
		grid-template-columns: auto auto;
		align-items: center;
		gap: 7px;
		color: var(--map-muted);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.lane-label > span {
		grid-column: 1 / -1;
	}

	.lane-inbound {
		left: 16px;
	}

	.lane-canonical {
		left: 38%;
	}

	.lane-outbound {
		right: 16px;
	}

	.graph-canvas.view-inbound .lane-canonical {
		right: 16px;
		left: auto;
	}

	.graph-canvas.view-outbound .lane-canonical {
		left: 16px;
	}

	.graph-canvas.view-outbound .lane-outbound {
		right: 16px;
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
		background: color-mix(in srgb, var(--target-group-accent) 15%, var(--map-surface));
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--target-group-accent) 8%, transparent),
			0 4px 10px rgb(0 0 0 / 0.2);
		text-align: left;
	}

	.target-group-header:hover,
	.target-group-header:focus-visible {
		border-color: var(--target-group-accent);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--target-group-accent) 64%, transparent),
			0 0 18px color-mix(in srgb, var(--target-group-accent) 24%, transparent),
			0 6px 14px rgb(0 0 0 / 0.24);
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
		stroke: #5f7085;
		stroke-width: 1.5;
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

	.edge-muted {
		opacity: 0.1;
	}

	.edge.active {
		stroke: var(--edge-accent, var(--map-brand));
		stroke-width: 2.2;
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
		stroke-width: 2.1;
	}

	.edge.edge-selected {
		stroke-width: 2.7;
	}

	.edge.edge-picked {
		stroke-width: 3;
		filter: drop-shadow(
			0 0 4px color-mix(in srgb, var(--edge-accent, var(--map-brand)) 56%, transparent)
		);
	}

	.outbound-edge {
		stroke: #6f8198;
		opacity: 0.55;
	}

	.custom-edge {
		stroke: var(--map-teal);
		stroke-width: 2.6;
	}

	.drag-edge {
		stroke: var(--map-brand);
		stroke-width: 2.6;
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
		border-color: color-mix(in srgb, var(--node-accent) 72%, transparent);
	}

	.target-node {
		padding-bottom: 20px;
		border-color: rgba(96, 165, 250, 0.64);
	}

	.target-grouped-node {
		border-radius: 0;
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
		opacity: 0.22;
		filter: saturate(0.65);
		transform: translate(var(--stack-x), var(--stack-y));
		pointer-events: none;
	}

	.adapter-hidden::before {
		content: '';
		position: absolute;
		inset: 0;
		border: 1px solid var(--map-line-strong);
		border-radius: inherit;
		transform: translate(var(--stack-shadow-x), var(--stack-shadow-y));
		opacity: 0.38;
		pointer-events: none;
	}

	.graph-node span:not(.node-handle):not(.target-badge-row):not(.target-badge):not(.target-badges) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 14px;
		font-weight: 400;
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
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--map-red) 70%, transparent),
			0 0 0 4px color-mix(in srgb, var(--map-red) 16%, transparent),
			0 0 22px 2px var(--node-glow),
			0 8px 18px rgba(0, 0, 0, 0.3);
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

	.target-grouped-node:hover,
	.target-grouped-node.active,
	.target-grouped-node.connection-origin,
	.target-grouped-node.selection-origin,
	.target-grouped-node.connection-related,
	.target-grouped-node.selection-related {
		outline: 2px solid color-mix(in srgb, var(--node-accent) 88%, transparent);
		outline-offset: -2px;
		box-shadow:
			inset 0 0 0 1px color-mix(in srgb, var(--node-accent) 42%, transparent),
			0 0 0 2px color-mix(in srgb, var(--node-accent) 16%, transparent),
			0 0 18px 1px color-mix(in srgb, var(--node-accent) 28%, transparent);
	}

	.target-grouped-node.connection-rejected {
		outline: 2px solid color-mix(in srgb, var(--map-red) 88%, transparent);
		outline-offset: -2px;
		box-shadow:
			inset 0 0 0 1px color-mix(in srgb, var(--map-red) 44%, transparent),
			0 0 0 2px color-mix(in srgb, var(--map-red) 16%, transparent),
			0 0 18px 1px color-mix(in srgb, var(--map-red) 30%, transparent);
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

	.node-handle {
		position: absolute;
		top: 50%;
		width: 9px;
		height: 9px;
		border: 2px solid var(--map-canvas);
		border-radius: 999px;
		background: #7f8ea3;
		box-shadow: 0 0 0 1px rgba(213, 224, 238, 0.18);
		cursor: crosshair;
		transform: translateY(-50%);
		z-index: 3;
	}

	.node-handle.output {
		right: -5px;
	}

	.node-handle.input {
		left: -5px;
	}

	.source-node .node-handle.output,
	.destination-node .node-handle.input {
		background: var(--node-accent);
	}

	.target-node .node-handle {
		background: var(--map-brand);
	}

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

	.target-badges {
		display: flex;
		align-items: center;
		gap: 3px;
	}

	.target-badge {
		height: 11px;
		padding: 0 4px;
		border: 1px solid color-mix(in srgb, var(--map-brand) 36%, transparent);
		border-radius: 2px;
		color: var(--map-muted);
		background: color-mix(in srgb, var(--map-surface-muted) 86%, transparent);
		font-family:
			ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
			monospace;
		font-size: 8px;
		font-weight: 700;
		line-height: 10px;
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

	.transform-config-header h3 {
		margin: 2px 0 0;
		font-size: 14px;
	}

	.transform-operation-pill {
		padding: 3px 8px;
		border: 1px solid color-mix(in srgb, var(--map-green) 50%, transparent);
		border-radius: 999px;
		color: var(--map-green);
		background: color-mix(in srgb, var(--map-green) 11%, transparent);
		font-size: 11px;
		font-weight: 900;
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

	code {
		display: block;
		padding: 10px;
		border: 1px solid var(--map-line);
		border-radius: 4px;
		background: #0b1220;
		color: var(--map-text);
		font-family: SFMono-Regular, Consolas, monospace;
		font-size: 12px;
		white-space: normal;
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
