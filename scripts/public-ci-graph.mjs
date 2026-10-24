import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const digest = (text) => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
const compiled = [
  'shared',
  'sdk',
  'mcp-server',
  'agentkit-plugin',
  'eliza-plugin',
  'langchain-plugin',
];
const originalTests = {
  shared: 'pnpm run build && node --test test/*.test.mjs',
  sdk: 'pnpm build && node --test test/*.test.mjs',
  'mcp-server': 'pnpm --filter @agentdomain/sdk build && pnpm build && node --test test/*.test.mjs',
  'agentkit-plugin':
    'pnpm --filter @agentdomain/sdk build && pnpm run build && node --test test/*.test.mjs',
  'eliza-plugin':
    'pnpm --filter @agentdomain/sdk build && pnpm run build && node --test test/*.test.mjs',
  'langchain-plugin':
    'pnpm --filter @agentdomain/sdk build && pnpm run build && node --test test/*.test.mjs',
};
const packages = Object.fromEntries(
  compiled.map((slug) => {
    const lint = ['shared', 'sdk'].includes(slug)
      ? 'echo ok'
      : slug === 'langchain-plugin'
        ? 'tsc --noEmit'
        : 'echo "no lint"';
    const typecheck =
      slug === 'langchain-plugin' ? 'tsc --noEmit && tsc -p tsconfig.test.json' : 'tsc --noEmit';
    return [
      `packages/${slug}`,
      {
        name: `@agentdomain/${slug}`,
        scripts: {
          build: 'tsc',
          lint,
          typecheck,
          test: originalTests[slug],
          'build:ci': 'tsc',
          'lint:ci': lint,
          'typecheck:ci': slug === 'langchain-plugin' ? 'tsc -p tsconfig.test.json' : typecheck,
          'test:ci': 'node --test test/*.test.mjs',
        },
        workspaceDependencies:
          slug === 'shared'
            ? {}
            : slug === 'sdk'
              ? { '@agentdomain/shared': 'workspace:^' }
              : slug === 'langchain-plugin'
                ? { '@agentdomain/sdk': 'workspace:^' }
                : { '@agentdomain/sdk': 'workspace:^', '@agentdomain/shared': 'workspace:^' },
      },
    ];
  }),
);
packages['apps/frontend'] = {
  name: '@agentdomain/frontend',
  scripts: {
    assets: 'node scripts/verify-assets.mjs',
    build:
      'pnpm run assets && pnpm run test:isolation && next build && node scripts/check-build.mjs',
    'build:cloudflare':
      'pnpm --filter @agentdomain/shared build && pnpm --filter @agentdomain/sdk build && pnpm run assets && pnpm run test:isolation && opennextjs-cloudflare build && opennextjs-cloudflare populateCache local && node scripts/check-build.mjs && node scripts/check-open-next.mjs',
    'test:isolation': 'node --test test/isolation.test.mjs',
    'test:seo': 'node --test ../../scripts/seo/test/*.test.mjs',
    test: 'pnpm run assets && node --test test/*.test.mjs && tsx --test test/*.test.ts && pnpm run test:seo',
    lint: 'eslint .',
    typecheck: 'pnpm run assets && tsc --noEmit',
    'lint:ci': 'eslint .',
    'typecheck:ci': 'pnpm run assets && tsc --noEmit',
    'test:ci':
      'pnpm run assets && node --test test/*.test.mjs && tsx --test test/*.test.ts && pnpm run test:seo',
  },
  workspaceDependencies: {
    '@agentdomain/sdk': 'workspace:*',
    '@agentdomain/shared': 'workspace:*',
  },
};
packages['apps/docs'] = {
  name: '@agentdomain/docs',
  scripts: {
    'build:dependencies': 'pnpm --filter @agentdomain/shared build',
    build:
      'pnpm run build:dependencies && astro build && node ../../scripts/seo/indexnow.mjs prepare-key --site=docs',
    lint: 'node scripts/validate-content.mjs',
    typecheck: 'pnpm run build:dependencies && astro check',
    test: 'pnpm run build:dependencies && node --test test/*.test.mjs',
    'validate:content': 'node scripts/validate-content.mjs',
    'validate:output': 'pnpm run build:dependencies && node scripts/validate-output.mjs',
    check:
      'pnpm run validate:content && pnpm run typecheck && pnpm run test && pnpm run build && pnpm run validate:output',
    'build:ci': 'astro build && node ../../scripts/seo/indexnow.mjs prepare-key --site=docs',
    'lint:ci': 'node scripts/validate-content.mjs',
    'typecheck:ci': 'astro check',
    'test:ci': 'node --test test/*.test.mjs',
    'validate:output:ci': 'node scripts/validate-output.mjs',
  },
  workspaceDependencies: { '@agentdomain/shared': 'workspace:*' },
};

