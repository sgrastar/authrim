import { afterEach, describe, expect, it } from 'vitest';
import { i18n, t } from '$lib/i18n/i18n.svelte';
import {
	canActivate,
	canProceed,
	defaultsForAppType,
	emptyAnswers,
	entityIdProblem,
	FLOW,
	FLOW_GROUPS,
	GENERAL_PARTS,
	groupState,
	httpsUrlProblem,
	isPristine,
	groupLabel,
	kindProtocol,
	kindRole,
	KINDS_OF,
	labelOf,
	leaveDialog,
	missingParts,
	nameOf,
	partState,
	redirectUriProblem,
	reviewRows,
	SHARE_PART,
	SIGNUP_FLOWS,
	sampleAnswers,
	schemaOptions,
	stepsFor,
	validSchema,
	stillToDo,
	visibleGroups,
	type ConnectionKind
} from './connection-model';

const ids = (a: Parameters<typeof stepsFor>[0]) => stepsFor(a).map((s) => s.id);
const KINDS: ConnectionKind[] = ['rp', 'sp', 'op', 'idp'];

describe('wizard steps', () => {
	it('start with the two questions and nothing else', () => {
		expect(ids({ direction: '', kind: '' })).toEqual(['where', 'kind']);
		expect(ids({ direction: 'out', kind: '' })).toEqual(['where', 'kind']);
		expect(ids({ direction: 'in', kind: '' })).toEqual(['where', 'kind']);
	});

	it('ask only what each kind cannot start without', () => {
		expect(ids({ direction: 'out', kind: 'rp' })).toEqual(['where', 'kind', 'rp-app', 'rp-signin']);
		expect(ids({ direction: 'out', kind: 'sp' })).toEqual([
			'where',
			'kind',
			'sp-import',
			'sp-attrs'
		]);
		// A provider Authrim signs in through needs nothing more than being chosen.
		expect(ids({ direction: 'in', kind: 'op' })).toEqual(['where', 'kind']);
		expect(ids({ direction: 'in', kind: 'idp' })).toEqual(['where', 'kind', 'idp-import']);
	});

	it('never test a connection: that is a setting of the flow', () => {
		for (const [direction, kind] of [
			['out', 'rp'],
			['out', 'sp'],
			['in', 'op'],
			['in', 'idp']
		] as const) {
			expect(
				ids({ direction, kind }).some((id) => id.endsWith('-test')),
				kind
			).toBe(false);
		}
	});

	it('leave the rest to the detail screen', () => {
		const wizard = new Set(ids({ direction: 'out', kind: 'rp' }));
		expect(wizard.has('rp-redirect')).toBe(false);
		expect(wizard.has('rp-info')).toBe(false);
		expect(ids({ direction: 'out', kind: 'sp' })).not.toContain('sp-share');
		expect(ids({ direction: 'out', kind: 'sp' })).not.toContain('activate');
		// Matching people and a provider's own details wait for the flow too.
		for (const kind of ['op', 'idp'] as const) {
			expect(ids({ direction: 'in', kind })).not.toContain(`${kind}-link`);
		}
		expect(ids({ direction: 'in', kind: 'op' })).not.toContain('op-details');
	});

	it('ignore a kind that does not go with the direction', () => {
		expect(ids({ direction: 'in', kind: 'rp' })).toEqual(['where', 'kind']);
		expect(ids({ direction: 'out', kind: 'op' })).toEqual(['where', 'kind']);
	});
});

describe('the flow of a connection', () => {
	it('is four kinds, two ways', () => {
		expect(KINDS_OF.out).toEqual(['rp', 'sp']);
		expect(KINDS_OF.in).toEqual(['op', 'idp']);
	});

	it('has every part the wizard asks, and ends with activating', () => {
		for (const kind of KINDS) {
			// The settings that are not a step (what the other side is) are shown at the top.
			const flow = [...GENERAL_PARTS[kind], ...FLOW[kind]];
			expect(FLOW[kind].at(-1)).toBe('activate');
			const direction = KINDS_OF.out.includes(kind) ? 'out' : 'in';
			for (const id of ids({ direction, kind }).slice(2))
				expect(flow, `${kind} ${id}`).toContain(id);
		}
	});
});

