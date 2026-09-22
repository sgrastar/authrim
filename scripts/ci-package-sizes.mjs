#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const UI_PACKAGES = new Set(['@authrim/ar-admin-ui', '@authrim/ar-login-ui']);

async function measureDirectory(directory) {
  const totals = { uncompressedBytes: 0, gzipBytes: 0 };
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (
      ['__tests__', 'node_modules', '.wrangler'].includes(entry.name) ||
      /(?:\.map|\.d\.[cm]?ts|\.tsbuildinfo)$/.test(entry.name) ||
      /\.(?:test|spec)\.[cm]?jsx?$/.test(entry.name)
    )
      continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await measureDirectory(filePath);
      totals.uncompressedBytes += nested.uncompressedBytes;
      totals.gzipBytes += nested.gzipBytes;
    } else if (entry.isFile()) {
      const content = await fs.readFile(filePath);
      totals.uncompressedBytes += content.length;
      totals.gzipBytes += gzipSync(content).length;
    }
  }
  return totals;
}

export async function collectPackageSizes(repoRoot) {
  const packages = [];
  const totals = { uncompressedBytes: 0, gzipBytes: 0 };
  const packagesRoot = path.join(repoRoot, 'packages');
  for (const entry of (await fs.readdir(packagesRoot, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (!entry.isDirectory()) continue;
    const packageDir = path.join(packagesRoot, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const name = manifest.name ?? entry.name;
    const output = UI_PACKAGES.has(name) ? '.svelte-kit/cloudflare' : 'dist';
    // Missing build output must fail CI rather than silently report a partial total.
    const sizes = await measureDirectory(path.join(packageDir, output));
    packages.push({ name, ...sizes });
    totals.uncompressedBytes += sizes.uncompressedBytes;
    totals.gzipBytes += sizes.gzipBytes;
  }
  return { packages, totals };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error('Usage: node scripts/ci-package-sizes.mjs <output.json>');
  const report = await collectPackageSizes(process.cwd());
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report)}\n`);
}
