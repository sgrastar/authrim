/**
 * Where optional steps can be inserted into a flow.
 *
 * A flow has a fixed order of possible steps. The steps in use are shown in that order; each
 * gap between them offers exactly the missing steps that belong there, so a step can only
 * ever be added at its own place and the order never changes. A gap with nothing to offer
 * has no "+".
 */
export type FlowSegment =
	| { kind: 'gap'; key: string; options: string[] }
	| { kind: 'step'; key: string; id: string };

/** Gaps before, between and after the visible steps, in `order`. */
export function flowSegments(order: readonly string[], visible: readonly string[]): FlowSegment[] {
	const shown = new Set(visible);
	const segments: FlowSegment[] = [];
	let previous = 'start';
	let pending: string[] = [];
	for (const id of order) {
		if (!shown.has(id)) {
			pending.push(id);
			continue;
		}
		segments.push({ kind: 'gap', key: `gap:${previous}:${id}`, options: pending });
		segments.push({ kind: 'step', key: `step:${id}`, id });
		previous = id;
		pending = [];
	}
	segments.push({ kind: 'gap', key: `gap:${previous}:end`, options: pending });
	return segments;
}

/** Steps present in `before` but gone from `after`. */
export function removedSteps(before: readonly FlowSegment[], after: readonly FlowSegment[]) {
	const kept = new Set(after.filter((s) => s.kind === 'step').map((s) => s.key));
	return before.filter((s) => s.kind === 'step' && !kept.has(s.key)).map((s) => s.key);
}