describe('redirect URIs', () => {
	it('accept https, loopback http and app schemes', () => {
		expect(redirectUriProblem('https://app.example.com/callback')).toBeUndefined();
		expect(redirectUriProblem('http://localhost:3000/cb')).toBeUndefined();
		expect(redirectUriProblem('http://127.0.0.1/cb')).toBeUndefined();
		expect(redirectUriProblem('com.example.app:/callback')).toBeUndefined();
	});

	it('refuse plain http, wildcards and fragments', () => {
		expect(redirectUriProblem('http://app.example.com/cb')).toBeDefined();
		expect(redirectUriProblem('https://*.example.com/cb')).toBeDefined();
		expect(redirectUriProblem('https://app.example.com/cb#x')).toBeDefined();
		expect(redirectUriProblem('')).toBeDefined();
	});
});

describe('SAML addresses', () => {
	it('want https for a metadata address and an https or urn entity ID', () => {
		expect(httpsUrlProblem('https://idp.example/metadata')).toBeUndefined();
		expect(httpsUrlProblem('http://idp.example/metadata')).toBeDefined();
		expect(entityIdProblem('urn:example:sp')).toBeUndefined();
		expect(entityIdProblem('https://sp.example/saml')).toBeUndefined();
		expect(entityIdProblem('sp.example')).toBeDefined();
	});
});

describe('when a wizard step lets you go on', () => {
	it('needs a direction, then a kind that goes with it', () => {
		const a = emptyAnswers();
		expect(canProceed('where', a)).toBe(false);
		a.direction = 'in';
		expect(canProceed('where', a)).toBe(true);
		expect(canProceed('kind', a)).toBe(false);
		a.kind = 'rp';
		expect(canProceed('kind', a)).toBe(false);
		a.kind = 'idp';
		expect(canProceed('kind', a)).toBe(true);
	});

	it('wants only a name for an app: the redirect URIs come later', () => {
		const a = emptyAnswers();
		expect(canProceed('rp-app', a)).toBe(false);
		a.rp.name = 'Employee portal';
		expect(canProceed('rp-app', a)).toBe(true);
	});

	it('wants the way a SAML partner was imported to be complete', () => {
		for (const [step, key] of [
			['sp-import', 'sp'],
			['idp-import', 'idp']
		] as const) {
			const a = emptyAnswers();
			const form = a[key];
			form.metadataUrl = 'https://pub.example/metadata';
			expect(canProceed(step, a)).toBe(false);
			form.fetched = true;
			expect(canProceed(step, a)).toBe(true);
			form.importMode = 'file';
			expect(canProceed(step, a)).toBe(false);
			form.fileName = 'metadata.xml';
			expect(canProceed(step, a)).toBe(true);
			form.importMode = 'manual';
			expect(canProceed(step, a)).toBe(false);
			form.entityId = 'https://pub.example/saml';
			form.acsUrl = 'https://pub.example/acs';
			expect(canProceed(step, a)).toBe(true);
		}
	});

	it('wants an OpenID Connect provider read and given a client', () => {
		const a = emptyAnswers();
		a.op.issuer = 'https://login.example';
		expect(canProceed('op-details', a)).toBe(false);
		a.op.discovered = true;
		a.op.clientId = 'authrim';
		expect(canProceed('op-details', a)).toBe(false);
		a.op.clientSecret = 'secret';
		expect(canProceed('op-details', a)).toBe(true);
	});

	it('wants the test to have been run, for every kind that has one', () => {
		for (const [step, key] of [
			['sp-test', 'sp'],
			['op-test', 'op'],
			['idp-test', 'idp']
		] as const) {
			const a = emptyAnswers();
			expect(canProceed(step, a)).toBe(false);
			a[key].tested = true;
			expect(canProceed(step, a)).toBe(true);
		}
	});

	it('lets the steps without a condition through', () => {
		const a = emptyAnswers();
		for (const id of ['rp-signin', 'sp-attrs', 'op-link', 'idp-link'])
			expect(canProceed(id, a)).toBe(true);
	});
});

describe('app types', () => {
	it('keep no secret for an app that cannot hide one', () => {
		expect(defaultsForAppType('web')).toEqual({ authMethod: 'client_secret_basic', pkce: true });
		expect(defaultsForAppType('spa')).toEqual({ authMethod: 'none', pkce: true });
		expect(defaultsForAppType('native')).toEqual({ authMethod: 'none', pkce: true });
	});
});

