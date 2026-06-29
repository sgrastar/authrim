import type { MappingEdge, MappingNode } from './types';

export interface AutoMapConnectionCandidate {
	fromId: string;
	toId: string;
	score: number;
	reason: string;
}

interface AutoMapEndpoint {
	node: MappingNode;
	labelText: string;
	searchText: string;
	type: string | null;
	fieldRefText: string;
	semanticKeys: Set<string>;
}

interface AutoMapFieldCandidate {
	key: string;
	label: string;
	aliases: string[];
}

export const AUTO_MAP_FIELD_CANDIDATES: AutoMapFieldCandidate[] = [
	{
		key: 'email',
		label: 'Email',
		aliases: [
			'email',
			'e-mail',
			'mail',
			'email address',
			'email_address',
			'primary email',
			'work email',
			'business email',
			'mailprimaryaddress',
			'mailalternateaddress',
			'proxyaddresses',
			'emails.value',
			'emails.primary',
			'emails[type=work].value',
			'emails[type eq work].value',
			'urn:oid:0.9.2342.19200300.100.1.3',
			'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
			'credentialSubject.email',
			'credentialSubject.emailAddress',
			'correo electronico',
			'courriel',
			'adresse email',
			'e mail adresse',
			'endereco de email',
			'メール',
			'メールアドレス',
			'電子メール',
			'电子邮件',
			'邮箱',
			'이메일'
		]
	},
	{
		key: 'email_verified',
		label: 'Email Verified',
		aliases: [
			'email verified',
			'emailverified',
			'email is verified',
			'is email verified',
			'mail verified',
			'email confirmed',
			'email validated',
			'emails.verified',
			'emails[type=work].verified',
			'email_verified_at',
			'correo verificado',
			'email verifie',
			'email verificado',
			'メール確認済み',
			'メール認証済み',
			'邮箱已验证',
			'이메일확인'
		]
	},
	{
		key: 'phone_number',
		label: 'Phone Number',
		aliases: [
			'phone',
			'phone number',
			'telephone',
			'tel',
			'phone no',
			'phone_no',
			'phone_number',
			'work phone',
			'business phone',
			'telephone number',
			'telephonenumber',
			'homephone',
			'facsimiletelephonenumber',
			'ipphone',
			'pager',
			'phoneNumbers.value',
			'phoneNumbers[type=work].value',
			'phoneNumbers[type eq work].value',
			'phoneNumbers[type=mobile].value',
			'phoneNumbers[type eq mobile].value',
			'urn:oid:2.5.4.20',
			'urn:oid:0.9.2342.19200300.100.1.20',
			'urn:oid:0.9.2342.19200300.100.1.41',
			'credentialSubject.phoneNumber',
			'credentialSubject.telephone',
			'telefono',
			'telephone portable',
			'telefonnummer',
			'telefone',
			'電話番号',
			'携帯番号',
			'電話',
			'手机号',
			'电话号码',
			'전화번호',
			'휴대폰'
		]
	},
	{
		key: 'phone_number_verified',
		label: 'Phone Number Verified',
		aliases: [
			'phone verified',
			'phone number verified',
			'phone confirmed',
			'phone validated',
			'mobile verified',
			'phoneNumbers.verified',
			'phone_number_verified_at',
			'telefono verificado',
			'telephone verifie',
			'telefone verificado',
			'電話番号確認済み',
			'電話番号認証済み',
			'手机号已验证',
			'전화번호확인'
		]
	},
	{
		key: 'name',
		label: 'Full Name',
		aliases: [
			'name',
			'full name',
			'fullname',
			'full_name',
			'legal name',
			'legal_name',
			'common name',
			'commonname',
			'cn',
			'canonical name',
			'name.formatted',
			'name.formattedName',
			'urn:oid:2.5.4.3',
			'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
			'credentialSubject.name',
			'credentialSubject.fullName',
			'person name',
			'nombre completo',
			'nom complet',
			'vollstandiger name',
			'nome completo',
			'氏名',
			'名前',
			'姓名',
			'名字',
			'이름',
			'성명'
		]
	},
	{
		key: 'display_name',
		label: 'Display Name',
		aliases: [
			'display name',
			'displayname',
			'display_name',
			'display label',
			'display_label',
			'name.display',
			'displayName',
			'urn:oid:2.16.840.1.113730.3.1.241',
			'表示名'
		]
	},
	{
		key: 'given_name',
		label: 'First Name',
		aliases: [
			'first name',
			'firstname',
			'first_name',
			'given name',
			'givenname',
			'given_name',
			'givenName',
			'forename',
			'name.givenName',
			'name.given',
			'urn:oid:2.5.4.42',
			'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
			'credentialSubject.givenName',
			'credentialSubject.firstName',
			'christian name',
			'nombre',
			'prenom',
			'vorname',
			'nome',
			'名',
			'下の名前',
			'이름'
		]
	},
	{
		key: 'family_name',
		label: 'Last Name',
		aliases: [
			'last name',
			'lastname',
			'last_name',
			'family name',
			'familyname',
			'family_name',
			'familyName',
			'surname',
			'sn',
			'name.familyName',
			'name.family',
			'urn:oid:2.5.4.4',
			'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
			'credentialSubject.familyName',
			'credentialSubject.lastName',
			'second name',
			'apellido',
			'apellidos',
			'nom de famille',
			'nachname',
			'sobrenome',
			'姓',
			'苗字',
			'성'
		]
	},
	{
		key: 'middle_name',
		label: 'Middle Name',
		aliases: [
			'middle name',
			'middlename',
			'middle_name',
			'middle initial',
			'second given name',
			'name.middleName',
			'credentialSubject.middleName',
			'segundo nombre',
			'deuxieme prenom',
			'ミドルネーム',
			'中間名'
		]
	},
	{
		key: 'nickname',
		label: 'Nickname',
		aliases: [
			'nickname',
			'nick name',
			'nick_name',
			'alias',
			'preferred name',
			'nickName',
			'nickname',
			'displayNickname',
			'credentialSubject.nickname',
			'ニックネーム',
			'別名'
		]
	},
	{
		key: 'preferred_username',
		label: 'Preferred Username',
		aliases: [
			'preferred username',
			'preferred_username',
			'username',
			'user name',
			'user_name',
			'login',
			'login id',
			'login_id',
			'account name',
			'account_name',
			'userprincipalname',
			'userPrincipalName',
			'upn',
			'samaccountname',
			'sAMAccountName',
			'accountName',
			'uid',
			'loginName',
			'userName',
			'username',
			'urn:oid:0.9.2342.19200300.100.1.1',
			'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier',
			'credentialSubject.username',
			'netid',
			'network id',
			'ユーザー名',
			'ログインid',
			'用户名',
			'사용자명'
		]
	},
	{
		key: 'profile',
		label: 'Profile URL',
		aliases: [
			'profile',
			'profile url',
			'profile_url',
			'profile page',
			'profilepage',
			'profileUrl',
			'profileURL',
			'profile.uri',
			'credentialSubject.profileUrl',
			'perfil',
			'profil',
			'プロフィールurl',
			'プロフィール',
			'个人资料',
			'프로필'
		]
	},
	{
		key: 'picture',
		label: 'Picture URL',
		aliases: [
			'picture',
			'picture url',
			'picture_url',
			'photo',
			'photo url',
			'avatar',
			'avatar url',
			'thumbnailphoto',
			'thumbnailPhoto',
			'jpegphoto',
			'jpegPhoto',
			'photos.value',
			'photos[type=photo].value',
			'photos[type eq photo].value',
			'image url',
			'image_url',
			'portrait',
			'foto',
			'写真',
			'画像',
			'头像',
			'照片',
			'사진'
		]
	},
	{
		key: 'website',
		label: 'Website',
		aliases: [
			'website',
			'web site',
			'web_site',
			'homepage',
			'home page',
			'home_page',
			'personal url',
			'wWWHomePage',
			'wwwHomePage',
			'url',
			'credentialSubject.website',
			'url',
			'sitio web',
			'site web',
			'webseite',
			'ウェブサイト',
			'ホームページ',
			'网站',
			'웹사이트'
		]
	},
	{
		key: 'birthdate',
		label: 'Birthdate',
		aliases: [
			'birthdate',
			'birth date',
			'birth_date',
			'date of birth',
			'date_of_birth',
			'dob',
			'birthday',
			'birthDate',
			'dateOfBirth',
			'credentialSubject.birthDate',
			'credentialSubject.dateOfBirth',
			'fecha de nacimiento',
			'date de naissance',
			'geburtsdatum',
			'data de nascimento',
			'生年月日',
			'誕生日',
			'出生日期',
			'生日',
			'생년월일'
		]
	},
	{
		key: 'zoneinfo',
		label: 'Time Zone',
		aliases: [
			'zoneinfo',
			'timezone',
			'time zone',
			'time_zone',
			'tz',
			'tzid',
			'iana timezone',
			'timezone',
			'timeZone',
			'timezoneId',
			'credentialSubject.timeZone',
			'zona horaria',
			'fuseau horaire',
			'zeitzone',
			'fuso horario',
			'タイムゾーン',
			'时区',
			'시간대'
		]
	},
	{
		key: 'locale',
		label: 'Locale',
		aliases: [
			'locale',
			'preferred locale',
			'preferred_locale',
			'language',
			'language code',
			'language_code',
			'lang',
			'preferred language',
			'preferred_language',
			'preferredlanguage',
			'preferredLanguage',
			'localityLanguage',
			'credentialSubject.locale',
			'credentialSubject.language',
			'idioma',
			'langue',
			'sprache',
			'ロケール',
			'言語',
			'语言',
			'언어'
		]
	},
	{
		key: 'updated_at',
		label: 'Last Updated',
		aliases: [
			'updated at',
			'updated_at',
			'updated',
			'last updated',
			'last_updated',
			'modified at',
			'modified_at',
			'last modified',
			'last_modified',
			'changed at',
			'change timestamp',
			'modifytimestamp',
			'modifyTimestamp',
			'whenchanged',
			'whenChanged',
			'updatedAt',
			'meta.lastModified',
			'credentialSubject.updatedAt',
			'更新日時',
			'更新日',
			'更新时间',
			'수정일'
		]
	},
	{
		key: 'address',
		label: 'Address',
		aliases: [
			'address',
			'formatted address',
			'formatted_address',
			'mailing address',
			'postal address',
			'home address',
			'addresses.formatted',
			'addresses[type=work].formatted',
			'addresses[type eq work].formatted',
			'physicalDeliveryOfficeName',
			'postalAddress',
			'homePostalAddress',
			'registeredAddress',
			'credentialSubject.address',
			'direccion',
			'adresse',
			'anschrift',
			'endereco',
			'住所',
			'地址',
			'주소'
		]
	},
	{
		key: 'address_street_address',
		label: 'Street Address',
		aliases: [
			'street address',
			'street_address',
			'street',
			'address line',
			'address_line',
			'address line 1',
			'address_line_1',
			'address1',
			'addr1',
			'line1',
			'street1',
			'streetaddress',
			'streetAddress',
			'addresses.streetAddress',
			'addresses[type=work].streetAddress',
			'addresses[type eq work].streetAddress',
			'postalAddress.street',
			'credentialSubject.address.streetAddress',
			'calle',
			'rue',
			'strasse',
			'logradouro',
			'住所 番地',
			'番地',
			'住所1',
			'街道地址',
			'도로명주소'
		]
	},
	{
		key: 'address_locality',
		label: 'City / Locality',
		aliases: [
			'city',
			'locality',
			'municipality',
			'town',
			'city name',
			'city_name',
			'l',
			'localityName',
			'addresses.locality',
			'addresses[type=work].locality',
			'addresses[type eq work].locality',
			'credentialSubject.address.locality',
			'localidad',
			'ciudad',
			'ville',
			'commune',
			'stadt',
			'cidade',
			'市区町村',
			'市町村',
			'市',
			'城市',
			'市区',
			'도시'
		]
	},
	{
		key: 'address_region',
		label: 'Region',
		aliases: [
			'region',
			'state',
			'state province',
			'state_province',
			'province',
			'county',
			'prefecture',
			'territory',
			'region code',
			'st',
			'stateOrProvinceName',
			'addresses.region',
			'addresses[type=work].region',
			'addresses[type eq work].region',
			'credentialSubject.address.region',
			'provincia',
			'departement',
			'bundesland',
			'estado',
			'都道府県',
			'県',
			'州',
			'省份',
			'地区',
			'지역'
		]
	},
	{
		key: 'address_postal_code',
		label: 'Postal Code',
		aliases: [
			'postal code',
			'postal_code',
			'postcode',
			'post code',
			'zip',
			'zip code',
			'zipcode',
			'zip_code',
			'postalcode',
			'postalCode',
			'addresses.postalCode',
			'addresses[type=work].postalCode',
			'addresses[type eq work].postalCode',
			'credentialSubject.address.postalCode',
			'codigo postal',
			'code postal',
			'postleitzahl',
			'cep',
			'郵便番号',
			'邮政编码',
			'邮编',
			'우편번호'
		]
	},
	{
		key: 'address_country',
		label: 'Country',
		aliases: [
			'country',
			'country code',
			'country_code',
			'country name',
			'nation',
			'nationality',
			'c',
			'co',
			'countryName',
			'countryCode',
			'addresses.country',
			'addresses[type=work].country',
			'addresses[type eq work].country',
			'credentialSubject.address.country',
			'credentialSubject.nationality',
			'pais',
			'pays',
			'land',
			'国',
			'国コード',
			'国家',
			'国家代码',
			'국가',
			'나라'
		]
	},
	{
		key: 'group_membership',
		label: 'Group Membership',
		aliases: [
			'group',
			'groups',
			'group membership',
			'affiliation',
			'affiliations',
			'edupersonaffiliation',
			'eduPersonAffiliation',
			'edupersonscopedaffiliation',
			'eduPersonScopedAffiliation',
			'isMemberOf',
			'memberof',
			'member of',
			'member_of',
			'memberships',
			'groups.value',
			'groups.display',
			'groups[].value',
			'groups[].display',
			'urn:oid:1.3.6.1.4.1.5923.1.1.1.1',
			'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
			'urn:mace:dir:attribute-def:eduPersonAffiliation',
			'urn:mace:dir:attribute-def:eduPersonScopedAffiliation',
			'credentialSubject.groups',
			'credentialSubject.affiliation',
			'groups value',
			'组织',
			'소속'
		]
	},
	{
		key: 'entitlements',
		label: 'Entitlements',
		aliases: [
			'entitlement',
			'entitlements',
			'role',
			'roles',
			'role name',
			'permission',
			'permissions',
			'privilege',
			'privileges',
			'access',
			'access right',
			'authorization',
			'authorities',
			'authority',
			'license',
			'licenses',
			'grant',
			'grants',
			'scope',
			'scopes',
			'entitlements.value',
			'entitlements.display',
			'entitlements[].value',
			'roles.value',
			'roles.display',
			'roles[].value',
			'urn:oid:1.3.6.1.4.1.5923.1.1.1.7',
			'urn:mace:dir:attribute-def:eduPersonEntitlement',
			'edupersonentitlement',
			'eduPersonEntitlement',
			'credentialSubject.entitlements',
			'credentialSubject.roles',
			'credentialSubject.permissions',
			'derecho',
			'permiso',
			'autorisation',
			'berechtigung',
			'permissao',
			'権限',
			'ロール',
			'利用者区分',
			'アクセス権',
			'权限',
			'角色',
			'권한',
			'역할'
		]
	},
	{
		key: 'linked_identity',
		label: 'Linked Identity',
		aliases: [
			'linked identity',
			'linked_identity',
			'external id',
			'external_id',
			'external identifier',
			'federated id',
			'federated identifier',
			'nameid',
			'name id',
			'nameidentifier',
			'name_identifier',
			'sub',
			'subject',
			'subject id',
			'subject_id',
			'openid sub',
			'oidc sub',
			'scim id',
			'scim externalid',
			'externalId',
			'unique id',
			'unique identifier',
			'objectguid',
			'objectGuid',
			'objectsid',
			'objectSid',
			'distinguishedname',
			'distinguishedName',
			'dn',
			'entryuuid',
			'entryUUID',
			'entrydn',
			'entryDN',
			'sourcedid',
			'source id',
			'edu person principal name',
			'edupersonprincipalname',
			'eduPersonPrincipalName',
			'eppn',
			'edupersontargetedid',
			'eduPersonTargetedID',
			'persistentid',
			'persistent id',
			'persistent nameid',
			'urn:oid:1.3.6.1.4.1.5923.1.1.1.6',
			'urn:oid:1.3.6.1.4.1.5923.1.1.1.10',
			'urn:mace:dir:attribute-def:eduPersonPrincipalName',
			'urn:mace:dir:attribute-def:eduPersonTargetedID',
			'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
			'credentialSubject.id',
			'credentialSubject.identifier',
			'did',
			'didSubject',
			'identificador',
			'identifiant',
			'kennung',
			'identificador externo',
			'外部id',
			'用户ID',
			'사용자ID'
		]
	}
];