// These are reviewed source inputs, never prior build/test receipts.
const configHashes = {
  'turbo.json': '9f279fde674c92c099aa1cb74be773f150abe73b660f66fee188ecf846a33298',
  'pnpm-workspace.yaml': '1b57bbcadad5a4179fcfe1aa68a98f8cd64cf92d5317f77fe751098eb231c44e',
  'pnpm-lock.yaml': '57067b8369e2846551e3231649949e2ba9fdeeaf3bb24edf4a20446f92ec7b1e',
  'tsconfig.base.json': 'b21bc7c97e0995f7e6425d13ae56418504c299cdebd079c7f806c7af80ed7e6d',
  'contracts/package.json': '8da7137af5286fd6d55c8ef3c27b669d422b626fb97a67a7a2a1dfd722a5c317',
  'packages/shared/tsconfig.json':
    'ea2eabdb1a802e13cda74c7734a313184099a233f4f88c1346108d2428a4cab0',
  'packages/sdk/tsconfig.json': 'ea2eabdb1a802e13cda74c7734a313184099a233f4f88c1346108d2428a4cab0',
  'packages/mcp-server/tsconfig.json':
    '822c4f3f275aed4aebdd1ec0d2cea0bde5e5696bcdd1c7c5afc84e54e2d434e6',
  'packages/agentkit-plugin/tsconfig.json':
    '91fbec1f83cfe6c0d545ab09a1ed54c29d9af540afc6b19fe2ceb1562bf47bd6',
  'packages/eliza-plugin/tsconfig.json':
    '91fbec1f83cfe6c0d545ab09a1ed54c29d9af540afc6b19fe2ceb1562bf47bd6',
  'packages/langchain-plugin/tsconfig.json':
    '91fbec1f83cfe6c0d545ab09a1ed54c29d9af540afc6b19fe2ceb1562bf47bd6',
  'packages/langchain-plugin/tsconfig.test.json':
    '04928df7080cce83cc9166e2234481c9a4953e5784010a67492fae2a6a96aedb',
  'apps/frontend/tsconfig.json': '700f06efb82b73994aa00ef7cbb46487634295ad162090024a38eb7a5d2949f7',
  'apps/docs/tsconfig.json': '974b0a3b37e52f3649d9df63e72e374794e9e797c8ae61eca4812f844406f7ef',
  'apps/docs/astro.config.mjs': '8dc559240b0432fd7cad6600152f432e16ea166433a6964802a8591da98cd007',
  'apps/frontend/open-next.config.ts':
    'cf6283a9d48c90a5c8288a8993b4c6e2b202ed0deff427209ab5d1b8e6b4453b',
  'apps/frontend/next.config.mjs':
    'cab76ea7fdf3f08c0185f6241b497e4bbf19ccaf449f6ca110e84ce5ac738333',
  'apps/frontend/wrangler.jsonc':
    'bb4e7e423b22105448bb5053bbb5ae54fe434a084831b3b217bd2c2a5504e0af',
  'scripts/cloudflare-checks.mjs':
    '1301211fa0712845cf3d311e7106c46a2fba426b5330d01e6b318fc421831e56',
};
const rootScripts = {
  'check:public-boundary': 'node scripts/check-public-boundary.mjs',
  'check:production-licenses': 'node scripts/check-production-licenses.mjs',
  'format:check': 'prettier --check "**/*.{js,mjs,cjs,ts,tsx,md,mdx,json,yml,yaml}"',
  'ci:public': 'node scripts/public-ci.mjs',
  'ci:cloudflare': 'node scripts/public-ci.mjs --cloudflare-only',
  'lint:public': 'turbo run lint --filter=!@agentdomain/contracts',
  'typecheck:public': 'turbo run typecheck --filter=!@agentdomain/contracts',
  'test:dependency-security':
    'node --test scripts/http-cache-semantics.test.mjs scripts/braces.test.mjs scripts/production-dependencies.test.mjs scripts/reown-zod-override.test.mjs',
  'test:license-gate': 'node --test scripts/check-production-licenses.test.mjs',
  'test:public':
    'pnpm test:dependency-security && node --test scripts/check-public-boundary.test.mjs scripts/verify-release-ci.test.mjs scripts/public-ci.test.mjs scripts/public-pr-scope.test.mjs && pnpm test:license-gate && pnpm --filter @agentdomain/contracts test && turbo run test --filter=!@agentdomain/contracts',
  'build:public': 'turbo run build --filter=!@agentdomain/contracts',
};
const workspaceDirectories = [...Object.keys(packages), 'contracts'].sort();
const graphArgs = [
  'exec',
  'turbo',
  'run',
  'lint:ci',
  'typecheck:ci',
  'test:ci',
  'build:ci',
  '--filter=!@agentdomain/contracts',
  '--cache=local:w',
];
const rootTests = [
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
];
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const PUBLIC_CI_GRAPH_CONTRACT = freeze({
  packages,
  configHashes,
  rootScripts,
  workspaceDirectories,
  graphArgs,
  rootTests,
});

export function reviewedCiTurboSource(source) {
  return typeof source === 'string' && digest(source) === configHashes['turbo.json'];
}

