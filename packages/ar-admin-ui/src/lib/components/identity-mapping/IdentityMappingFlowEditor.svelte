<script lang="ts">
	import { beforeNavigate } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import {
		type MappingAdapter,
		type MappingEdge,
		type MappingNode,
		type MappingSample
	} from './types';

	const {
		samples = [],
		loading = false,
		loadError = null
	} = $props<{
		samples?: MappingSample[];
		loading?: boolean;
		loadError?: string | null;
	}>();

	const adapters: MappingAdapter[] = ['SAML', 'CSV', 'OIDC', 'SCIM'];
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
	const graphBaseTop = 48;
	const graphStep = 50;
	const rowGap = 12;

	let canvas: HTMLDivElement;
	let canvasWidth = $state(1000);
	let sample = $state(emptySample);
	let selectedSampleId = $state<string | null>(null);
	let activeSampleRef: MappingSample | null = null;
	let inboundAdapter = $state<MappingAdapter>(emptySample.inboundAdapter);
	let outboundAdapter = $state<MappingAdapter>(emptySample.outboundAdapter);
	let activeRuleId = $state(emptySample.activeRuleId);
	let activeTab = $state<'rule' | 'dryrun' | 'diff'>('rule');
	let viewMode = $state<'overview' | 'inbound' | 'outbound'>('overview');
	let customCounter = $state(0);
	let nodes = $state<MappingNode[]>([...emptySample.nodes]);
	let edges = $state<MappingEdge[]>([...emptySample.edges]);
	let hoverNodeId = $state<string | null>(null);
	let selectedNodeId = $state<string | null>(null);
	let selectedEdgeId = $state<string | null>(null);
	let hasUnsavedDraftChanges = $state(false);
	let dragState = $state<{
		fromNodeId: string;
		from: Point;
		to: Point;
	} | null>(null);

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
	}

	const visibleNodes = $derived(
		nodes.filter(
			(node) =>
				node.role === 'target' ||
				(node.role === 'source' && viewMode !== 'outbound') ||
				(node.role === 'destination' && viewMode !== 'inbound')
		)
	);
	const sourceNodes = $derived(visibleNodes.filter((node) => node.role === 'source'));
	const targetNodes = $derived(visibleNodes.filter((node) => node.role === 'target'));
	const destinationNodes = $derived(visibleNodes.filter((node) => node.role === 'destination'));
	const hasControlPlaneData = $derived(samples.length > 0);
	const layout = $derived(buildLayout());
	const laidOutNodes = $derived(layout.nodes);
	const graphEdges = $derived(edges.filter((edge) => nodeById(edge.from) && nodeById(edge.to)));
	const selectedEdge = $derived(
		selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) : null
	);
	const selectedEdges = $derived(
		new Set([...connectedEdgeIds(selectedNodeId), ...(selectedEdgeId ? [selectedEdgeId] : [])])
	);
	const hoverEdges = $derived(connectedEdgeIds(hoverNodeId));
	const rule = $derived(
		selectedEdge ? edgeInspectorRule(selectedEdge) : (sample.rules[activeRuleId] ?? fallbackRule())
	);

	$effect(() => {
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

	beforeNavigate((navigation) => {
		if (!hasUnsavedDraftChanges) return;
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
			if (!hasUnsavedDraftChanges) return;
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
		activeRuleId = next.activeRuleId;
		nodes = [...next.nodes];
		edges = [...next.edges];
		selectedEdgeId = null;
		selectedNodeId = next.nodes.find((node) => node.ruleId === next.activeRuleId)?.id ?? null;
		hasUnsavedDraftChanges = false;
	}

	onDestroy(() => {
		window.removeEventListener('pointermove', handlePointerMove);
		window.removeEventListener('pointerup', handlePointerUp);
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

	function selectRule(ruleId: string) {
		activeRuleId = ruleId;
		selectedEdgeId = null;
		selectedNodeId = nodeForRule(ruleId)?.id ?? null;
	}

	function selectEdge(edge: MappingEdge) {
		selectedEdgeId = edge.id;
		selectedNodeId = null;
	}

	function connectedEdgeIds(nodeId: string | null): Set<string> {
		if (!nodeId) return new Set();
		return new Set(
			edges.filter((edge) => edge.from === nodeId || edge.to === nodeId).map((edge) => edge.id)
		);
	}

	function connectedNodeIds(nodeId: string | null): Set<string> {
		if (!nodeId) return new Set();
		return new Set(
			edges
				.filter((edge) => edge.from === nodeId || edge.to === nodeId)
				.flatMap((edge) => (edge.from === nodeId ? [edge.to] : [edge.from]))
		);
	}

	function buildLayout(): { nodes: LayoutNode[]; height: number } {
		const rowTops: Record<string, number> = {};
		let cursor = graphBaseTop;

		for (const target of targetNodes) {
			rowTops[target.id] = cursor;
			cursor += graphStep + rowGap;
		}

		const width = Math.max(190, canvasWidth * 0.23);
		const sourceLeft = 26;
		const targetLeft =
			viewMode === 'outbound'
				? 26
				: viewMode === 'inbound'
					? Math.max(sourceLeft + width + 110, canvasWidth - width - 26)
					: canvasWidth * 0.385;
		const destinationLeft =
			viewMode === 'outbound'
				? Math.max(targetLeft + width + 110, canvasWidth - width - 26)
				: Math.max(targetLeft + width + 90, canvasWidth - width - 26);
		const minHeight = Math.max(520, cursor + 36);
		let visibleSourceOffset = 0;
		let hiddenSourceOffset = 0;

		const sourceLayout = sourceNodes.map((node) => {
			const selected = node.adapter === inboundAdapter;
			const visibleOffset = selected ? visibleSourceOffset++ : 0;
			const hiddenOffset = selected ? 0 : ++hiddenSourceOffset;
			return {
				...node,
				top: graphBaseTop + (selected ? visibleOffset * graphStep : 0),
				left: sourceLeft,
				width,
				height: nodeHeight,
				hidden: !selected,
				stackIndex: hiddenOffset
			};
		});

		const targetLayout = targetNodes.map((node) => ({
			...node,
			top: rowTops[node.id] ?? graphBaseTop,
			left: targetLeft,
			width,
			height: targetHeight,
			hidden: false,
			stackIndex: 0
		}));

		let visibleDestinationOffset = 0;
		let hiddenDestinationOffset = 0;

		const destinationLayout = destinationNodes.map((node) => {
			const selected = node.adapter === outboundAdapter;
			const visibleOffset = selected ? visibleDestinationOffset++ : 0;
			const hiddenOffset = selected ? 0 : ++hiddenDestinationOffset;
			return {
				...node,
				top: graphBaseTop + (selected ? visibleOffset * graphStep : 0),
				left: destinationLeft,
				width,
				height: nodeHeight,
				hidden: !selected,
				stackIndex: hiddenOffset
			};
		});

		const laidOut = [...sourceLayout, ...targetLayout, ...destinationLayout];
		return {
			nodes: laidOut,
			height: Math.max(
				minHeight,
				...laidOut.filter((node) => !node.hidden).map((node) => node.top + node.height + 36)
			)
		};
	}

	function nodeStyle(node: LayoutNode): string {
		const stackX = node.hidden ? 12 + node.stackIndex * 8 : 0;
		const stackY = node.hidden ? 7 + node.stackIndex * 6 : 0;
		const zIndex = node.hidden ? Math.max(1, 4 - node.stackIndex) : node.role === 'target' ? 3 : 5;
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

	function edgePoint(node: LayoutNode, direction: 'from' | 'to'): Point {
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

	function edgePath(edge: MappingEdge): string {
		const fromNode = layoutNodeById(edge.from);
		const toNode = layoutNodeById(edge.to);
		if (!fromNode || !toNode) return '';
		return pathBetween(edgePoint(fromNode, 'from'), edgePoint(toNode, 'to'));
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
			node.hidden ? 'adapter-hidden' : '',
			node.ruleId === activeRuleId ? 'active' : '',
			node.id === selectedNodeId ? 'selection-origin' : '',
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
		return (
			(fromNode.role === 'source' && toNode.role === 'target') ||
			(fromNode.role === 'target' && toNode.role === 'destination')
		);
	}

	function canvasPoint(event: PointerEvent): Point {
		const rect = canvas.getBoundingClientRect();
		return {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top
		};
	}

	function startConnectionDrag(event: PointerEvent, node: LayoutNode) {
		if (node.hidden || node.role === 'destination') return;
		event.preventDefault();
		event.stopPropagation();
		const from = edgePoint(node, 'from');
		dragState = {
			fromNodeId: node.id,
			from,
			to: canvasPoint(event)
		};
		window.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('pointerup', handlePointerUp);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!dragState) return;
		dragState = {
			...dragState,
			to: canvasPoint(event)
		};
	}

	function handlePointerUp(event: PointerEvent) {
		if (!dragState) return;
		const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
		const handle = target?.closest?.('.node-handle.input') as HTMLElement | null;
		const toNodeId = handle?.dataset.nodeId;
		const fromNode = nodeById(dragState.fromNodeId);
		const toNode = toNodeId ? nodeById(toNodeId) : undefined;
		if (isValidConnection(fromNode, toNode) && toNodeId) {
			addEdge(dragState.fromNodeId, toNodeId);
		}
		dragState = null;
		window.removeEventListener('pointermove', handlePointerMove);
		window.removeEventListener('pointerup', handlePointerUp);
	}

	function addEdge(from: string, to: string) {
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
		hasUnsavedDraftChanges = true;
	}

	function deleteSelectedEdge() {
		if (!selectedEdgeId) return;
		edges = edges.filter((edge) => edge.id !== selectedEdgeId);
		selectedEdgeId = null;
		hasUnsavedDraftChanges = true;
	}

	function handleGlobalKeyDown(event: KeyboardEvent) {
		if (!selectedEdgeId || (event.key !== 'Backspace' && event.key !== 'Delete')) return;
		const target = event.target as HTMLElement | null;
		if (
			target?.closest('input, textarea, select, [contenteditable="true"]') ||
			target?.isContentEditable
		) {
			return;
		}
		event.preventDefault();
		deleteSelectedEdge();
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

	function addNode(role: 'source' | 'destination') {
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
		hasUnsavedDraftChanges = true;
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
					<div class="mode-toggle" aria-label="Flow view mode">
						<button
							class:active={viewMode === 'overview'}
							type="button"
							onclick={() => (viewMode = 'overview')}
						>
							Overview
						</button>
						<button
							class:active={viewMode === 'inbound'}
							type="button"
							onclick={() => (viewMode = 'inbound')}
						>
							Inbound mapping
						</button>
						<button
							class:active={viewMode === 'outbound'}
							type="button"
							onclick={() => (viewMode = 'outbound')}
						>
							Outbound release
						</button>
					</div>
					<button class="primary-action" type="button">Compile draft</button>
				</div>
			</div>

			<div class="health-strip">
				<span><strong>Snapshot</strong> {sample.snapshot}</span>
				<span class="status-ok">{sample.status}</span>
				<span class="status-warn">{sample.reviewGates}</span>
			</div>

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
						<span>Inbound adapter</span>
						<select bind:value={inboundAdapter}>
							{#each adapters as adapter (adapter)}
								<option value={adapter}>{adapter}</option>
							{/each}
						</select>
						<button class="mini-tool-button" type="button" onclick={() => addNode('source')}
							>+</button
						>
					</div>
				{/if}
				<div class="lane-label lane-canonical">
					<span>Canonical targets</span>
				</div>
				{#if viewMode !== 'inbound'}
					<div class="lane-label lane-outbound">
						<span>Outbound adapter</span>
						<select bind:value={outboundAdapter}>
							{#each adapters as adapter (adapter)}
								<option value={adapter}>{adapter}</option>
							{/each}
						</select>
						<button class="mini-tool-button" type="button" onclick={() => addNode('destination')}
							>+</button
						>
					</div>
				{/if}

				<svg
					class="edge-layer"
					viewBox={`0 0 ${canvasWidth} ${layout.height}`}
					aria-label="Mapping edges"
				>
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
					{/each}
					{#if dragState}
						<path class="edge drag-edge" d={pathBetween(dragState.from, dragState.to)} />
					{/if}
				</svg>

				{#each laidOutNodes as node (node.id)}
					<button
						class={nodeClasses(node)}
						style={nodeStyle(node)}
						type="button"
						data-node-id={node.id}
						data-adapter={node.adapter}
						aria-hidden={node.hidden}
						tabindex={node.hidden ? -1 : 0}
						onclick={() => !node.hidden && selectRule(node.ruleId)}
						onpointerover={() => !node.hidden && (hoverNodeId = node.id)}
						onpointerout={() => (hoverNodeId = null)}
					>
						{#if node.role !== 'source'}
							<span class="node-handle input" data-node-id={node.id} aria-hidden="true"></span>
						{/if}
						<span>{node.label}</span>
						<small>{node.caption}</small>
						{#if node.role === 'target'}
							<span class="target-badge-row">
								<span class="target-badges">
									{#if node.type}<span class="target-badge type">{node.type}</span>{/if}
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
						{#if node.role !== 'destination'}
							<span
								class="node-handle output"
								data-node-id={node.id}
								aria-hidden="true"
								onpointerdown={(event) => startConnectionDrag(event, node)}
							></span>
						{/if}
					</button>
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
	button {
		font: inherit;
	}

	select {
		height: 30px;
		border: 1px solid var(--map-line);
		border-radius: 4px;
		color: var(--map-text);
		background: var(--map-surface);
		font-size: 12px;
		font-weight: 700;
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
		display: flex;
		align-items: center;
		gap: 7px;
		color: var(--map-muted);
		font-size: 11px;
		font-weight: 800;
		letter-spacing: 0.08em;
		text-transform: uppercase;
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
		pointer-events: stroke;
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
			stroke-dashoffset: -28;
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
		stroke-dasharray: 6 6;
		opacity: 1;
		animation:
			edge-flow 680ms linear infinite,
			connection-pulse 1.2s ease-in-out infinite;
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
		stroke-dasharray: 5 5;
		opacity: 0.55;
	}

	.custom-edge,
	.drag-edge {
		stroke: var(--map-teal);
		stroke-width: 2.6;
		stroke-dasharray: 4 3;
	}

	.drag-edge {
		stroke: var(--map-brand);
		opacity: 0.82;
		animation: edge-flow 620ms linear infinite;
	}

	.graph-node {
		--node-accent: var(--map-brand);
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

	.adapter-hidden {
		opacity: 0.22;
		filter: saturate(0.65);
		transform: translate(var(--stack-x), var(--stack-y));
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
		font-size: 11.2px;
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
	.graph-node.selection-origin {
		border-color: var(--node-accent);
		box-shadow:
			0 0 0 2px color-mix(in srgb, var(--node-accent) 20%, transparent),
			0 4px 12px rgba(0, 0, 0, 0.28);
	}

	.graph-node.selection-origin,
	.graph-node.active.selection-origin {
		background: color-mix(in srgb, var(--node-accent) 42%, var(--map-surface));
	}

	.graph-node.connection-related,
	.graph-node.selection-related {
		border-color: color-mix(in srgb, var(--node-accent) 84%, transparent);
		background: color-mix(in srgb, var(--node-accent) 18%, var(--map-surface));
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