describe('the parts of a flow, after the wizard', () => {
	it('show what the wizard did not ask as still to do', () => {
		const rp = sampleAnswers('rp', 'wizard');
		expect(partState('rp-app', rp)).toBe('done');
		expect(partState('rp-redirect', rp)).toBe('required');
		expect(missingParts(rp)).toEqual(['Redirect URIs']);
		const sp = sampleAnswers('sp', 'wizard');
		// A service cannot work without a mapping (schemas and a set), which the wizard did not ask.
		expect(missingParts(sp)).toEqual(['Input and output schemas', 'Mapping sets']);
		// Nothing of a provider was asked, so its details are the first thing still required.
		const op = sampleAnswers('op', 'wizard');
		expect(partState('op-details', op)).toBe('required');
		expect(missingParts(op)).toEqual(['The provider’s details']);
		expect(canActivate(op)).toBe(false);
	});

	it('count a sign-in method or a matching rule as set from the start', () => {
		const a = emptyAnswers();
		for (const id of ['rp-signin', 'sp-attrs', 'op-attrs', 'op-link', 'idp-link'])
			expect(partState(id, a), id).toBe('done');
	});

	it('let a connection be activated once nothing required is missing and its test passed', () => {
		const rp = sampleAnswers('rp', 'wizard');
		expect(canActivate(rp)).toBe(false);
		rp.rp.redirectUris = ['https://reading.example.com/cb'];
		expect(canActivate(rp)).toBe(true);
		// The wizard never tests: a service cannot go live until the test is run in the flow.
		const sp = sampleAnswers('sp', 'wizard');
		expect(canActivate(sp)).toBe(false);
		sp.sp.tested = true;
		// ...nor without its mapping set, which a service cannot do without.
		expect(canActivate(sp)).toBe(false);
		sp.extras.inputSchema = 'authrim';
		sp.extras.outputSchema = 'standard';
		sp.extras.mappingSet = 'tenant-default';
		expect(canActivate(sp)).toBe(true);
		expect(canActivate(emptyAnswers())).toBe(false);
	});
});

describe('the sign-up flow of a connection', () => {
	it('is an optional step for the kinds that can bring someone without an account', () => {
		for (const kind of ['rp', 'op', 'idp'] as const) {
			const group = FLOW_GROUPS[kind].find((candidate) => candidate.id === 'signup');
			expect(group?.optional, kind).toBe(true);
			expect(group?.parts).toEqual(['signup-flow']);
		}
		expect(FLOW_GROUPS.sp.some((group) => group.id === 'signup')).toBe(false);
	});

	it('is not there until added, is still to do (not required) once added, and is listed when chosen', () => {
		for (const kind of ['rp', 'op', 'idp'] as const) {
			const a = sampleAnswers(kind);
			expect(visibleGroups(a).some((group) => group.id === 'signup')).toBe(false);
			a.added = ['signup'];
			expect(partState('signup-flow', a)).toBe('todo');
			expect(missingParts(a)).not.toContain(labelOf('signup-flow'));
			a.extras.signupFlow = SIGNUP_FLOWS[1].value;
			expect(partState('signup-flow', a)).toBe('done');
			expect(reviewRows(a).some((row) => row.value === SIGNUP_FLOWS[1].label)).toBe(true);
		}
	});
});

describe('sample answers', () => {
	it('let every step of the wizard be passed, for every kind', () => {
		for (const kind of KINDS) {
			const a = sampleAnswers(kind, 'wizard');
			for (const step of stepsFor(a))
				expect(canProceed(step.id, a), `${kind} ${step.id}`).toBe(true);
		}
	});

	it('leave nothing required when complete', () => {
		for (const kind of KINDS) {
			const a = sampleAnswers(kind);
			expect(missingParts(a), kind).toEqual([]);
			expect(canActivate(a), kind).toBe(true);
		}
	});
});

describe('names and review', () => {
	it('name the connection from what was given', () => {
		expect(nameOf(sampleAnswers('rp'))).toBe('Employee portal');
		expect(nameOf(sampleAnswers('op'))).toBe('Acme Directory');
		expect(nameOf(sampleAnswers('idp'))).toBe('Corporate sign-in');
		expect(nameOf(sampleAnswers('sp'))).toBe('hr.example');
		expect(nameOf(emptyAnswers())).toBe('New connection');
	});

	it('lists what belongs to the kind', () => {
		const labels = (kind: ConnectionKind) => reviewRows(sampleAnswers(kind)).map((r) => r.label);
		expect(labels('rp')).toContain('Redirect URIs');
		expect(labels('sp')).toContain('Entity ID');
		expect(labels('op')).toContain('Issuer');
		expect(labels('idp')).toContain('Matching people');
		expect(labels('sp')).not.toContain('Redirect URIs');
	});
});

