import { fileURLToPath } from 'node:url';
import { packageServingArtifact, parseServingPackageArguments } from './package-serving.mjs';

const receipt = await packageServingArtifact({
  entry: 'browser-sp',
  outputDirectory: fileURLToPath(new URL('../dist/', import.meta.url)),
  ...parseServingPackageArguments(process.argv.slice(2)),
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);
