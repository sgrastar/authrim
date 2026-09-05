export type MappingProfileSide = 'source' | 'destination';

export function profileReferencesMatch(
	left: string,
	right: string,
	side: MappingProfileSide
): boolean {
	return profileReferenceKey(left, side) === profileReferenceKey(right, side);
}

function profileReferenceKey(value: string, side: MappingProfileSide): string {
	const prefix = side === 'source' ? 'source-profile-' : 'destination-profile-';
	let normalized = value;
	while (normalized.startsWith(prefix)) {
		normalized = normalized.slice(prefix.length);
	}
	return normalized;
}
