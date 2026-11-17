#!/usr/bin/env node
// `npm run typecheck`: type-check the project with tsrs (the Rust port of
// TypeScript 7). `npm run typecheck:tsc` runs tsc instead.
// Where no tsrs binary is installed for the platform, this falls back to tsc.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tsrsDir = path.dirname(require.resolve('tsrs/package.json'));

const hasTsrsBinary = () => {
  if (process.env.TSRS_BINARY) return true;
  const { optionalDependencies = {} } = require('tsrs/package.json');
  return Object.keys(optionalDependencies).some((name) => {
    try {
      require.resolve(`${name}/package.json`, { paths: [tsrsDir] });
      return true;
    } catch {
      return false;
    }
  });
};

let launcher = [path.join(tsrsDir, 'bin/tsrs')];
if (!hasTsrsBinary()) {
  // eslint-disable-next-line no-console -- CLI script output
  console.warn(
    `typecheck: no tsrs binary for ${process.platform}-${process.arch}, using tsc`
  );
  // tsc needs ~2.4 GB, over Node's default heap.
  launcher = [
    '--max-old-space-size=4096',
    require.resolve('typescript/bin/tsc'),
  ];
}
const flags = process.argv.slice(2).filter((arg) => !/\.[cm]?tsx?$/.test(arg));

const { error, status } = spawnSync(
  process.execPath,
  [...launcher, '-p', 'tsconfig.json', '--noEmit', ...flags],
  { stdio: 'inherit' }
);
if (error) throw error;
process.exit(status ?? 1);
