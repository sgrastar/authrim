interface Asn1Element {
  tag: number;
  length: number;
  data: Uint8Array;
  headerLength: number;
}

function parseAsn1Element(data: Uint8Array, offset: number): Asn1Element {
  if (!Number.isInteger(offset) || offset < 0 || offset + 2 > data.length) {
    throw new Error('Invalid DER certificate structure');
  }

  const tag = data[offset];
  const firstLength = data[offset + 1];
  let length = firstLength;
  let headerLength = 2;

  if ((firstLength & 0x80) !== 0) {
    const numLengthBytes = firstLength & 0x7f;
    if (numLengthBytes === 0 || numLengthBytes > 4 || offset + 2 + numLengthBytes > data.length) {
      throw new Error('Invalid DER certificate length');
    }
    length = 0;
    for (let i = 0; i < numLengthBytes; i++) {
      length = length * 256 + data[offset + 2 + i];
    }
    headerLength = 2 + numLengthBytes;
  }

  const start = offset + headerLength;
  const end = start + length;
  if (!Number.isSafeInteger(length) || end > data.length) {
    throw new Error('Invalid DER certificate length');
  }

  return {
    tag,
    length,
    data: data.subarray(start, end),
    headerLength,
  };
}

export interface X509CertificateValidity {
  notBefore: number;
  notAfter: number;
}

export function extractCertificateValidity(certDer: Uint8Array): X509CertificateValidity {
  const certSeq = parseAsn1Element(certDer, 0);
  if (certSeq.tag !== 0x30 || certSeq.headerLength + certSeq.length !== certDer.length) {
    throw new Error('Invalid certificate: expected SEQUENCE');
  }

  const tbsSeq = parseAsn1Element(certSeq.data, 0);
  if (tbsSeq.tag !== 0x30) {
    throw new Error('Invalid TBSCertificate: expected SEQUENCE');
  }

  let pos = 0;
  const firstField = parseAsn1Element(tbsSeq.data, pos);
  if (firstField.tag === 0xa0) {
    pos += firstField.headerLength + firstField.length;
  }

  // Skip serialNumber, signature, and issuer to reach Validity.
  for (let i = 0; i < 3; i++) {
    const field = parseAsn1Element(tbsSeq.data, pos);
    pos += field.headerLength + field.length;
  }

  const validity = parseAsn1Element(tbsSeq.data, pos);
  if (validity.tag !== 0x30) {
    throw new Error('Invalid certificate: expected Validity SEQUENCE');
  }
  const notBefore = parseAsn1Element(validity.data, 0);
  const notAfterOffset = notBefore.headerLength + notBefore.length;
  const notAfter = parseAsn1Element(validity.data, notAfterOffset);
  if (notAfterOffset + notAfter.headerLength + notAfter.length !== validity.data.length) {
    throw new Error('Invalid certificate: malformed Validity SEQUENCE');
  }

  return {
    notBefore: parseX509Time(notBefore),
    notAfter: parseX509Time(notAfter),
  };
}

export function assertCertificateCurrentlyValid(pem: string, now: number = Date.now()): void {
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    return;
  }

  const { notBefore, notAfter } = extractCertificateValidity(decodeCertificatePem(pem));
  if (now < notBefore) {
    throw new Error('SAML signing certificate is not valid yet');
  }
  if (now > notAfter) {
    throw new Error('SAML signing certificate has expired');
  }
}

function decodeCertificatePem(pem: string): Uint8Array {
  const match = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
  const base64 = match?.[1]?.replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/]+=*$/.test(base64)) {
    throw new Error('Invalid certificate encoding');
  }

  try {
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    throw new Error('Invalid certificate encoding');
  }
}

function parseX509Time(element: Asn1Element): number {
  if (element.tag !== 0x17 && element.tag !== 0x18) {
    throw new Error('Invalid X.509 validity time');
  }

  const text = new TextDecoder().decode(element.data);
  const match =
    element.tag === 0x17
      ? text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/)
      : text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/);
  if (!match) {
    throw new Error('Invalid X.509 validity time');
  }

  const [
    ,
    encodedYear,
    encodedMonth,
    encodedDay,
    encodedHour,
    encodedMinute,
    encodedSecond = '00',
  ] = match;
  const year =
    element.tag === 0x17
      ? Number(encodedYear) >= 50
        ? 1900 + Number(encodedYear)
        : 2000 + Number(encodedYear)
      : Number(encodedYear);
  const month = Number(encodedMonth);
  const day = Number(encodedDay);
  const hour = Number(encodedHour);
  const minute = Number(encodedMinute);
  const second = Number(encodedSecond);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new Error('Invalid X.509 validity time');
  }
  return date.getTime();
}

export function extractSubjectPublicKeyInfo(certDer: Uint8Array): Uint8Array {
  const certSeq = parseAsn1Element(certDer, 0);
  if (certSeq.tag !== 0x30) {
    throw new Error('Invalid certificate: expected SEQUENCE');
  }

  const tbsSeq = parseAsn1Element(certSeq.data, 0);
  if (tbsSeq.tag !== 0x30) {
    throw new Error('Invalid TBSCertificate: expected SEQUENCE');
  }

  // Fields: version?, serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo.
  let pos = 0;
  let fieldIndex = 0;
  let hasExplicitVersion = false;

  while (pos < tbsSeq.data.length && fieldIndex < 7) {
    const element = parseAsn1Element(tbsSeq.data, pos);

    if (fieldIndex === 0 && element.tag === 0xa0) {
      hasExplicitVersion = true;
      pos += element.headerLength + element.length;
      fieldIndex++;
      continue;
    }

    const subjectPublicKeyInfoIndex = hasExplicitVersion ? 6 : 5;
    if (fieldIndex === subjectPublicKeyInfoIndex) {
      const start = pos;
      const end = pos + element.headerLength + element.length;
      return tbsSeq.data.subarray(start, end);
    }

    pos += element.headerLength + element.length;
    fieldIndex++;
  }

  throw new Error('SubjectPublicKeyInfo not found in certificate');
}
