import type { IdentityMappingClient, MappingSetSummary } from '#lib/api/identity-mapping.js';
import type {
	MappingCatalog,
	MappingDestinationProfile,
	MappingSetContent,
	MappingSetDetail,
	MappingSetSaveRequest
} from '#lib/api/mapping-set.js';
import {
	compileMappingSet,
	decompileMappingSet,
	type MappingCodecContext
} from '#lib/ui/patterns/mapping-codec.js';
import type { Mapping } from '#lib/ui/patterns/mapping-model.js';
import { copyValue, Draft } from '#lib/ui/save/draft.svelte.js';
import { codecContext, profileDescriptor } from './connection-mapping-fields.js';
import { ApiError, ReleasePausedError } from '#lib/api/api-error.js';
import type { DestinationProfilesClient } from '#lib/api/destination-profiles.js';

export interface ConnectionMappingResources {
	client: IdentityMappingClient;
	tenantId: string;
	protocol: 'oidc' | 'saml';
	connectionId: string;
	connectionName?: string;
	entityId?: string;
	readBinding: () => Promise<{ setId: string; pinned: boolean }>;
	bind: (set: MappingSetDetail, idempotencyKey: string) => Promise<void>;
	/** Makes and changes output sources (destination profiles); absent: only the existing ones can be chosen. */
	profiles?: DestinationProfilesClient;
}
export interface MappingForm {
	name: string;
	description: string;
	profileId: string;
	catalogVersionId: string;
	mappings: Mapping[];
}
type Phase =
	| 'ready'
	| 'loading'
	| 'failed'
	| 'saving'
	| 'impact'
	| 'conflict'
	| 'paused'
	| 'stage_failed'
	| 'outcome_unknown'
	| 'binding_failed'
	| 'saved';

/** One save attempt retains its payload, key and ETag until its outcome is resolved. */
export class ConnectionMappingState {
	phase = $state<Phase>('loading');
	sets = $state<MappingSetSummary[]>([]);
	catalogs = $state<MappingCatalog[]>([]);
	/** The output sources that can be chosen (switched on). */
	profiles = $state<MappingDestinationProfile[]>([]);
	/** Every output source of this kind that has a schema: what can be copied or changed. */
	allProfiles = $state<MappingDestinationProfile[]>([]);
	selected = $state('');
	bound = $state('');
	pinned = $state(false);
	detail = $state<MappingSetDetail | null>(null);
	context = $state<MappingCodecContext | null>(null);
	readonlyReason = $state(false);
	impact = $state<{ count: number; incomplete: boolean; connections: string[] } | null>(null);
	stage = $state('');
	newKey = $state('');
	base: MappingSetContent | null = null;
	pending: {
		request: MappingSetSaveRequest & { field_mapping_key: string };
		key: string;
		setId: string;
		version: string;
		/** A try of this attempt ended without a known result: it is never dropped unresolved. */
		unknown?: boolean;
	} | null = null;
	savedSet: MappingSetDetail | null = null;
	bindingKey = '';
	form = new Draft<MappingForm>({
		name: '',
		description: '',
		profileId: '',
		catalogVersionId: '',
		mappings: []
	});

	constructor(readonly resources: ConnectionMappingResources) {}
	get locked() {
		return [
			'loading',
			'saving',
			'impact',
			'outcome_unknown',
			'stage_failed',
			'binding_failed',
			'conflict'
		].includes(this.phase);
	}
	get dirty() {
		return (
			this.form.dirty ||
			!!this.pending ||
			this.phase === 'binding_failed' ||
			this.selected !== this.bound
		);
	}

	async load() {
		this.phase = 'loading';
		try {
			const { client, tenantId } = this.resources;
			const [sets, catalogs, profiles, binding] = await Promise.all([
				client.sets(tenantId),
				client.catalogs(tenantId),
				client.destinationProfiles(tenantId),
				this.resources.readBinding()
			]);
			this.sets = sets.sets;
			this.catalogs = catalogs.catalogs;
			this.setProfiles(profiles.destinationProfiles);
			this.bound = binding.setId;
			this.pinned = binding.pinned;
			await this.select(binding.setId);
		} catch {
			this.phase = 'failed';
		}
	}

	private setProfiles(all: MappingDestinationProfile[]) {
		this.allProfiles = all.filter(
			(profile) => profile.destinationType === this.resources.protocol && profile.version
		);
		this.profiles = this.allProfiles.filter((profile) => profile.lifecycleState === 'active');
	}

	/** Reads the output sources again (one was just made or changed). */
	async reloadProfiles() {
		const { client, tenantId } = this.resources;
		this.setProfiles((await client.destinationProfiles(tenantId)).destinationProfiles);
	}