function exactScripts(actual, expected) {
  return (
    actual &&
    Object.entries(expected).every(
      ([task, command]) =>
        actual[task] === command &&
        !Object.hasOwn(actual, `pre${task}`) &&
        !Object.hasOwn(actual, `post${task}`),
    )
  );
}

export function qualifiesPublicCiGraph(profile) {
  try {
    if (
      profile.hasOverrides !== false ||
      !isDeepStrictEqual(profile.configHashes, configHashes) ||
      !isDeepStrictEqual(profile.workspaceDirectories, workspaceDirectories) ||
      profile.turboVersion !== '2.10.12' ||
      profile.typescriptVersion !== '5.9.3' ||
      profile.manifest.name !== 'agentdomain-public' ||
      profile.manifest.packageManager !== 'pnpm@10.33.2' ||
      !exactScripts(profile.manifest.scripts, rootScripts) ||
      !isDeepStrictEqual(Object.keys(profile.packages).sort(), Object.keys(packages).sort())
    )
      return false;
    return Object.entries(packages).every(([directory, expected]) => {
      const actual = profile.packages[directory];
      const entries = [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]
        .flatMap((key) => Object.entries(actual[key] ?? {}))
        .filter(([name]) => name.startsWith('@agentdomain/'));
      if (new Set(entries.map(([name]) => name)).size !== entries.length) return false;
      const edges = Object.fromEntries(entries);
      return (
        actual.name === expected.name &&
        exactScripts(actual.scripts, expected.scripts) &&
        isDeepStrictEqual(edges, expected.workspaceDependencies) &&
        isDeepStrictEqual(
          Object.keys(actual.scripts)
            .filter((task) => task.endsWith(':ci'))
            .sort(),
          Object.keys(expected.scripts)
            .filter((task) => task.endsWith(':ci'))
            .sort(),
        )
      );
    });
  } catch {
    return false;
  }
}

export function inspectPublicCiGraph({ directory = root } = {}) {
  try {
    directory = resolve(directory);
    const inputs = new Map();
    const regular = (path) => {
      const absolute = resolve(directory, path);
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if (!path.startsWith('node_modules/'))
        for (let parent = dirname(absolute); ; parent = dirname(parent)) {
          const ancestor = lstatSync(parent);
          if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) return false;
          if (parent === directory) break;
        }
      return true;
    };
    const read = (path) => {
      const absolute = resolve(directory, path);
      if (!regular(path)) throw new Error('PUBLIC_CI_GRAPH_INPUT');
      const bytes = readFileSync(absolute);
      inputs.set(path, bytes);
      return bytes.toString('utf8');
    };
    const workspaceInventory = () =>
      [
        ...['apps', 'packages'].flatMap((base) =>
          readdirSync(resolve(directory, base))
            .filter((name) => existsSync(resolve(directory, base, name, 'package.json')))
            .map((name) => `${base}/${name}`),
        ),
        ...(existsSync(resolve(directory, 'contracts/package.json')) ? ['contracts'] : []),
      ].sort();
    const overrides = () =>
      [
        'turbo.jsonc',
        ...Object.keys(packages).flatMap((path) => [`${path}/turbo.json`, `${path}/turbo.jsonc`]),
        'apps/frontend/next.config.js',
        'apps/frontend/next.config.ts',
        'apps/frontend/open-next.config.js',
        'apps/frontend/open-next.config.mjs',
        'apps/frontend/wrangler.toml',
        'apps/frontend/wrangler.json',
      ].some((path) => existsSync(resolve(directory, path)));
    const profile = {
      manifest: JSON.parse(read('package.json')),
      packages: Object.fromEntries(
        Object.keys(packages).map((path) => [path, JSON.parse(read(`${path}/package.json`))]),
      ),
      configHashes: Object.fromEntries(
        Object.keys(configHashes).map((path) => [path, digest(read(path))]),
      ),
      workspaceDirectories: workspaceInventory(),
      hasOverrides: overrides(),
      turboVersion: JSON.parse(read('node_modules/turbo/package.json')).version,
      typescriptVersion: JSON.parse(read('node_modules/typescript/package.json')).version,
    };
    if (!qualifiesPublicCiGraph(profile)) return null;
    read('scripts/public-ci.mjs');
    read('scripts/public-ci-graph.mjs');
    read('apps/frontend/test/isolation.test.mjs');
    return {
      args: [...graphArgs],
      rootTests: rootTests.map((args) => [...args]),
      docsValidation: ['--filter', '@agentdomain/docs', 'validate:output:ci'],
      assertUnchanged() {
        try {
          if (
            overrides() ||
            !isDeepStrictEqual(workspaceInventory(), workspaceDirectories) ||
            [...inputs].some(([path, bytes]) => {
              const absolute = resolve(directory, path);
              return !regular(path) || !readFileSync(absolute).equals(bytes);
            })
          )
            throw new Error('PUBLIC_CI_GRAPH_SOURCE_CHANGED');
        } catch {
          throw new Error('PUBLIC_CI_GRAPH_SOURCE_CHANGED');
        }
      },
    };
  } catch {
    return null;
  }
}
