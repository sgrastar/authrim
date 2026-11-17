import type { FieldCatalogEntry } from '@authrim/ar-lib-field-mapping/contract';
import type {
	InboundMappingClient,
	InboundMappingDocument,
	InboundMappingDraft,
	InboundMappingPreview
} from '#lib/api/inbound-mapping.js';
import { ApiError } from '#lib/api/api-error.js';
import {
	compileMappingSet,
	decompileMappingSet,
	type MappingCodecContext,
	type MappingCodecField
} from '#lib/ui/patterns/mapping-codec.js';
import type { Mapping } from '#lib/ui/patterns/mapping-model.js';
import { copyValue, Draft } from '#lib/ui/save/draft.svelte.js';

export function inboundCodecContext(document: InboundMappingDocument): MappingCodecContext {
	const fields = (
		entries: FieldCatalogEntry[],
		side: 'source' | 'destination'
	): MappingCodecField[] =>
		entries.map((entry) => ({
			key:
				entries.filter((other) => other.path === entry.path).length > 1
					? `${entry.namespace}:${entry.path}`
					: entry.path,
			label: entry.path,
			type:
				entry.cardinality === 'multi'
					? 'string[]'
					: entry.valueType === 'boolean'
						? 'boolean'
						: 'string',
			ref: { side, namespace: entry.namespace, path: entry.path }
		}));
	return {
		protocol: document.protocol,
		direction: 'inbound',
		profileId: '',
		sources: fields(document.sources, 'source'),
		targets: fields(document.targets, 'destination')
	};
}
export class InboundMappingState {
	phase = $state<'loading' | 'ready' | 'failed' | 'saving' | 'saved' | 'conflict' | 'previewing'>(
		'loading'
	);
	document = $state<InboundMappingDocument | null>(null);
	form = new Draft<{ mappings: Mapping[]; sources: FieldCatalogEntry[] }>({
		mappings: [],
		sources: []
	});
	readonlyReason = $state(false);
	preview = $state<InboundMappingPreview | null>(null);
	error = $state(false);
	private generation = 0;
	private attempt: { body: InboundMappingDraft; key: string } | null = null;
	constructor(
		readonly client: InboundMappingClient,
		readonly kind: 'op' | 'idp',
		readonly id: string
	) {}
	get dirty() {
		return this.form.dirty;
	}
	get pending() {
		return this.phase === 'saving' || this.phase === 'previewing';
	}
	get context() {
		return this.document
			? inboundCodecContext({ ...this.document, sources: this.form.value.sources })
			: null;
	}
	show(document: InboundMappingDocument) {
		this.document = document;
		const decoded = decompileMappingSet(document.content, inboundCodecContext(document));
		this.readonlyReason = !document.editable || !decoded.editable;
		this.form.reset({
			mappings: decoded.editable ? decoded.mappings : [],
			sources: copyValue(document.sources)
		});
		this.attempt = null;
		this.preview = null;
		this.phase = 'ready';
	}
	async load() {
		const turn = ++this.generation;
		this.phase = 'loading';
		try {
			const document = await this.client.get(this.kind, this.id);
			if (turn === this.generation) this.show(document);
		} catch {
			if (turn === this.generation) this.phase = 'failed';
		}
	}
	dispose() {
		this.generation++;
	}
	/** A General save rebases only the precondition; the mapping draft stays mounted. */
	async refreshRevision() {
		try {
			const document = await this.client.get(this.kind, this.id);
			if (
				this.document &&
				JSON.stringify(document.content) === JSON.stringify(this.document.content)
			)
				this.document = {
					...this.document,
					revision: document.revision,
					providerUpdatedAt: document.providerUpdatedAt
				};
			else if (this.dirty) this.phase = 'conflict';
			else this.show(document);
		} catch {
			this.error = true;
		}
	}
	payload(): InboundMappingDraft {
		if (!this.context || !this.document || this.readonlyReason)
			throw new Error('Incoming mapping is read only');
		const content = compileMappingSet(
			copyValue(this.document.content),
			copyValue(this.form.value.mappings),
			this.context
		);
		return {
			revision: this.document.revision,
			rules: content.rules,
			sources: this.form.value.sources.map(({ namespace, path, cardinality }) => ({
				namespace,
				path,
				cardinality
			}))
		};
	}
	async save() {
		if (this.pending || this.readonlyReason) return null;
		this.error = false;
		try {
			const body = this.payload();
			if (!this.attempt || JSON.stringify(body) !== JSON.stringify(this.attempt.body))
				this.attempt = { body, key: crypto.randomUUID() };
			this.phase = 'saving';
			const document = await this.client.save(
				this.kind,
				this.id,
				this.attempt.body,
				this.attempt.key
			);
			this.show(document);
			this.phase = 'saved';
			return document;
		} catch (error) {
			this.phase = error instanceof ApiError && error.status === 409 ? 'conflict' : 'ready';
			this.error = true;
			return null;
		}
	}
	async evaluate(sample: string) {
		if (this.pending) return;
		this.error = false;
		this.preview = null;
		try {
			const body = this.payload();
			const value: unknown = JSON.parse(sample);
			this.phase = 'previewing';
			this.preview = await this.client.preview(this.kind, this.id, body, value);
		} catch {
			this.error = true;
		} finally {
			this.phase = 'ready';
		}
	}
}