export function suggestAutoMapConnections(input: {
	fromNodes: MappingNode[];
	toNodes: MappingNode[];
	existingEdges: MappingEdge[];
	max?: number;
}): AutoMapConnectionCandidate[] {
	const existing = new Set(input.existingEdges.map((edge) => `${edge.from}->${edge.to}`));
	const fromEndpoints = input.fromNodes.map(nodeToEndpoint);
	const toEndpoints = input.toNodes.map(nodeToEndpoint);
	const ambiguousKeys = ambiguousFieldKeys(fromEndpoints);
	const candidates: AutoMapConnectionCandidate[] = [];

	for (const from of fromEndpoints) {
		for (const to of toEndpoints) {
			if (existing.has(`${from.node.id}->${to.node.id}`)) continue;
			const scored = scoreCandidate(from, to);
			if (!scored) continue;
			if (
				ambiguousKeys.has(scored.fieldKey) &&
				!isExactSameLabel(from, to) &&
				!hasStrongSharedSemanticKey(from, to, scored.fieldKey)
			) {
				continue;
			}
			candidates.push({
				fromId: from.node.id,
				toId: to.node.id,
				score: scored.score,
				reason: scored.reason
			});
		}
	}

	return dedupeCandidates(candidates)
		.sort((a, b) => b.score - a.score || a.fromId.localeCompare(b.fromId))
		.slice(0, input.max ?? 24);
}

