import type { Env, SAMLSigningRole } from '@authrim/ar-lib-core';
import { signXml, type SignOptions } from './signature';
import { parseXml, findElement, getAttribute } from './xml-utils';
import { SAML_NAMESPACES } from './constants';
import { getSAMLSigningMaterial, type SAMLSigningKeyContext } from './saml-signing-keys';

export type SAMLMetadataSigningMode = 'disabled' | 'enabled';

export interface SAMLMetadataSigningMaterial {
  privateKeyPem: string;
  certificate: string;
}

export type SAMLMetadataXmlSigner = (xml: string, options: SignOptions) => string;

export function resolveSAMLMetadataSigningMode(env: Partial<Env>): SAMLMetadataSigningMode {
  const value = env.SAML_METADATA_SIGNING?.trim().toLowerCase();
  return value === 'enabled' || value === 'true' || value === '1' ? 'enabled' : 'disabled';
}

export function shouldSignSAMLMetadata(env: Partial<Env>): boolean {
  return resolveSAMLMetadataSigningMode(env) === 'enabled';
}

export async function getSAMLMetadataSigningMaterial(
  env: Env,
  context: SAMLSigningKeyContext & { role: SAMLSigningRole }
): Promise<SAMLMetadataSigningMaterial> {
  const material = await getSAMLSigningMaterial(env, context);
  return {
    privateKeyPem: material.privateKeyPem,
    certificate: material.certificate,
  };
}

export function signSAMLMetadata(
  metadataXml: string,
  material: SAMLMetadataSigningMaterial,
  signer: SAMLMetadataXmlSigner = signXml
): string {
  const descriptorId = getSAMLMetadataDescriptorId(metadataXml);

  return signer(metadataXml, {
    privateKey: material.privateKeyPem,
    certificate: material.certificate,
    referenceUri: `#${descriptorId}`,
    signatureLocation: 'prepend',
    includeKeyInfo: true,
  });
}

function getSAMLMetadataDescriptorId(metadataXml: string): string {
  const doc = parseXml(metadataXml);
  const entityDescriptor = findElement(doc, SAML_NAMESPACES.MD, 'EntityDescriptor');
  const descriptorId = entityDescriptor ? getAttribute(entityDescriptor, 'ID') : null;

  if (!descriptorId) {
    throw new Error('SAML metadata signing requires EntityDescriptor ID');
  }

  return descriptorId;
}