describe('the steps of a flow', () => {
	it('hold every part once, in groups, and end with going live', () => {
		for (const kind of KINDS) {
			const groups = FLOW_GROUPS[kind];
			expect(groups.at(-1)?.parts).toEqual(['activate']);
			const parts = groups.flatMap((group) => group.parts);
			expect(new Set(parts).size).toBe(parts.length);
			expect(parts).toEqual([...FLOW[kind]]);
		}
	});

	it('are as far along as their settings', () => {
		const a = sampleAnswers('rp', 'wizard');
		// The redirect URIs are missing: that holds the connection back, though it is not a step.
		expect(partState('rp-redirect', a)).toBe('required');
		expect(missingParts(a)).toEqual(['Redirect URIs']);
		a.rp.redirectUris = ['https://portal.example.com/cb'];
		expect(missingParts(a)).toEqual([]);
		const sp = sampleAnswers('sp', 'wizard');
		// Nothing has been checked yet: the last step is not done.
		expect(groupState(FLOW_GROUPS.sp.at(-1)!, sp)).toBe('todo');
	});
});

describe('what is shown above the step count', () => {
	it('names the protocol and the role of each kind', () => {
		expect(kindProtocol('rp')).toBe('OpenID Connect (Relying Party)');
		expect(kindProtocol('sp')).toBe('SAML (Service Provider)');
		expect(kindProtocol('op')).toBe('OpenID Connect (OpenID Provider)');
		expect(kindProtocol('idp')).toBe('SAML (Identity Provider)');
	});
});

describe('leaving the wizard', () => {
	it('costs nothing until something has been entered', () => {
		expect(isPristine(emptyAnswers())).toBe(true);
		const a = emptyAnswers();
		a.direction = 'out';
		expect(isPristine(a)).toBe(false);
		const b = emptyAnswers();
		b.rp.name = 'x';
		expect(isPristine(b)).toBe(false);
	});

	it('is explained in a sentence that says what is lost', () => {
		expect(leaveDialog().body).toMatch(/lost/);
		// It names the wizard's last button, which is where things start to be kept.
		expect(leaveDialog().body).toMatch(/continue to the settings/);
	});
});