function dedupeCandidates(candidates: AutoMapConnectionCandidate[]): AutoMapConnectionCandidate[] {
	const bySource = new Map<string, AutoMapConnectionCandidate>();
	const byTarget = new Map<string, AutoMapConnectionCandidate>();

	for (const candidate of candidates) {
		const sourceWinner = bySource.get(candidate.fromId);
		if (!sourceWinner || candidate.score > sourceWinner.score) {
			bySource.set(candidate.fromId, candidate);
		}
	}

	for (const candidate of bySource.values()) {
		const targetWinner = byTarget.get(candidate.toId);
		if (!targetWinner || candidate.score > targetWinner.score) {
			byTarget.set(candidate.toId, candidate);
		}
	}

	return [...byTarget.values()];
}

function scoreCandidate(
	from: AutoMapEndpoint,
	to: AutoMapEndpoint
): { score: number; reason: string; fieldKey: string } | null {
	const exact = directLabelScore(from, to);
	if (exact) return exact;

	let best: { score: number; reason: string; fieldKey: string } | null = null;
	for (const field of AUTO_MAP_FIELD_CANDIDATES) {
		const fromScore = semanticEndpointScore(from, field);
		const toScore = semanticEndpointScore(to, field);
		if (fromScore === 0 || toScore === 0) continue;
		const score = fromScore + toScore + typeScore(from, to);
		if (isAmbiguousPersonNameField(field.key) && !isExactSameLabel(from, to) && score < 248) {
			continue;
		}
		if (!best || score > best.score) {
			best = {
				score,
				reason: `${field.label} semantic match`,
				fieldKey: field.key
			};
		}
	}
	return best && best.score >= 120 ? best : null;
}

