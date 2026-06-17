<script lang="ts">
	import {
		SvelteFlow,
		SvelteFlowProvider,
		Controls,
		Background,
		BackgroundVariant,
		MiniMap,
		type Node,
		type Edge,
		type OnConnect,
		type Connection,
		addEdge
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	import StartNode from './nodes/StartNode.svelte';
	import EndNode from './nodes/EndNode.svelte';
	import ErrorNode from './nodes/ErrorNode.svelte';
	import IdentifierNode from './nodes/IdentifierNode.svelte';
	import AuthMethodNode from './nodes/AuthMethodNode.svelte';
	import MfaNode from './nodes/MfaNode.svelte';
	import ConsentNode from './nodes/ConsentNode.svelte';
	import ConditionNode from './nodes/ConditionNode.svelte';
	import DecisionNode from './nodes/DecisionNode.svelte';
	import SwitchNode from './nodes/SwitchNode.svelte';
	import ActionNode from './nodes/ActionNode.svelte';
	import LogicNode from './nodes/LogicNode.svelte';
	import RegisterNode from './nodes/RegisterNode.svelte';
	import LoginNode from './nodes/LoginNode.svelte';
	import UserInputNode from './nodes/UserInputNode.svelte';
	import RedirectNode from './nodes/RedirectNode.svelte';
	import CheckSessionNode from './nodes/CheckSessionNode.svelte';

	import type { GraphNode, GraphEdge, GraphNodeType } from '$lib/api/admin-flows';
	import { getFlowNodeColor, getFlowNodeMetadata } from './flow-node-metadata';

	interface Props {
		nodes: GraphNode[];
		edges: GraphEdge[];
		readonly?: boolean;
		onNodesChange?: (nodes: GraphNode[]) => void;
		onEdgesChange?: (edges: GraphEdge[]) => void;
		onNodeSelect?: (nodeId: string | null) => void;
		onAddNode?: (type: GraphNodeType, position: { x: number; y: number }) => void;
		onNodeConfig?: (nodeId: string) => void;
	}

	let {
		nodes: propNodes,
		edges: propEdges,
		readonly = false,
		onNodesChange,
		onEdgesChange,
		onNodeSelect,
		onAddNode,
		onNodeConfig
	}: Props = $props();

	// Track prop changes with a derived value for comparison
	const propsKey = $derived(JSON.stringify({ n: propNodes.length, e: propEdges.length }));

	// Custom node types mapping (v1: 11 categories + legacy)
	const nodeTypes = {
		// === 1. Control Nodes ===
		start: StartNode,
		end: EndNode,
		goto: ActionNode,

		// === 2. Check Nodes (Yes/No output handles) ===
		check_session: CheckSessionNode,
		check_auth_level: LogicNode,
		check_first_login: LogicNode,
		check_user_attribute: LogicNode,
		check_context: LogicNode,
		check_risk: LogicNode,

		// === 3. Selection/UI Nodes ===
		auth_method_select: AuthMethodNode,
		login_method_select: ActionNode,
		identifier: IdentifierNode,
		profile_input: UserInputNode,
		custom_form: UserInputNode,
		information: ActionNode,
		challenge: ActionNode,

		// === 4. Authentication Nodes ===
		login: LoginNode,
		mfa: MfaNode,
		register: RegisterNode,

		// === 5. Consent Nodes ===
		consent: ConsentNode,
		check_consent_status: LogicNode,
		record_consent: ActionNode,

		// === 6. Resolve Nodes ===
		resolve_tenant: ActionNode,
		resolve_org: ActionNode,
		resolve_policy: ActionNode,

		// === 7. Session Nodes ===
		issue_tokens: ActionNode,
		refresh_session: ActionNode,
		revoke_session: ActionNode,
		bind_device: ActionNode,
		link_account: ActionNode,

		// === 8. Side Effect Nodes ===
		redirect: RedirectNode,
		webhook: ActionNode,
		event_emit: ActionNode,
		email_send: ActionNode,
		sms_send: ActionNode,
		push_notify: ActionNode,

		// === 9. Logic/Decision Nodes ===
		decision: DecisionNode,
		switch: SwitchNode,

		// === 10. Policy Nodes ===
		policy_check: LogicNode,

		// === 11. Error/Debug Nodes ===
		error: ErrorNode,
		log: ActionNode,

		// === Legacy (deprecated) ===
		auth_method: AuthMethodNode,
		user_input: UserInputNode,
		wait_input: ActionNode,
		condition: ConditionNode,
		check_user: LogicNode,
		risk_check: LogicNode,
		set_variable: ActionNode,
		call_api: ActionNode,
		send_notification: ActionNode
	};

	// Convert GraphNode to Svelte Flow Node format
	function toFlowNodes(graphNodes: GraphNode[]): Node[] {
		return graphNodes.map((node) => {
			const metadata = getFlowNodeMetadata(node.type);
			return {
				id: node.id,
				type: node.type,
				position: node.position,
				data: {
					...node.data,
					icon: metadata.icon,
					color: metadata.color,
					onConfigClick: onNodeConfig ? () => onNodeConfig(node.id) : undefined,
					readonly
				} as Record<string, unknown>,
				draggable: !readonly,
				connectable: !readonly,
				selectable: true
			};
		});
	}

	// Convert GraphEdge to Svelte Flow Edge format
	function toFlowEdges(graphEdges: GraphEdge[]): Edge[] {
		return graphEdges.map((edge) => {
			const edgeLabel = getEdgeLabel(edge);
			return {
				id: edge.id,
				source: edge.source,
				target: edge.target,
				sourceHandle: edge.sourceHandle || undefined,
				targetHandle: edge.targetHandle || undefined,
				type: 'smoothstep',
				animated: edge.type === 'conditional',
				style: getEdgeStyle(edge.sourceHandle || edge.type),
				label: edgeLabel,
				labelStyle: getEdgeLabelStyle(edge.sourceHandle || edge.type),
				labelBgStyle: 'fill: var(--flow-edge-label-bg); fill-opacity: 0.94;',
				labelBgPadding: [4, 2] as [number, number],
				labelBgBorderRadius: 4,
				deletable: !readonly
			};
		});
	}

	// Get edge label based on source handle or type
	// Only show labels for branching edges (multiple outputs), not for single-output edges
	function getEdgeLabel(edge: GraphEdge): string {
		// If explicit label provided, use it
		if (edge.data?.label) return edge.data.label;

		// Auto-generate label only for branching handles (not default/success single output)
		switch (edge.sourceHandle) {
			case 'failure':
			case 'error':
				return 'Failure';
			case 'unavailable':
				return 'N/A';
			case 'true':
				return 'Yes';
			case 'false':
				return 'No';
			case 'mfa_required':
				return 'MFA';
			case 'exists':
				return 'Exists';
			case 'decline':
				return 'Decline';
			case 'retry':
				return 'Retry';
			// 'success' and default (undefined/null) = no label (single output)
			default:
				return '';
		}
	}

	function getEdgeStyle(_edgeType: string): string {
		// All edges use standard gray color - hover/selection handled by CSS
		return 'stroke: var(--flow-edge-color); stroke-width: 1.5px;';
	}

	function getEdgeLabelStyle(_edgeType: string): string {
		// All labels use standard gray color
		return 'fill: var(--flow-edge-label-color); font-size: 10px; font-weight: 500;';
	}

	// Convert back to GraphNode format
	function toGraphNodes(flowNodes: Node[]): GraphNode[] {
		return flowNodes.map((node) => ({
			id: node.id,
			type: node.type as GraphNodeType,
			position: node.position,
			data: {
				label: (node.data?.label as string) || '',
				config: (node.data?.config as Record<string, unknown>) || {}
			}
		}));
	}

	// Convert back to GraphEdge format
	function toGraphEdges(flowEdges: Edge[]): GraphEdge[] {
		return flowEdges.map((edge) => {
			let edgeType: GraphEdge['type'];
			switch (edge.sourceHandle) {
				case 'failure':
				case 'error':
					edgeType = 'error';
					break;
				case 'unavailable':
					edgeType = 'unavailable';
					break;
				case 'false':
					edgeType = 'conditional';
					break;
				default:
					edgeType = 'success';
			}
			return {
				id: edge.id,
				source: edge.source,
				target: edge.target,
				sourceHandle: edge.sourceHandle || undefined,
				targetHandle: edge.targetHandle || undefined,
				type: edgeType,
				data: edge.label ? { label: String(edge.label) } : undefined
			};
		});
	}

	// Internal state - we use $state + $effect instead of $derived because
	// SvelteFlow mutates nodes/edges via bind:, requiring mutable state
	// Initialized empty, populated by $effect when props change
	let flowNodes = $state<Node[]>([]);
	let flowEdges = $state<Edge[]>([]);

	// Update when props change - using propsKey to ensure dependency tracking
	$effect(() => {
		// Access propsKey to track changes (used for dependency tracking)
		void propsKey;
		flowNodes = toFlowNodes(propNodes);
		flowEdges = toFlowEdges(propEdges);
	});

	// Handle node drag stop
	function handleNodeDragStop(_args: {
		targetNode: Node | null;
		nodes: Node[];
		event: MouseEvent | TouchEvent;
	}) {
		if (readonly || !onNodesChange) return;
		// Update nodes when drag stops
		onNodesChange(toGraphNodes(flowNodes));
	}

	// Handle node click for selection
	function handleNodeClick({ node }: { node: Node; event: MouseEvent | TouchEvent }) {
		if (onNodeSelect) {
			onNodeSelect(node.id);
		}
	}

	// Handle pane click to deselect
	function handlePaneClick() {
		if (onNodeSelect) {
			onNodeSelect(null);
		}
	}

	// Handle new connections
	const handleConnect: OnConnect = (connection: Connection) => {
		if (readonly || !onEdgesChange) return;

		const newEdge: Edge = {
			id: `edge-${Date.now()}`,
			source: connection.source!,
			target: connection.target!,
			sourceHandle: connection.sourceHandle || 'success',
			targetHandle: connection.targetHandle || undefined,
			type: 'smoothstep',
			style: getEdgeStyle(connection.sourceHandle || 'success')
		};

		flowEdges = addEdge(newEdge, flowEdges);
		onEdgesChange(toGraphEdges(flowEdges));
	};

	// Handle edge click to allow deletion
	function handleEdgeClick(_args: { edge: Edge; event: MouseEvent }) {
		if (readonly) return;
		// Edge can be deleted by pressing delete key after clicking
	}

	// Handle delete key
	function handleDelete({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
		if (readonly || !onNodesChange || !onEdgesChange) return;

		// Filter out start nodes - they cannot be deleted
		const deletableNodes = nodes.filter((n) => n.type !== 'start');
		if (deletableNodes.length === 0 && edges.length === 0) return;

		// Filter out deleted nodes and edges
		const deletedNodeIds = new Set(deletableNodes.map((n) => n.id));
		const deletedEdgeIds = new Set(edges.map((e) => e.id));

		flowNodes = flowNodes.filter((n) => !deletedNodeIds.has(n.id));
		flowEdges = flowEdges.filter((e) => !deletedEdgeIds.has(e.id));

		onNodesChange(toGraphNodes(flowNodes));
		onEdgesChange(toGraphEdges(flowEdges));
	}

	// Minimap node color based on type
	function minimapNodeColor(node: Node): string {
		return getFlowNodeColor(node.type);
	}

	// Drag and drop handling
	let canvasElement: HTMLDivElement;

	function handleDragOver(event: DragEvent) {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'copy';
		}
	}

	function handleDrop(event: DragEvent) {
		event.preventDefault();
		if (readonly || !onAddNode || !event.dataTransfer) return;

		const nodeType = event.dataTransfer.getData('application/flow-node') as GraphNodeType;
		if (!nodeType) return;

		// Get the canvas bounds and calculate position
		const bounds = canvasElement.getBoundingClientRect();
		const position = {
			x: event.clientX - bounds.left,
			y: event.clientY - bounds.top
		};

		onAddNode(nodeType, position);
	}
</script>

<div
	class="flow-canvas"
	bind:this={canvasElement}
	ondragover={handleDragOver}
	ondrop={handleDrop}
	role="application"
>
	<SvelteFlowProvider>
		<SvelteFlow
			bind:nodes={flowNodes}
			bind:edges={flowEdges}
			{nodeTypes}
			onconnect={handleConnect}
			onnodedragstop={handleNodeDragStop}
			onnodeclick={handleNodeClick}
			onpaneclick={handlePaneClick}
			onedgeclick={handleEdgeClick}
			ondelete={handleDelete}
			deleteKey={['Backspace', 'Delete']}
			fitView
			snapGrid={[15, 15]}
			minZoom={0.2}
			maxZoom={2}
			defaultEdgeOptions={{
				type: 'smoothstep'
			}}
		>
			<Controls showLock={!readonly} />
			<Background variant={BackgroundVariant.Dots} gap={15} size={1} />
			<MiniMap nodeColor={minimapNodeColor} pannable zoomable />
		</SvelteFlow>
	</SvelteFlowProvider>
</div>

<style>
	.flow-canvas {
		width: 100%;
		height: 100%;
		min-height: 500px;
		border-radius: var(--radius-panel, var(--radius-control, 8px));
		overflow: hidden;
	}

	/* xyflow Official Theme Variables */
	:global(.svelte-flow) {
		--flow-edge-color: color-mix(in srgb, var(--color-text-muted) 54%, transparent);
		--flow-edge-label-bg: var(--color-surface);
		--flow-edge-label-color: var(--color-text-muted);
		--xy-background-color: color-mix(in srgb, var(--color-surface) 82%, var(--color-page-bg));
		--xy-theme-selected: var(--color-accent);
		--xy-theme-hover: color-mix(in srgb, var(--color-accent) 42%, var(--color-border));
		--xy-theme-edge-hover: var(--color-text);
		--xy-theme-color-focus: color-mix(in srgb, var(--color-accent) 18%, transparent);
		--xy-node-border-default: 1px solid var(--color-border);
		--xy-node-boxshadow-default:
			0 8px 22px color-mix(in srgb, var(--color-text) 10%, transparent),
			0 1px 3px color-mix(in srgb, var(--color-text) 10%, transparent);
		--xy-node-border-radius-default: var(--radius-control, 8px);
		--xy-handle-background-color-default: var(--color-surface);
		--xy-handle-border-color-default: var(--color-border);
		--xy-edge-label-color-default: var(--color-text-muted);
		background: var(--xy-background-color);
	}

	/* Node base styling */
	:global(.svelte-flow__node) {
		box-shadow: var(--xy-node-boxshadow-default);
		border-radius: var(--xy-node-border-radius-default);
		border: var(--xy-node-border-default);
		font-size: 12px;
	}

	:global(.svelte-flow__node.selectable:focus) {
		box-shadow: 0px 0px 0px 4px var(--xy-theme-color-focus);
		border-color: var(--xy-theme-hover);
	}

	:global(.svelte-flow__node.selectable:focus:active) {
		box-shadow: var(--xy-node-boxshadow-default);
	}

	:global(.svelte-flow__node.selectable:hover),
	:global(.svelte-flow__node.draggable:hover) {
		border-color: var(--xy-theme-hover);
	}

	:global(.svelte-flow__node.selectable.selected) {
		border-color: var(--xy-theme-selected);
		box-shadow: var(--xy-node-boxshadow-default);
	}

	/* Handle styling */
	:global(.svelte-flow__handle) {
		width: 8px !important;
		height: 8px !important;
		background-color: var(--xy-handle-background-color-default);
		border: 1px solid var(--xy-handle-border-color-default);
	}

	:global(.svelte-flow__handle.connectionindicator:hover) {
		pointer-events: all;
		border-color: var(--xy-theme-edge-hover);
		background-color: var(--color-surface);
	}

	/* Edge styling */
	:global(.svelte-flow__edge-path) {
		stroke: var(--flow-edge-color);
		stroke-width: 1.5px;
		transition:
			stroke 0.15s,
			stroke-width 0.15s;
	}

	:global(.svelte-flow__edge.selectable:hover .svelte-flow__edge-path) {
		stroke: var(--color-text-muted);
		stroke-width: 2px;
	}

	:global(.svelte-flow__edge.selectable.selected .svelte-flow__edge-path) {
		stroke: var(--color-accent);
		stroke-width: 2.5px;
	}

	:global(.svelte-flow__edge-label) {
		background: var(--flow-edge-label-bg);
		font-size: 9px;
		padding: 2px 6px;
		border-radius: var(--flow-edge-label-radius, var(--radius-xs, 4px));
		border: 1px solid var(--color-border);
		color: var(--flow-edge-label-color);
	}

	:global(.svelte-flow__edge.selectable.selected .svelte-flow__edge-label) {
		border-color: var(--color-accent);
		color: var(--color-accent);
	}

	/* Controls */
	:global(.svelte-flow__controls) {
		box-shadow: var(--xy-node-boxshadow-default);
		border-radius: var(--flow-control-radius, var(--radius-control, 6px));
		border: 1px solid var(--color-border);
	}

	:global(.svelte-flow__controls-button) {
		border-bottom: 1px solid var(--color-border);
		background: var(--color-surface);
		color: var(--color-text);
	}

	/* MiniMap */
	:global(.svelte-flow__minimap) {
		border-radius: var(--flow-minimap-radius, var(--radius-control, 6px));
		border: 1px solid var(--color-border);
		box-shadow: var(--xy-node-boxshadow-default);
		background: var(--color-surface);
	}
</style>
