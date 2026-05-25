interface Asn1Element {
  tag: number;
  length: number;
  data: Uint8Array;
  headerLength: number;
}

function parseAsn1Element(data: Uint8Array, offset: number): Asn1Element {
  const tag = data[offset];
  let length = data[offset + 1];
  let headerLength = 2;

  if (length > 127) {
    const numLengthBytes = length & 0x7f;
    length = 0;
    for (let i = 0; i < numLengthBytes; i++) {
      length = (length << 8) | data[offset + 2 + i];
    }
    headerLength = 2 + numLengthBytes;
  }

  return {
    tag,
    length,
    data: data.subarray(offset + headerLength, offset + headerLength + length),
    headerLength,
  };
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