function directLabelScore(
	from: AutoMapEndpoint,
	to: AutoMapEndpoint
): { score: number; reason: string; fieldKey: string } | null {
	if (isVerificationEndpoint(from) !== isVerificationEndpoint(to)) return null;
	const fromLabel = normalizeText(from.node.label);
	const toLabel = normalizeText(to.node.label);
	if (!fromLabel || !toLabel) return null;
	if (fromLabel === toLabel) {
		return {
			score: 210 + typeScore(from, to),
			reason: 'Exact label match',
			fieldKey: `direct:${fromLabel}`
		};
	}
	if (
		fromLabel.length >= 5 &&
		toLabel.length >= 5 &&
		!GENERIC_SUBSTRING_ALIASES.has(fromLabel) &&
		!GENERIC_SUBSTRING_ALIASES.has(toLabel) &&
		(fromLabel.includes(toLabel) || toLabel.includes(fromLabel))
	) {
		return {
			score: 145 + typeScore(from, to),
			reason: 'Close label match',
			fieldKey: `direct:${fromLabel}:${toLabel}`
		};
	}
	return null;
}

function ambiguousFieldKeys(endpoints: AutoMapEndpoint[]): Set<string> {
	const byField = new Map<string, AutoMapEndpoint[]>();
	for (const endpoint of endpoints) {
		for (const field of AUTO_MAP_FIELD_CANDIDATES) {
			if (!['phone_number', 'name'].includes(field.key)) {
				continue;
			}
			if (semanticEndpointScore(endpoint, field) < 112 && !isPhoneLikeEndpoint(endpoint)) continue;
			byField.set(field.key, [...(byField.get(field.key) ?? []), endpoint]);
		}
	}
	return new Set(
		[...byField.entries()]
			.filter(([, matches]) => new Set(matches.map((match) => match.labelText)).size > 1)
			.map(([fieldKey]) => fieldKey)
	);
}

