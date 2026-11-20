import { describe, expect, it } from 'vitest';
import { computeAgentToolContractDigest } from '../core';
import { createAdminReadToolCatalog } from '../protocol/mcp/admin-read-tools';
import { createAdminToolCatalog } from '../protocol/mcp/admin-tools';

/**
 * Grants and Task Set versions pin each Tool by schemaDigest (agentGrantPinsToolContract).
 * Any change to a model-visible or authorization-relevant field of a built-in Tool silently
 * revokes every Grant that pinned the old contract, so such a change must be deliberate: update
 * this table together with a contractVersion bump and a migration note.
 */
const PINNED_CONTRACT_DIGESTS: Readonly<Record<string, string>> = {
  'admin.session.discovery-profiles.select':
    'sha256:65a10de9b81ddcd4b398e5b76b010ab1a20c53244358cbe8059084e49fa36247',
  'admin.read.users.search':
    'sha256:99f0d6c6f81a8edaa0f8c60a79a109a5bd6802d452890422c7fa435ffb1957e0',
  'admin.read.users.get': 'sha256:fc806cd0951ac943329996596a29ab44f6c8853f8836d59475c04f4a5e1fdd5d',
  'admin.read.clients.list':
    'sha256:10644ac1cbdf2197a392c647a65a329845b454e0089cf97f4b9bb96939210c08',
  'admin.read.clients.get':
    'sha256:cdd321cd889fbee5141e2e51a39db51eba214b5c914d6e01670935d3a620f90f',
  'admin.read.agent-grants.list':
    'sha256:1af2706d2fb75c3fe579a46c75d0a02cbc5764746d3707da8d170cb99078de22',
  'admin.read.agent-access.explain':
    'sha256:38a97f5c1d751b8adcd61a7def896226b64bccac244bd25c7186e52018129d6e',
  'admin.read.audit.search':
    'sha256:e62f95c0b8623838b582fc763cf18c70cba7e2a6b50c8ae092b922f0cc570a8f',
  'admin.read.agent-settings.get':
    'sha256:3ab672303dcf6a3dc4e1e8c859c15adaade25d8b62b30c9bde20f62d3c10e653',
  'admin.read.runtime.diagnostics':
    'sha256:0dc39cff18c4a234665fcecee597765f393d018b033471144d20fbc618b4c2c0',
  'admin.read.identity-providers.inspect':
    'sha256:a54defa54a2a6ee061248647d21f3150f2b56b28da0a2940b26e2bb0be598be2',
  'admin.read.authorization.organizations':
    'sha256:120614694b229d84b3c17d9ccaece36a85d79f4b49931ca2d8ecdc40fa6707c6',
  'admin.read.authorization.roles':
    'sha256:c1fe9c33567b461396e65114713d4d4e67a8a9ecd7de9fa602640f35044ecf26',
  'admin.read.authorization.policies':
    'sha256:7e3ee1745c86a60300a8ef546d9b27b4e32a15115d372fb8b36c2e8e0ea9ac6a',
  'admin.read.flows.inspect':
    'sha256:38f6c791256131affafb1ecf38ca6c4cacb811b4de39f9f8ebf3c094cd6328f5',
  'admin.read.consent.inspect':
    'sha256:bfa28fbb80bdc5d88bcf075fc5dd82f8fec10c16ae8598a676f72ba80c5256dd',
  'admin.read.sessions.inspect':
    'sha256:91ca73c274e56b38a8bb1cff2096fdb3e1268644c470d62f5bf3da44de81e559',
  'admin.read.assurance.inspect':
    'sha256:14baeb4efe7b5e89a760edc2385b04a4b641d33ce9d82daa521f3b2ca6f6240b',
  'admin.read.protocol-security.inspect':
    'sha256:4bd1e6c7eb3a34c92e04c483baa5e908706256eff42baa0b24db8f4139b8ca67',
  'admin.read.oauth.inspect':
    'sha256:f30616952a53d3ec9c0140bf2b70a7d1618daa9f0d9c93090ebf8c2b62855279',
  'admin.read.token-exchange.inspect':
    'sha256:90e9f53687291a6f74bee35a056df0026c1543123aecaacec8645f3127bacea2',
  'admin.read.logout.inspect':
    'sha256:d92716a686119002545f9c927af020447c3b68ae102aee3977f06b0c776dc5c8',
  'admin.read.webhooks.inspect':
    'sha256:4cdad47048b9ae6c6cdfffc2d86a0b7a1edb09caac90d01159056ad7640a2763',
  'admin.read.login-ui.inspect':
    'sha256:bcce2a424b530f35b89ac5fe5feeb6fc79596646f8bea05ac488bcdcfaa972a9',
  'admin.read.conformance.inspect':
    'sha256:43a2cd1d4c4858e8e89398b2bc957c90de1ea4874ed4c875cd130d07d2260445',
  'admin.read.flows.validate':
    'sha256:73b2e239f01b7ac25e30f860c1e7816f25ff2a09bb5b34639e8fb2728431690e',
  'admin.read.authorization.simulate':
    'sha256:5dbf31df9a9267a81752c03980b58163d18c19670417ab5e455d3495919fde58',
  'admin.read.tenant-policy.validate':
    'sha256:c3b3909904e56681586484b3d2e2393f1114b1b0f3dbb4acd2fc302bddf1307e',
  'admin.read.clients.profile-validate':
    'sha256:fd21d7e54786397fa9fb9004744db11ffbd60ecabc8044eb346841bbec2c2ada',
  'admin.write.clients.metadata':
    'sha256:e506bc18b22e8552baf0df310c16d215730f532817e58debfcd7b53fc5324cbb',
  'admin.write.users.suspend':
    'sha256:d43faa7e9171ea2253566b8aed3dde44b2370cdd0f76da555ad601e64bece12e',
  'admin.write.assurance.update':
    'sha256:5cc1e43af0ba4b82b7760fbf4b8d46b93f75ddb84ed32a3b2ee627da533ac2bd',
  'admin.write.protocol-security.update':
    'sha256:79064a18e70188bf01df99535972bc6ca5eee10848f72475094c16ac0a72b424',
  'admin.write.token-exchange.update':
    'sha256:3b8f5ef1dc926f7903204be726cc5b7036fd5e5d4761835808c67403a7115329',
  'admin.write.oauth.update':
    'sha256:dea904db43d14d67c81e63aa3e03af309960bb3ee99078fb95188f3f8e15f99e',
  'admin.write.session.update':
    'sha256:3afbe737e7919dcc997f06de301520727389bb3dc6f8e5b0d0d0cca2904ef4c3',
  'admin.write.login-ui.update':
    'sha256:e06411b389025a45c7a9e07ff398a8c98ff3c7e43d641385e089b6481e27817d',
  'admin.write.clients.protocol-security':
    'sha256:55cf999422efc5094a46b47293b7cbd4318ef0bbee2c963cc8b1e8f1cb11cae9',
  'admin.write.clients.public-create':
    'sha256:21bafdebe09f3e4946db088dbc5cfefda41773145a995da4a8b38d2378a6a1b5',
  'admin.read.configuration.capabilities':
    'sha256:66b73cd54c0648dd69e4f7e23fd5ddf3881251897a3fb037359e0ee36549629d',
  'admin.write.configuration.plan.create':
    'sha256:595637130d132f1ed1fed5d8a133bd7d743349ce2cda0f8a075cfb0e3e50ac10',
  'admin.write.configuration.plan.validate':
    'sha256:27652354a55042f73bac0432946af274edff1095e9cae1ed61851a7b0dba0283',
  'admin.read.configuration.plan.diff':
    'sha256:795bb3e891f9b84df01901f431337be9d4d7908afedaf3f2c5111cd036a7fb56',
  'admin.write.configuration.plan.apply':
    'sha256:8d476c7dc0fac52375921b8398a94b8f67786a5a1e3544038ad4a6c055a71761',
  'admin.write.configuration.plan.cancel':
    'sha256:c3cfc3d0bc81de3fcefb9d41263a3fff7370fc973bf36bac5cc78d14f9015c4d',
  'admin.read.configuration.plan.status':
    'sha256:dc1da4601ecb0b30c87399cbcef7ce1879796d8c51ef32e14c319b38213e5ca2',
  'admin.read.configuration.plan.verify':
    'sha256:06cf1bab688580492f71795afb0f410613151739ff05cc3b49d1503ac8149a8b',
  'admin.write.bulk.plan.create':
    'sha256:14ae9455889a75f2acf850fdabea2b512e6295a1d5c6c196cc44d6c7149c0065',
  'admin.read.bulk.plan.get':
    'sha256:da03e5b613da5bbfddf7a6ae0c650af638243770d2261b91ff65ab9a979c4c7a',
  'admin.write.bulk.plan.validate':
    'sha256:01c9ffc8c9295e26b7535386aa6495bd161e234548916bcf75464ba36dc8ab16',
};

describe('built-in admin Tool contract digests', () => {
  const catalog = createAdminToolCatalog();

  it('pins every built-in Tool contract to a reviewed digest', () => {
    const actual = Object.fromEntries(catalog.list().map((tool) => [tool.id, tool.schemaDigest]));
    expect(actual).toStrictEqual(PINNED_CONTRACT_DIGESTS);
  });

  it('derives each pinned digest from the full contract manifest', () => {
    for (const tool of catalog.list()) {
      expect(computeAgentToolContractDigest(tool)).toBe(PINNED_CONTRACT_DIGESTS[tool.id]);
    }
  });

  it('versions the read-only catalog separately from the full admin catalog', () => {
    const readCatalog = createAdminReadToolCatalog();
    expect(readCatalog.version).toBe('admin-read-v1');
    expect(catalog.version).toBe('admin-agent-access-v9');
    for (const tool of readCatalog.list()) {
      expect(tool.schemaDigest).toBe(PINNED_CONTRACT_DIGESTS[tool.id]);
    }
  });
});
