#!/usr/bin/env node
// Cross-runner postinstall. Previous implementation was
// `patch-package && bun bootstrap`, which required Bun to be on PATH
// even when a contributor ran `npm install` or `pnpm install`. Detect
// the installer from npm_config_user_agent and pick the right command
// to invoke `lerna bootstrap` underneath. Bun remains the recommended
// toolchain for contributors — `bun install` still picks the fast
// path — but `npm install` / `pnpm install` no longer fail at the
// postinstall step.
//
// Keep this file short and dependency-free: postinstall runs with
// node_modules/.bin on PATH but cannot assume any globals beyond Node
// itself and the just-installed devDependencies.

import { execSync } from 'node:child_process';

function run(cmd, label) {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[oxmysql postinstall] ${label} failed`);
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
}

// Apply local patches first (named-placeholders etc.). patch-package is
// installed as @milahu/patch-package but exposes the `patch-package`
// binary through node_modules/.bin, which is on PATH during postinstall
// for every mainstream installer.
run('patch-package', 'patch-package');

// Pick the bootstrap runner. Bun's user agent starts with `bun/…`;
// every other installer (npm, pnpm, yarn classic, yarn berry) goes
// through the Node path via npx.
const userAgent = process.env.npm_config_user_agent || '';
const installer = userAgent.split('/', 1)[0] || '';
const isBun = installer === 'bun';

if (isBun) {
  run('bun run bootstrap', 'bun run bootstrap');
} else {
  // `lerna` is a devDependency so it is on node_modules/.bin. On every
  // mainstream installer that directory is added to PATH for scripts.
  // Invoke it directly rather than going through `npx` so we do not
  // need the network or a cached fetch layer.
  run('lerna bootstrap', 'lerna bootstrap');
}