function isExactSameLabel(from: AutoMapEndpoint, to: AutoMapEndpoint): boolean {
	return Boolean(from.labelText && from.labelText === to.labelText);
}

function hasStrongSharedSemanticKey(
	from: AutoMapEndpoint,
	to: AutoMapEndpoint,
	fieldKey: string
): boolean {
	if (!from.semanticKeys.has(fieldKey) || !to.semanticKeys.has(fieldKey)) return false;
	return (
		from.labelText === to.labelText ||
		from.fieldRefText === to.fieldRefText ||
		from.searchText === to.searchText
	);
}

function isAmbiguousPersonNameField(fieldKey: string): boolean {
	return fieldKey === 'name';
}

function isPhoneLikeEndpoint(endpoint: AutoMapEndpoint): boolean {
	return (
		endpoint.type === 'phone' ||
		endpoint.labelText.includes('phone') ||
		endpoint.labelText.includes('mobile') ||
		endpoint.labelText.includes('telephone') ||
		endpoint.labelText.includes('tel') ||
		endpoint.labelText.includes('電話') ||
		endpoint.labelText.includes('携帯')
	);
}

function semanticEndpointScore(endpoint: AutoMapEndpoint, field: AutoMapFieldCandidate): number {
	if (isVerificationEndpoint(endpoint) && !field.key.endsWith('_verified')) return 0;
	if (field.key.endsWith('_verified') && !isVerificationEndpoint(endpoint)) return 0;
	const aliases = [field.key, field.label, ...field.aliases].map(normalizeText).filter(Boolean);
	for (const alias of aliases) {
		if (endpoint.labelText === alias) return 128;
	}
	for (const alias of aliases) {
		if (endpoint.searchText === alias) return 112;
	}
	for (const alias of aliases) {
		if (endpoint.fieldRefText === alias) return 120;
	}
	for (const alias of aliases) {
		if (shouldUseSubstringAlias(alias) && endpoint.labelText.includes(alias)) return 104;
	}
	for (const alias of aliases) {
		if (shouldUseSubstringAlias(alias) && endpoint.searchText.includes(alias)) return 96;
	}
	return 0;
}