	/**
	 * The names of the mapping sets that send into an output source, read one by one. `complete`
	 * is false when a set could not be read: what sends into the profile is then not known, and the
	 * caller treats it as in use.
	 */
	async setsUsing(profileId: string): Promise<{ names: string[]; complete: boolean }> {
		const { client, tenantId } = this.resources;
		const names: string[] = [];
		let complete = true;
		await Promise.all(
			this.sets.map(async (set) => {
				try {
					const detail = await client.setContent(tenantId, set.id);
					if (detail.destination_profile_id === profileId)
						names.push(set.display_name ?? set.field_mapping_key);
				} catch {
					complete = false;
				}
			})
		);
		return { names: names.sort((a, b) => a.localeCompare(b)), complete };
	}

	async select(id: string) {
		this.phase = 'loading';
		try {
			const detail = id
				? await this.resources.client.setContent(this.resources.tenantId, id)
				: null;
			this.selected = id;
			this.detail = detail;
			this.base = copyValue(detail?.content ?? null);
			this.pending = null;
			this.savedSet = null;
			this.bindingKey = '';
			this.newKey = '';
			this.form.reset({
				name: detail?.display_name ?? '',
				description: detail?.description ?? '',
				profileId: detail?.destination_profile_id ?? '',
				catalogVersionId: detail?.content?.catalogVersionId ?? '',
				mappings: []
			});
			this.context = null;
			this.readonlyReason =
				this.pinned ||
				(detail !== null &&
					(detail.protocol !== this.resources.protocol ||
						!detail.content ||
						!detail.destination_profile));
			if (detail && !this.readonlyReason && detail.destination_profile && detail.content) {
				const catalog = this.catalogs.find(
					(item) => item.versionId === detail.content?.catalogVersionId
				);
				if (!catalog) this.readonlyReason = true;
				else {
					this.context = codecContext(
						this.resources.protocol,
						detail.destination_profile,
						catalog,
						detail.content
					);
					const decoded = decompileMappingSet(detail.content, this.context);
					if (decoded.editable) this.form.reset({ ...this.form.value, mappings: decoded.mappings });
					else this.readonlyReason = true;
				}
			}
			this.phase = 'ready';
		} catch {
			this.readonlyReason = true;
			this.phase = 'failed';
		}
	}

	create() {
		this.selected = '';
		this.detail = null;
		this.base = null;
		this.context = null;
		this.pending = null;
		this.savedSet = null;
		this.bindingKey = '';
		this.readonlyReason = this.pinned;
		this.newKey = crypto.randomUUID();
		this.form.reset({
			name: '',
			description: '',
			profileId: '',
			catalogVersionId: '',
			mappings: []
		});
		this.phase = 'ready';
	}

	/** A profile/catalog change starts an empty mapping; it never modifies a schema. */
	configure() {
		if (this.detail || !this.newKey) return;
		this.context = null;
		this.base = null;
		this.form.value.mappings = [];
		const profile = this.profiles.find((item) => item.id === this.form.value.profileId);
		const catalog = this.catalogs.find(
			(item) => item.versionId === this.form.value.catalogVersionId
		);
		if (!profile || !catalog?.versionId) return;
		try {
			this.base = { catalogVersionId: catalog.versionId, rules: [] };
			this.context = codecContext(
				this.resources.protocol,
				profileDescriptor(profile),
				catalog,
				this.base
			);
			this.readonlyReason = this.pinned;
		} catch {
			this.readonlyReason = true;
		}
	}

	async save() {
		if (this.readonlyReason || !this.context || !this.base || this.locked) return;
		if (this.detail && !this.form.dirty) {
			await this.bind(this.detail);
			return;
		}
		this.phase = 'saving';
		try {
			const content = compileMappingSet(
				copyValue(this.base),
				copyValue(this.form.value.mappings),
				this.context
			);
			this.pending = {
				request: {
					display_name: this.form.value.name,
					description:
						this.detail && this.form.value.description === (this.detail.description ?? '')
							? this.detail.description
							: this.form.value.description || null,
					field_mapping_key: this.detail?.field_mapping_key ?? this.newKey,
					enabled: this.detail?.enabled ?? true,
					content
				},
				key: crypto.randomUUID(),
				setId: this.selected,
				version: this.detail?.etag ?? this.detail?.content_version ?? ''
			};
			const preview = await this.resources.client.previewSave(
				this.resources.tenantId,
				this.pending.request,
				this.selected ? { setId: this.selected, version: this.pending.version } : undefined
			);
			if (!preview.valid) {
				this.stage = preview.stage_failed ?? 'validate';
				this.phase = 'stage_failed';
				return;
			}
			if (preview.confirm_impact_required && preview.references) {
				await this.showImpact(
					preview.references.count,
					preview.references.scan_complete !== true ||
						preview.references.count_is_lower_bound === true
				);
				return;
			}
			await this.write();
		} catch (error) {
			// Only the preview throws here, and it changes nothing: the form stays as it is.
			this.phase =
				error instanceof ReleasePausedError
					? 'paused'
					: error instanceof ApiError && error.status === 409
						? 'conflict'
						: 'failed';
			this.pending = null;
		}
	}

