import type {
	SourceKind,
	SourceProfile,
	SourceProfileInput,
	SourceProfilesClient
} from '../source-profiles';

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** An in-memory set of input sources for stories and tests. */
export interface FakeSourceProfiles extends SourceProfilesClient {
	saved: SourceProfileInput[];
	removed: string[];
}

export function mockSource(
	kind: SourceKind,
	id: string,
	displayName: string,
	schema: Record<string, unknown>
): SourceProfile {
	return {
		id,
		sourceType: kind,
		profileKey: id,
		displayName,
		lifecycleState: 'active',
		activeVersionId: `${id}-v1`,
		version: { id: `${id}-v1`, versionLabel: 'v1', lifecycleState: 'active', schema }
	};
}

export function createFakeSourceProfiles(
	initial: SourceProfile[] = [],
	options: { blockReview?: string } = {}
): FakeSourceProfiles {
	const rows = new Map(initial.map((row) => [row.id, plain(row)]));
	const saved: SourceProfileInput[] = [];
	const removed: string[] = [];
	return {
		saved,
		removed,
		async list() {
			return [...rows.values()].map((row) => plain(row));
		},
		async save(_tenantId, input) {
			saved.push(plain(input));
			const id = input.id ?? `source-${rows.size + 1}`;
			const blocked = options.blockReview !== undefined;
			const profile = mockSource(input.sourceType, id, input.displayName, plain(input.schema));
			if (blocked) profile.lifecycleState = 'draft';
			rows.set(id, profile);
			return blocked
				? { profile: plain(profile), active: false, reason: options.blockReview }
				: { profile: plain(profile), active: true };
		},
		async remove(_tenantId, id) {
			removed.push(id);
			rows.delete(id);
		}
	};
}