function isVerificationEndpoint(endpoint: AutoMapEndpoint): boolean {
	return (
		endpoint.searchText.includes('verified') ||
		endpoint.searchText.includes('verification') ||
		endpoint.searchText.includes('確認済み')
	);
}

function typeScore(from: AutoMapEndpoint, to: AutoMapEndpoint): number {
	if (!from.type || !to.type) return 0;
	if (from.type === to.type) return 12;
	if (
		to.type === 'text' &&
		['email', 'phone', 'identifier', 'locale', 'enum'].includes(from.type)
	) {
		return 8;
	}
	if (from.type === 'text' && ['identifier', 'locale'].includes(to.type)) return 4;
	return -24;
}

function nodeToEndpoint(node: MappingNode): AutoMapEndpoint {
	const fieldRefValues = [
		node.fieldRef?.namespace,
		node.fieldRef?.path,
		node.fieldRef?.catalogEntryId
	].filter(Boolean);
	const searchText = normalizeText(
		[
			node.label,
			node.caption,
			node.type,
			node.storageTarget,
			node.uiGroupKey,
			node.uiGroupLabel,
			...fieldRefValues
		]
			.filter(Boolean)
			.join(' ')
	);
	const fieldRefText = normalizeText(fieldRefValues.join(' '));
	const semanticKeys = new Set(
		AUTO_MAP_FIELD_CANDIDATES.filter(
			(field) => semanticEndpointScoreRaw(searchText, fieldRefText, field) >= 112
		).map((field) => field.key)
	);
	return {
		node,
		labelText: normalizeText(node.label),
		searchText,
		type: normalizeType(node.type),
		fieldRefText,
		semanticKeys
	};
}