describe('the processing steps of a flow', () => {
	const ids = (a: Parameters<typeof visibleGroups>[0]) => visibleGroups(a).map((group) => group.id);

	it('start with a mapping only where a connection cannot work without one', () => {
		expect(ids(sampleAnswers('sp'))).toContain('mapping');
		expect(ids(sampleAnswers('idp'))).toContain('mapping');
		expect(ids(sampleAnswers('rp'))).not.toContain('mapping');
		expect(ids(sampleAnswers('op'))).not.toContain('mapping');
	});

	it('are added with the "+": sign-up, consent, role, and for providers additional input', () => {
		const optional = (kind: ConnectionKind) =>
			FLOW_GROUPS[kind].filter((group) => group.optional).map((group) => group.id);
		expect(optional('rp')).toEqual(['signup', 'mapping', 'consent', 'role']);
		expect(optional('sp')).toEqual(['consent', 'role']);
		expect(optional('op')).toEqual(['signup', 'mapping', 'additional', 'consent', 'role']);
		expect(optional('idp')).toEqual(['signup', 'additional', 'consent', 'role']);
	});

	it('keep the settings an app needs: redirect URIs, sign-in method, and the rest', () => {
		expect(GENERAL_PARTS.rp).toEqual(['rp-app', 'rp-redirect', 'rp-signin']);
		expect(FLOW.rp).toEqual(expect.arrayContaining(['rp-info']));
		expect(GENERAL_PARTS.sp).toEqual(['sp-import']);
		expect(FLOW.sp).toEqual(expect.arrayContaining(['sp-attrs', 'sp-test']));
		// What the other side is does not belong to the flow.
		for (const kind of KINDS)
			for (const id of GENERAL_PARTS[kind]) expect(FLOW[kind], `${kind} ${id}`).not.toContain(id);
	});

	it('sit before checking and going live, in the order of the earlier mock', () => {
		const order = FLOW_GROUPS.idp.map((group) => group.id);
		expect(order.indexOf('mapping')).toBeLessThan(order.indexOf('additional'));
		expect(order.indexOf('additional')).toBeLessThan(order.indexOf('consent'));
		expect(order.indexOf('consent')).toBeLessThan(order.indexOf('role'));
		expect(order.indexOf('role')).toBeLessThan(order.indexOf('check'));
	});

	it('are only counted once they are in the flow', () => {
		const a = sampleAnswers('rp');
		expect(ids(a)).not.toContain('consent');
		a.added = ['consent', 'role'];
		expect(ids(a)).toContain('consent');
		expect(ids(a).at(-1)).toBe('live');
	});

	it('make a mapping set required for a service and a SAML provider', () => {
		const sp = sampleAnswers('sp', 'wizard');
		expect(partState('mapping-sets', sp)).toBe('required');
		expect(missingParts(sp)).toEqual(['Input and output schemas', 'Mapping sets']);
		expect(canActivate(sp)).toBe(false);
		sp.extras.inputSchema = 'authrim';
		sp.extras.outputSchema = 'standard';
		sp.extras.mappingSet = 'tenant-default';
		expect(missingParts(sp)).toEqual([]);
	});

	it('leave a mapping set optional for an app and an OpenID Connect provider', () => {
		const rp = sampleAnswers('rp');
		rp.added = ['mapping'];
		rp.extras.mappingSet = '';
		expect(partState('mapping-sets', rp)).toBe('todo');
		expect(missingParts(rp)).toEqual([]);
	});

	it('are set when they have what they need', () => {
		const a = sampleAnswers('op', 'complete');
		a.added = ['additional', 'consent', 'role'];
		for (const id of ['additional', 'consent-statements', 'consent-policies', 'role'])
			expect(partState(id, a), id).toBe('todo');
		a.extras.additionalFields = ['department'];
		a.extras.consentStatements = ['tos'];
		a.extras.consentPolicy = 'first';
		a.extras.role = 'member';
		for (const id of ['additional', 'consent-statements', 'consent-policies', 'role'])
			expect(partState(id, a), id).toBe('done');
	});

	it('show in the review once in the flow', () => {
		const a = sampleAnswers('rp');
		expect(reviewRows(a).map((r) => r.label)).not.toContain('Consent');
		a.added = ['consent', 'role'];
		a.extras.consentStatements = ['tos'];
		const rows = reviewRows(a);
		expect(rows.find((r) => r.label === 'Consent')?.value).toBe('Terms of use (v3)');
		expect(rows.find((r) => r.label === 'Role')?.value).toBe('Not set');
	});
});

describe('what is still to do', () => {
	it('lists required settings first, and never activating', () => {
		const a = sampleAnswers('op', 'wizard');
		const todo = stillToDo(a);
		expect(todo[0]).toMatchObject({ id: 'op-details', state: 'required' });
		expect(todo.map((part) => part.id)).not.toContain('activate');
		expect(todo.map((part) => part.id)).toContain('op-test');
		const first = todo.findIndex((part) => part.state !== 'required');
		expect(todo.slice(first).every((part) => part.state !== 'required')).toBe(true);
	});

	it('is empty when everything is set', () => {
		expect(stillToDo(sampleAnswers('sp'))).toEqual([]);
	});
});

describe('a value that was not entered', () => {
	it('is said so in the review, not left blank', () => {
		const rows = reviewRows(sampleAnswers('op', 'wizard'));
		// A provider's issuer comes with its configuration; it is not something left unset.
		expect(rows.find((r) => r.label === 'Issuer')?.value).toBe(
			'Read from the provider’s configuration'
		);
	});
});