	cancelImpact() {
		this.impact = null;
		this.pending = null;
		this.phase = 'ready';
	}
	async showImpact(count: number, incomplete: boolean) {
		const attempt = this.pending;
		if (!attempt) return;
		try {
			const preview = attempt.setId
				? await this.resources.client.previewSetChange(
						this.resources.tenantId,
						attempt.setId,
						attempt.request.content
					)
				: null;
			this.impact = {
				count,
				incomplete: incomplete || preview?.usage_complete === false,
				connections: preview
					? [
							...preview.apps
								.filter(
									(app) =>
										app.tenant_id !== this.resources.tenantId ||
										app.client_id !== this.resources.connectionId
								)
								.map((app) => app.name),
							...(preview.sps ?? [])
								.filter(
									(sp) =>
										sp.tenant_id !== this.resources.tenantId ||
										sp.provider_id !== this.resources.connectionId
								)
								.map((sp) => sp.name)
						]
					: []
			};
			this.phase = 'impact';
		} catch {
			this.phase = 'failed';
			this.pending = null;
		}
	}

	async confirmImpact() {
		if (!this.pending || !this.impact) return;
		this.pending.request.confirm_impact = this.impact.count;
		this.impact = null;
		await this.write();
	}

	async write() {
		const attempt = this.pending;
		if (!attempt) return;
		this.phase = 'saving';
		try {
			const { client, tenantId } = this.resources;
			const result = attempt.setId
				? await client.saveSet(tenantId, attempt.setId, attempt.request, {
						idempotencyKey: attempt.key,
						version: attempt.version
					})
				: await client.createSet(tenantId, attempt.request, attempt.key);
			if (result.kind === 'success') {
				// Activation is complete only here. A failed metadata read is also a binding-only retry.
				this.selected = result.value.id;
				this.sets = [...this.sets.filter((set) => set.id !== result.value.id), result.value];
				this.base = copyValue(attempt.request.content);
				this.form.commit();
				this.pending = null;
				this.savedSet = null;
				this.bindingKey = '';
				await this.retryBinding();
			} else if (result.kind === 'impact_confirmation_required') {
				if (!result.references) {
					this.phase = 'failed';
					this.pending = null;
					return;
				}
				// A changed confirmation is a new request. Replays of an unchanged request keep its key.
				attempt.key = crypto.randomUUID();
				await this.showImpact(
					result.references.count,
					result.references.scanComplete !== true || result.references.countIsLowerBound === true
				);
			} else if (result.kind === 'paused' && attempt.unknown) {
				// Only this retry was refused; what became of the first try is still not known, so
				// the attempt (its payload and key) is kept and can be sent again.
				this.phase = 'outcome_unknown';
			} else if (result.kind === 'paused') {
				// Nothing was changed and nothing waits: the next save is a request of its own.
				this.phase = 'paused';
				this.pending = null;
			} else {
				if (result.kind === 'outcome_unknown') attempt.unknown = true;
				this.phase = result.kind;
				if (result.kind === 'stage_failed') this.stage = result.stage;
			}
		} catch {
			attempt.unknown = true;
			this.phase = 'outcome_unknown';
		}
	}

	async bind(set: MappingSetDetail) {
		this.phase = 'saving';
		this.savedSet = copyValue(set);
		this.bindingKey ||= crypto.randomUUID();
		try {
			await this.resources.bind(set, this.bindingKey);
			this.bound = set.id;
			this.detail = copyValue(set);
			this.phase = 'saved';
		} catch {
			this.phase = 'binding_failed';
		}
	}
	async retryBinding() {
		this.phase = 'saving';
		try {
			const set =
				this.savedSet ??
				(await this.resources.client.setContent(this.resources.tenantId, this.selected));
			this.detail = copyValue(set);
			await this.bind(set);
		} catch {
			this.phase = 'binding_failed';
		}
	}

	/** Reading a saved record resolves no activation outcome and never binds it automatically. */
	async inspectUnknown() {
		const attempt = this.pending;
		if (!attempt) return;
		try {
			const { sets } = await this.resources.client.sets(this.resources.tenantId);
			const found = sets.find((set) => set.field_mapping_key === attempt.request.field_mapping_key);
			if (!found) return;
			this.sets = sets;
			await this.select(found.id);
		} catch {
			this.phase = 'outcome_unknown';
		}
	}
}
