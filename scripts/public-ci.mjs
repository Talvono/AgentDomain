import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCloudflareChecks } from './cloudflare-checks.mjs';
import { inspectPublicPrScope } from './public-pr-scope.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export function publicLintArgs(manifest, langchain) {
  const duplicatesTypecheck =
    manifest.scripts?.['lint:public'] === 'turbo run lint --filter=!@agentdomain/contracts' &&
    manifest.scripts?.['typecheck:public'] ===
      'turbo run typecheck --filter=!@agentdomain/contracts' &&
    langchain.name === '@agentdomain/langchain-plugin' &&
    langchain.scripts?.lint === 'tsc --noEmit' &&
    langchain.scripts?.typecheck === 'tsc --noEmit && tsc -p tsconfig.test.json' &&
    ['prelint', 'postlint', 'pretypecheck', 'posttypecheck'].every(
      (task) => !Object.hasOwn(langchain.scripts, task),
    );
  // The unchanged typecheck runs the identical compiler command later in this invocation.
  return duplicatesTypecheck
    ? ['lint:public', '--filter=!@agentdomain/langchain-plugin']
    : ['lint:public'];
}

const rootBuildScripts = {
  build: 'turbo run build',
  'build:public': 'turbo run build --filter=!@agentdomain/contracts',
  'ci:public': 'node scripts/public-ci.mjs',
  'ci:cloudflare': 'node scripts/public-ci.mjs --cloudflare-only',
};
const frontendBuildScripts = {
  assets: 'node scripts/verify-assets.mjs',
  'test:isolation': 'node --test test/isolation.test.mjs',
  build: 'pnpm run assets && pnpm run test:isolation && next build && node scripts/check-build.mjs',
  'build:cloudflare':
    'pnpm --filter @agentdomain/shared build && pnpm --filter @agentdomain/sdk build && pnpm run assets && pnpm run test:isolation && opennextjs-cloudflare build && opennextjs-cloudflare populateCache local && node scripts/check-build.mjs && node scripts/check-open-next.mjs',
};
// Source allowlists, not build receipts: config changes require requalifying deferral.
const buildConfigHashes = {
  'apps/frontend/open-next.config.ts':
    'cf6283a9d48c90a5c8288a8993b4c6e2b202ed0deff427209ab5d1b8e6b4453b',
  'apps/frontend/next.config.mjs':
    'cab76ea7fdf3f08c0185f6241b497e4bbf19ccaf449f6ca110e84ce5ac738333',
  'apps/frontend/wrangler.jsonc':
    'bb4e7e423b22105448bb5053bbb5ae54fe434a084831b3b217bd2c2a5504e0af',
  'scripts/cloudflare-checks.mjs':
    '1301211fa0712845cf3d311e7106c46a2fba426b5330d01e6b318fc421831e56',
  'turbo.json': '6d8184df7ec7d5c3d4dda53d1c94f13f8121c4270beb70fe613a4b77d73b501c',
};

function matchesBuildScripts(manifest, expected) {
  return Object.entries(expected).every(
    ([task, command]) =>
      manifest?.scripts?.[task] === command &&
      !Object.hasOwn(manifest.scripts, `pre${task}`) &&
      !Object.hasOwn(manifest.scripts, `post${task}`),
  );
}

export function publicBuildArgs(manifest, frontend, config) {
  const duplicatesCloudflareBuild =
    !process.env.SKIP_NEXT_APP_BUILD &&
    manifest?.name === 'agentdomain-public' &&
    matchesBuildScripts(manifest, rootBuildScripts) &&
    frontend?.name === '@agentdomain/frontend' &&
    matchesBuildScripts(frontend, frontendBuildScripts) &&
    frontend.devDependencies?.['@opennextjs/cloudflare'] === '1.20.10' &&
    frontend.devDependencies?.wrangler === '4.148.0' &&
    frontend.dependencies?.next === '16.3.8' &&
    config?.adapter?.name === '@opennextjs/cloudflare' &&
    config.adapter.version === '1.20.10' &&
    config.adapter.dependencies?.['@opennextjs/aws'] === '4.1.9' &&
    config.adapterBuild?.name === '@opennextjs/aws' &&
    config.adapterBuild.version === '4.1.9' &&
    config?.hasOverrides === false &&
    Object.entries(buildConfigHashes).every(
      ([path, hash]) =>
        typeof config.sources?.[path] === 'string' &&
        createHash('sha256').update(config.sources[path].replaceAll('\r\n', '\n')).digest('hex') ===
          hash,
    );
  // The unchanged OpenNext adapter runs the complete frontend build later in this invocation.
  return duplicatesCloudflareBuild
    ? ['build:public', '--filter=!@agentdomain/frontend']
    : ['build:public'];
}

function currentPublicBuildArgs() {
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const frontend = JSON.parse(readFileSync(resolve(root, 'apps/frontend/package.json'), 'utf8'));
    const adapter = JSON.parse(
      readFileSync(
        resolve(root, 'apps/frontend/node_modules/@opennextjs/cloudflare/package.json'),
        'utf8',
      ),
    );
    const adapterEntry = createRequire(resolve(root, 'apps/frontend/package.json')).resolve(
      '@opennextjs/cloudflare',
    );
    const adapterBuildEntry = createRequire(adapterEntry).resolve(
      '@opennextjs/aws/build/buildNextApp.js',
    );
    const adapterBuild = JSON.parse(
      readFileSync(resolve(dirname(adapterBuildEntry), '../../package.json'), 'utf8'),
    );
    const sources = Object.fromEntries(
      Object.keys(buildConfigHashes).map((path) => [
        path,
        readFileSync(resolve(root, path), 'utf8'),
      ]),
    );
    const hasOverrides = [
      'turbo.jsonc',
      'apps/frontend/turbo.json',
      'apps/frontend/turbo.jsonc',
      'apps/frontend/next.config.js',
      'apps/frontend/next.config.ts',
      'apps/frontend/open-next.config.js',
      'apps/frontend/open-next.config.mjs',
      'apps/frontend/wrangler.toml',
      'apps/frontend/wrangler.json',
    ].some((path) => existsSync(resolve(root, path)));
    return publicBuildArgs(manifest, frontend, { sources, hasOverrides, adapter, adapterBuild });
  } catch {
    return ['build:public'];
  }
}

