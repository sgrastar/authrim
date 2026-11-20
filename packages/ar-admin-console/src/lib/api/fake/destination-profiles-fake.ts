import type {
	DestinationProfileInput,
	DestinationProfilesClient,
	DestinationKind
} from '../destination-profiles';
import type { MappingDestinationProfile } from '../mapping-set';

/**
 * An in-memory set of destination profiles for stories and tests: saving writes, reviews and
 * activates in one go (or, with `blockReview`, keeps the profile as a draft and says why).
 */
export interface FakeDestinationProfiles extends DestinationProfilesClient {
	/** The inputs of every save, in order. */
	saved: DestinationProfileInput[];
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function mockProfile(
	kind: DestinationKind,
	id: string,
	displayName: string,
	schema: Record<string, unknown>,
	lifecycleState = 'active'
): MappingDestinationProfile {
	return {
		id,
		tenantId: 'tenant-1',
		destinationType: kind,
		profileKey: id,
		displayName,
		ownerScopeType: 'tenant',
		ownerScopeId: null,
		baseProfileId: null,
		lifecycleState,
		activeVersionId: `${id}-v1`,
		version: {
			id: `${id}-v1`,
			versionLabel: 'v1',
			lifecycleState,
			schemaHash: id,
			schema,
			validationSummary: {},
			warningSummary: {},
			releaseImpact: {}
		}
	};
}

export function createFakeDestinationProfiles(
	initial: MappingDestinationProfile[] = [],
	options: { blockReview?: string; delay?: number } = {}
): FakeDestinationProfiles {
	const rows = new Map(initial.map((row) => [row.id, plain(row)]));
	const saved: DestinationProfileInput[] = [];
	const wait = () => new Promise((resolve) => setTimeout(resolve, options.delay ?? 0));
	return {
		saved,
		async list(_tenantId, kind) {
			await wait();
			return [...rows.values()]
				.filter((row) => row.destinationType === kind)
				.map((row) => plain(row));
		},
		async save(_tenantId, input) {
			await wait();
			saved.push(plain(input));
			const id = input.id ?? `profile-${rows.size + 1}`;
			const blocked = options.blockReview !== undefined;
			const profile = mockProfile(
				input.destinationType,
				id,
				input.displayName,
				plain(input.schema),
				blocked ? 'draft' : 'active'
			);
			rows.set(id, profile);
			return blocked
				? { profile: plain(profile), active: false, reason: options.blockReview }
				: { profile: plain(profile), active: true };
		}
	};
}