function semanticEndpointScoreRaw(
	searchText: string,
	fieldRefText: string,
	field: AutoMapFieldCandidate
): number {
	const aliases = [field.key, field.label, ...field.aliases].map(normalizeText).filter(Boolean);
	if (aliases.some((alias) => searchText === alias)) return 112;
	if (aliases.some((alias) => fieldRefText === alias)) return 120;
	if (aliases.some((alias) => shouldUseSubstringAlias(alias) && searchText.includes(alias)))
		return 96;
	return 0;
}

function normalizeText(value: string | undefined): string {
	return (value ?? '')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.normalize('NFC')
		.toLowerCase()
		.replace(/field\.canonical\./g, ' ')
		.replace(/[^a-z0-9ぁ-んァ-ヶ一-龠々ー가-힣]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\s+/g, '');
}

function containsCjk(value: string): boolean {
	return /[ぁ-んァ-ヶ一-龠々ー가-힣]/.test(value);
}

function shouldUseSubstringAlias(alias: string): boolean {
	if (containsCjk(alias)) return true;
	return alias.length >= 5 && !GENERIC_SUBSTRING_ALIASES.has(alias);
}

const GENERIC_SUBSTRING_ALIASES = new Set([
	'alias',
	'email',
	'group',
	'login',
	'name',
	'nation',
	'phone',
	'profile',
	'state',
	'subject',
	'user',
	'username',
	'website'
]);

function normalizeType(value: string | undefined): string | null {
	const normalized = normalizeText(value);
	if (!normalized) return null;
	if (normalized.includes('boolean') || normalized.includes('bool')) return 'boolean';
	if (normalized.includes('number') || normalized.includes('integer')) return 'number';
	if (normalized.includes('email') || normalized.includes('mail')) return 'email';
	if (normalized.includes('phone') || normalized.includes('tel') || normalized.includes('mobile')) {
		return 'phone';
	}
	if (normalized.includes('identifier') || normalized === 'id') return 'identifier';
	if (normalized.includes('array') || normalized.includes('multi') || normalized.includes('list')) {
		return 'multi-value';
	}
	if (normalized.includes('json') || normalized.includes('object')) return 'json';
	if (normalized.includes('locale') || normalized.includes('timezone')) return 'locale';
	if (normalized.includes('enum')) return 'enum';
	if (normalized.includes('string') || normalized.includes('text') || normalized.includes('date')) {
		return 'text';
	}
	return normalized;
}