function runPnpm(args) {
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error('Run public CI through pnpm.');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`pnpm ${args.join(' ')} failed`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

function assertNextBuildEnabled() {
  if (process.env.SKIP_NEXT_APP_BUILD)
    throw new Error('SKIP_NEXT_APP_BUILD must be unset or empty for Cloudflare CI.');
}

function runFrontendAfterDependencies(run) {
  if (!currentPublicBuildArgs().includes('--filter=!@agentdomain/frontend')) {
    run(['--filter', '@agentdomain/frontend', 'build:cloudflare']);
    return;
  }
  // Only reached after this invocation's dependency builds succeeded. The same
  // exact script/config guard used for Next deferral protects the unchanged tail.
  for (const args of [
    ['run', 'assets'],
    ['run', 'test:isolation'],
    ['exec', 'opennextjs-cloudflare', 'build'],
    ['exec', 'opennextjs-cloudflare', 'populateCache', 'local'],
    ['exec', 'node', 'scripts/check-build.mjs'],
    ['exec', 'node', 'scripts/check-open-next.mjs'],
  ])
    run(['--filter', '@agentdomain/frontend', ...args]);
}

export function runPublicCi(run = runPnpm, { cloudflare = false } = {}) {
  if (cloudflare) assertNextBuildEnabled();
  for (const args of [
    ['check:public-boundary'],
    ['check:production-licenses'],
    ['audit', '--prod', '--audit-level', 'high'],
    ['format:check'],
    ['lint:public'],
    ['typecheck:public'],
    ['test:public'],
    ['build:public'],
  ]) {
    if (args[0] === 'lint:public') {
      const manifest = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      );
      const langchain = JSON.parse(
        readFileSync(new URL('../packages/langchain-plugin/package.json', import.meta.url), 'utf8'),
      );
      run(publicLintArgs(manifest, langchain));
    } else if (cloudflare && args[0] === 'build:public') {
      run(currentPublicBuildArgs());
    } else {
      run(args);
    }
  }
  if (cloudflare) {
    // Reuse only the docs lint, typecheck, tests and build completed in this invocation.
    runCloudflareChecks(
      (args) => {
        if (args.join(' ') === '--filter @agentdomain/frontend build:cloudflare')
          runFrontendAfterDependencies(run);
        else run(args);
      },
      () => run(['--filter', '@agentdomain/docs', 'validate:output']),
    );
  }
}

export function runPublicPrCi(run = runPnpm, inspect = inspectPublicPrScope) {
  assertNextBuildEnabled();
  const proof = inspect();
  const scope = proof.scope;
  if (!['docs', 'frontend'].includes(scope)) {
    runPublicCi(run, { cloudflare: true });
    return 'full';
  }
  for (const args of [
    ['check:public-boundary'],
    ['check:production-licenses'],
    ['audit', '--prod', '--audit-level', 'high'],
    ['format:check'],
    ['test:dependency-security'],
    [
      'exec',
      'node',
      '--test',
      'scripts/check-public-boundary.test.mjs',
      'scripts/verify-release-ci.test.mjs',
      'scripts/public-ci.test.mjs',
      'scripts/public-pr-scope.test.mjs',
    ],
    ['test:license-gate'],
    ['--filter', '@agentdomain/contracts', 'test'],
  ])
    run(args);
  // Reinspect after guards; changing source/context must not leave a reduced success.
  if (inspect().scope !== scope) throw new Error('PUBLIC_PR_SCOPE_CHANGED');
  if (scope === 'docs') {
    run(['--filter', '@agentdomain/docs', 'check']);
  } else {
    // Turbo supplies only this workload's build dependency closure, not path authority.
    run([
      'exec',
      'turbo',
      'run',
      'lint',
      'typecheck',
      'test',
      '--filter=@agentdomain/frontend...',
      '--force',
    ]);
    runFrontendAfterDependencies(run);
    // Docs source-contract tests include consumers not represented by workspace edges.
    run(['--filter', '@agentdomain/docs', 'test']);
  }
  const workspace = scope === 'docs' ? '@agentdomain/docs' : '@agentdomain/frontend';
  for (const environment of [['--env='], ['--env', 'preview']]) {
    run(['--filter', workspace, 'exec', 'wrangler', 'deploy', '--dry-run', ...environment]);
  }
  proof.assertSource();
  return scope;
}

export function runCi(args, run = runPnpm) {
  if (args.length === 0) return runPublicCi(run);
  if (args.length === 1 && args[0] === '--cloudflare')
    return runPublicCi(run, { cloudflare: true });
  if (args.length === 1 && args[0] === '--cloudflare-only') {
    assertNextBuildEnabled();
    return runCloudflareChecks(run);
  }
  if (args.length === 2 && args[0] === '--pull-request' && args[1] === '--cloudflare')
    return runPublicPrCi(run);
  if (args.length === 2 && args[0] === '--affected' && args[1] === '--cloudflare')
    return runPublicPrCi(run);
  throw new Error('Usage: pnpm ci:public [--cloudflare] or pnpm ci:cloudflare');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const scope = runCi(process.argv.slice(2));
    if (typeof scope === 'string' && process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