describe('the schemas of a mapping', () => {
	it('are not preselected, and a value the direction does not offer counts as unset', () => {
		const out = schemaOptions(true);
		const incoming = schemaOptions(false);
		expect(validSchema('', out.inputs)).toBe('');
		expect(validSchema('standard', out.inputs)).toBe('');
		expect(validSchema('extended', out.inputs)).toBe('extended');
		expect(validSchema('authrim', incoming.outputs)).toBe('authrim');
		expect(validSchema('authrim', incoming.inputs)).toBe('');
	});

	it('wait for a choice: required where the flow cannot work without one, otherwise to do', () => {
		for (const kind of ['sp', 'idp'] as const) {
			expect(partState('mapping-schemas', sampleAnswers(kind, 'wizard'))).toBe('required');
			expect(partState('mapping-schemas', sampleAnswers(kind, 'complete'))).toBe('done');
		}
		for (const kind of ['rp', 'op'] as const) {
			expect(partState('mapping-schemas', sampleAnswers(kind, 'wizard'))).toBe('todo');
			expect(partState('mapping-schemas', sampleAnswers(kind, 'complete'))).toBe('done');
		}
	});

	it('are not met by a value kept from the other direction', () => {
		const a = sampleAnswers('rp', 'wizard');
		a.extras.inputSchema = 'standard'; // only offered coming in
		a.extras.outputSchema = 'standard';
		expect(partState('mapping-schemas', a)).toBe('todo');
	});

	it('leave an app without a mapping set until one is picked', () => {
		expect(sampleAnswers('rp', 'wizard').rp.mappingSet).toBe('');
	});
});

describe('the sides of a connection', () => {
	it('says what Authrim does for every kind', () => {
		for (const kind of ['rp', 'sp', 'op', 'idp'] as const) {
			expect(kindRole(kind).badge).not.toBe('');
			expect(kindRole(kind).line).toMatch(/Authrim/);
		}
		expect(kindRole('rp').badge).toBe(kindRole('sp').badge);
		expect(kindRole('op').badge).not.toBe(kindRole('rp').badge);
	});

	it('keeps what Authrim gives the other side outside the steps of the flow', () => {
		for (const kind of KINDS) {
			expect(FLOW[kind], kind).not.toContain(SHARE_PART[kind]);
		}
		expect(SHARE_PART.rp).toBe('rp-share');
	});
});

describe('the words, in another language', () => {
	afterEach(() => i18n.set('en'));

	it('follow the language at the time they are asked for', () => {
		const english = labelOf('rp-redirect');
		i18n.set('ja');
		expect(labelOf('rp-redirect')).toBe('リダイレクト URI');
		expect(labelOf('rp-redirect')).not.toBe(english);
		i18n.set('en');
		expect(labelOf('rp-redirect')).toBe(english);
	});

	it('reach the wizard steps, the flow, the review and the messages', () => {
		i18n.set('ja');
		expect(stepsFor({ direction: '', kind: '' }).map((step) => step.label)).toEqual([
			'追加するもの',
			'種類'
		]);
		expect(groupLabel(FLOW_GROUPS.rp[0])).toBe('新規登録');
		expect(kindProtocol('sp')).toBe('SAML（SP）');
		expect(kindRole('op').line).toMatch(/Authrim/);
		expect(leaveDialog().body).toBe(
			'設定に進むまで何も保存されません。ここで入力した内容は失われます。'
		);
		expect(nameOf(emptyAnswers())).toBe('新しい接続');
		expect(missingParts(sampleAnswers('sp', 'wizard'))).toEqual([
			'入力と出力のスキーマ',
			'マッピングセット'
		]);
		const rows = reviewRows(sampleAnswers('op', 'wizard'));
		expect(rows.find((row) => row.label === 'Issuer')?.value).toBe(
			'プロバイダーの構成情報から取得'
		);
		expect(httpsUrlProblem('http://x.example')).toBe('https:// のアドレスを入力してください。');
		expect(schemaOptions(true).inputs[0].label).toBe('Authrim の利用者');
	});
});

describe('stored choices in the overview', () => {
	afterEach(() => i18n.set('en'));

	it('are shown as the text of the choice, in the language on screen', () => {
		const sp = sampleAnswers('sp', 'complete');
		sp.extras.role = 'editor';
		const value = (label: string) => reviewRows(sp).find((row) => row.label === label)?.value;
		i18n.set('en');
		expect(value('Identifier')).toBe('Persistent, different for each service');
		expect(value('Mapping set')).toBe('Follow the tenant default');
		i18n.set('ja');
		const ja = reviewRows(sp);
		expect(ja.some((row) => row.value === 'persistent' || row.value === 'tenant-default')).toBe(
			false
		);
		expect(ja.find((row) => row.label === t('sf.row.identifier'))?.value).toBe(
			t('sf.sp.nameId.persistent')
		);
	});
});
