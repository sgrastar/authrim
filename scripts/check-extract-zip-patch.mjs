import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const extract = require(process.argv[2] || 'extract-zip');
const fixtures = {
  malicious:
    'UEsDBBQAAAAAAAAAIQDGnafXDgAAAA4AAAAGAAAAdmljdGltLi4vb3V0c2lkZS50eHRQSwMEFAAAAAAAAAAhAIqVXNgLAAAACwAAAAYAAAB2aWN0aW1PVkVSV1JJVFRFTlBLAQIUAxQAAAAAAAAAIQDGnafXDgAAAA4AAAAGAAAAAAAAAAAAAAD/oQAAAAB2aWN0aW1QSwECFAMUAAAAAAAAACEAipVc2AsAAAALAAAABgAAAAAAAAAAAAAApIEyAAAAdmljdGltUEsFBgAAAAACAAIAaAAAAGEAAAAAAA==',
  ordinary:
    'UEsDBBQAAAAAAAAAIQCGphA2BQAAAAUAAAAGAAAAdmljdGltaGVsbG9QSwECFAMUAAAAAAAAACEAhqYQNgUAAAAFAAAABgAAAAAAAAAAAAAApIEAAAAAdmljdGltUEsFBgAAAAABAAEANAAAACkAAAAAAA==',
  internal:
    'UEsDBBQAAAAAAAAAIQCGphA2BQAAAAUAAAAGAAAAdGFyZ2V0aGVsbG9QSwMEFAAAAAAAAAAhAPwvb0YGAAAABgAAAAQAAABsaW5rdGFyZ2V0UEsBAhQDFAAAAAAAAAAhAIamEDYFAAAABQAAAAYAAAAAAAAAAAAAAKSBAAAAAHRhcmdldFBLAQIUAxQAAAAAAAAAIQD8L29GBgAAAAYAAAAEAAAAAAAAAAAAAAD/oSkAAABsaW5rUEsFBgAAAAACAAIAZgAAAFEAAAAAAA==',
};
const root = await mkdtemp(join(tmpdir(), 'authrim-extract-zip-'));
try {
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'UNCHANGED');
  for (const [name, data] of Object.entries(fixtures)) {
    await writeFile(join(root, `${name}.zip`), Buffer.from(data, 'base64'));
  }
  await assert.rejects(extract(join(root, 'malicious.zip'), { dir: join(root, 'malicious') }));
  assert.equal(await readFile(outside, 'utf8'), 'UNCHANGED');
  const planted = join(root, 'planted');
  await mkdir(planted);
  await symlink(outside, join(planted, 'victim'));
  await assert.rejects(extract(join(root, 'ordinary.zip'), { dir: planted }));
  assert.equal(await readFile(outside, 'utf8'), 'UNCHANGED');
  await extract(join(root, 'ordinary.zip'), { dir: join(root, 'ordinary') });
  assert.equal(await readFile(join(root, 'ordinary', 'victim'), 'utf8'), 'hello');
  await extract(join(root, 'internal.zip'), { dir: join(root, 'internal') });
  assert.equal(await readFile(join(root, 'internal', 'link'), 'utf8'), 'hello');
  console.log('extract-zip patch regression checks passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
