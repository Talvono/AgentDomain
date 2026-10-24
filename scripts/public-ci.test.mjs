import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { publicBuildArgs, publicLintArgs, runCi, runPublicCi } from './public-ci.mjs';
import { PUBLIC_CI_GRAPH_CONTRACT, inspectPublicCiGraph } from './public-ci-graph.mjs';
import './public-ci-graph.test.mjs';
import './public-ci-task-graph.test.mjs';

const publicSteps = [
  ['check:public-boundary'],
  ['check:production-licenses'],
  ['audit', '--prod', '--audit-level', 'high'],
  ['format:check'],
  ['lint:public', '--filter=!@agentdomain/langchain-plugin'],
  ['typecheck:public'],
  ['test:public'],
  ['build:public'],
];
const combinedPublicSteps = [
  ...publicSteps.slice(0, -1),
  ['build:public', '--filter=!@agentdomain/frontend'],
];
const fullGraphSteps = [
  ...publicSteps.slice(0, 4),
  ...PUBLIC_CI_GRAPH_CONTRACT.rootTests,
  PUBLIC_CI_GRAPH_CONTRACT.graphArgs,
];
const buildManifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const frontendBuildManifest = JSON.parse(
  await readFile(new URL('../apps/frontend/package.json', import.meta.url), 'utf8'),
);
const buildConfig = {
  sources: {},
  hasOverrides: false,
  adapter: {
    name: '@opennextjs/cloudflare',
    version: '1.20.12',
    dependencies: { '@opennextjs/aws': '4.1.11' },
  },
  adapterBuild: { name: '@opennextjs/aws', version: '4.1.11' },
};
for (const path of [
  'apps/frontend/open-next.config.ts',
  'apps/frontend/next.config.mjs',
  'apps/frontend/wrangler.jsonc',
  'scripts/cloudflare-checks.mjs',
  'turbo.json',
]) {
  buildConfig.sources[path] = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}
const dryRuns = (workspace) =>
  [['--env='], ['--env', 'preview']].map((environment) => [
    '--filter',
    workspace,
    'exec',
    'wrangler',
    'deploy',
    '--dry-run',
    ...environment,
  ]);
const cloudflareSteps = (docsCommand) => [
  ...(['validate:output', 'validate:output:ci'].includes(docsCommand)
    ? [
        ...(docsCommand === 'validate:output'
          ? [
              ['--filter', '@agentdomain/frontend', 'run', 'assets'],
              ['--filter', '@agentdomain/frontend', 'run', 'test:isolation'],
            ]
          : []),
        ['--filter', '@agentdomain/frontend', 'exec', 'opennextjs-cloudflare', 'build'],
        [
          '--filter',
          '@agentdomain/frontend',
          'exec',
          'opennextjs-cloudflare',
          'populateCache',
          'local',
        ],
        ['--filter', '@agentdomain/frontend', 'exec', 'node', 'scripts/check-build.mjs'],
        ['--filter', '@agentdomain/frontend', 'exec', 'node', 'scripts/check-open-next.mjs'],
      ]
    : [['--filter', '@agentdomain/frontend', 'build:cloudflare']]),
  ...dryRuns('@agentdomain/frontend'),
  ['--filter', '@agentdomain/docs', docsCommand],
  ...dryRuns('@agentdomain/docs'),
];

function capture(args) {
  const commands = [];
  runCi(args, (command) => commands.push(command));
  return commands;
}

function withNextBuildOverride(value, run) {
  const original = process.env.SKIP_NEXT_APP_BUILD;
  try {
    if (value === undefined) delete process.env.SKIP_NEXT_APP_BUILD;
    else process.env.SKIP_NEXT_APP_BUILD = value;
    return run();
  } finally {
    if (original === undefined) delete process.env.SKIP_NEXT_APP_BUILD;
    else process.env.SKIP_NEXT_APP_BUILD = original;
  }
}

test('public CI retains every source gate and audits without repeating security tests', () => {
  assert.deepEqual(capture([]), publicSteps);
});

const lintManifest = {
  scripts: {
    'lint:public': 'turbo run lint --filter=!@agentdomain/contracts',
    'typecheck:public': 'turbo run typecheck --filter=!@agentdomain/contracts',
  },
};
const langchainManifest = {
  name: '@agentdomain/langchain-plugin',
  scripts: { lint: 'tsc --noEmit', typecheck: 'tsc --noEmit && tsc -p tsconfig.test.json' },
};

test('only the exact duplicated LangChain compiler command can be deferred to typecheck', () => {
  assert.deepEqual(publicLintArgs(lintManifest, langchainManifest), publicSteps[4]);
  for (const [task, command] of [
    ['lint', 'eslint .'],
    ['lint', 'tsc --noEmit && node extra-lint.mjs'],
    ['typecheck', 'tsc -p tsconfig.test.json'],
    ['typecheck', 'tsc --noEmit || tsc -p tsconfig.test.json'],
    ['typecheck', 'tsc --noEmit --project other.json && tsc -p tsconfig.test.json'],
    ...['prelint', 'postlint', 'pretypecheck', 'posttypecheck'].map((task) => [
      task,
      'node hook.mjs',
    ]),
  ]) {
    assert.deepEqual(
      publicLintArgs(lintManifest, {
        ...langchainManifest,
        scripts: { ...langchainManifest.scripts, [task]: command },
      }),
      ['lint:public'],
      `${task} drift must restore the complete lint gate`,
    );
  }
  for (const task of ['lint:public', 'typecheck:public']) {
    assert.deepEqual(
      publicLintArgs(
        { scripts: { ...lintManifest.scripts, [task]: `pnpm --filter @agentdomain/docs ${task}` } },
        langchainManifest,
      ),
      ['lint:public'],
    );
  }
  for (const changed of [{}, { name: '@agentdomain/docs', scripts: langchainManifest.scripts }]) {
    assert.deepEqual(publicLintArgs(lintManifest, changed), ['lint:public']);
  }
  assert.deepEqual(publicLintArgs({}, langchainManifest), ['lint:public']);
});

test('only the audited complete OpenNext build can replace the earlier frontend build', () => {
  assert.deepEqual(
    publicBuildArgs(buildManifest, frontendBuildManifest, buildConfig),
    combinedPublicSteps.at(-1),
  );
  const crlfSources = Object.fromEntries(
    Object.entries(buildConfig.sources).map(([path, source]) => [
      path,
      source.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'),
    ]),
  );
  assert.deepEqual(
    publicBuildArgs(buildManifest, frontendBuildManifest, { ...buildConfig, sources: crlfSources }),
    combinedPublicSteps.at(-1),
  );
});

test('root command or lifecycle drift restores the complete earlier build', () => {
  for (const task of ['build', 'build:public', 'ci:public', 'ci:cloudflare']) {
    for (const [name, command] of [
      [task, `${buildManifest.scripts[task]} && node extra.mjs`],
      [task, undefined],
      [`pre${task}`, ''],
      [`post${task}`, 'node hook.mjs'],
    ]) {
      assert.deepEqual(
        publicBuildArgs(
          { ...buildManifest, scripts: { ...buildManifest.scripts, [name]: command } },
          frontendBuildManifest,
          buildConfig,
        ),
        ['build:public'],
        `${name} drift must disable deferral`,
      );
    }
  }
});

test('frontend command or lifecycle drift restores the complete earlier build', () => {
  for (const task of ['assets', 'test:isolation', 'build', 'build:cloudflare']) {
    for (const [name, command] of [
      [task, `${frontendBuildManifest.scripts[task]} && node extra.mjs`],
      [task, undefined],
      [`pre${task}`, 'node hook.mjs'],
      [`post${task}`, ''],
    ]) {
      assert.deepEqual(
        publicBuildArgs(
          buildManifest,
          {
            ...frontendBuildManifest,
            scripts: { ...frontendBuildManifest.scripts, [name]: command },
          },
          buildConfig,
        ),
        ['build:public'],
        `${name} drift must disable deferral`,
      );
    }
  }
  for (const command of [
    'next build',
    frontendBuildManifest.scripts['build:cloudflare'].replace(
      ' populateCache local',
      ' populateCache remote',
    ),
    frontendBuildManifest.scripts['build:cloudflare'].replace(
      'opennextjs-cloudflare build',
      'opennextjs-cloudflare build --skipNextBuild',
    ),
  ]) {
    assert.deepEqual(
      publicBuildArgs(
        buildManifest,
        {
          ...frontendBuildManifest,
          scripts: { ...frontendBuildManifest.scripts, 'build:cloudflare': command },
        },
        buildConfig,
      ),
      ['build:public'],
    );
  }
});

test('identity and pinned adapter or compiler drift restore the complete earlier build', () => {
  for (const frontend of [
    {},
    null,
    { ...frontendBuildManifest, name: '@agentdomain/docs' },
    { ...frontendBuildManifest, devDependencies: {} },
    ...['@opennextjs/cloudflare', 'wrangler'].flatMap((name) =>
      [undefined, 'new-version', `^${frontendBuildManifest.devDependencies[name]}`].map(
        (version) => ({
          ...frontendBuildManifest,
          devDependencies: { ...frontendBuildManifest.devDependencies, [name]: version },
        }),
      ),
    ),
    {
      ...frontendBuildManifest,
      dependencies: { ...frontendBuildManifest.dependencies, next: 'new-version' },
    },
  ]) {
    assert.deepEqual(publicBuildArgs(buildManifest, frontend, buildConfig), ['build:public']);
  }
  for (const manifest of [{}, null, { ...buildManifest, name: 'another-workspace' }]) {
    assert.deepEqual(publicBuildArgs(manifest, frontendBuildManifest, buildConfig), [
      'build:public',
    ]);
  }
});

test('config, orchestration or competing config drift restores the complete earlier build', () => {
  for (const [path, source] of Object.entries(buildConfig.sources)) {
    for (const changed of [undefined, `${source}\n// changed build assumptions\n`]) {
      assert.deepEqual(
        publicBuildArgs(buildManifest, frontendBuildManifest, {
          ...buildConfig,
          sources: { ...buildConfig.sources, [path]: changed },
        }),
        ['build:public'],
        `${path} drift must disable deferral`,
      );
    }
  }
  for (const config of [
    undefined,
    {},
    { ...buildConfig, hasOverrides: true },
    { sources: buildConfig.sources },
  ]) {
    assert.deepEqual(publicBuildArgs(buildManifest, frontendBuildManifest, config), [
      'build:public',
    ]);
  }
});

test('installed adapter and transitive build-helper drift restore the complete earlier build', () => {
  for (const [name, manifest] of [
    ['adapter', undefined],
    ['adapter', { ...buildConfig.adapter, name: 'another-adapter' }],
    ['adapter', { ...buildConfig.adapter, version: 'new-version' }],
    ['adapter', { ...buildConfig.adapter, dependencies: { '@opennextjs/aws': 'new-version' } }],
    ['adapterBuild', undefined],
    ['adapterBuild', { ...buildConfig.adapterBuild, name: 'another-build-helper' }],
    ['adapterBuild', { ...buildConfig.adapterBuild, version: 'new-version' }],
  ]) {
    assert.deepEqual(
      publicBuildArgs(buildManifest, frontendBuildManifest, { ...buildConfig, [name]: manifest }),
      ['build:public'],
    );
  }
});

test('combined CI uses one fresh guarded full graph and keeps every Worker dry-run', () => {
  assert.deepEqual(capture(['--cloudflare']), [
    ...fullGraphSteps,
    ...cloudflareSteps('validate:output:ci'),
  ]);
});

test('an unknown graph profile restores the original full sequence, never a reduced success', () => {
  const commands = [];
  runPublicCi((args) => commands.push(args), { cloudflare: true, inspectGraph: () => null });
  assert.deepEqual(commands, [...combinedPublicSteps, ...cloudflareSteps('validate:output')]);
  assert.ok(!commands.some((args) => args.includes('test:ci')));
});

test('graph source drift after root tests, after graph execution or after artifact checks blocks success', () => {
  for (const failAt of [1, 2, 3]) {
    const original = inspectPublicCiGraph();
    assert.ok(original);
    let checks = 0;
    const commands = [];
    assert.throws(
      () =>
        runPublicCi((args) => commands.push(args), {
          cloudflare: true,
          inspectGraph: () => ({
            ...original,
            assertUnchanged() {
              if (++checks === failAt) throw new Error('PUBLIC_CI_GRAPH_SOURCE_CHANGED');
            },
          }),
        }),
      /PUBLIC_CI_GRAPH_SOURCE_CHANGED/,
    );
    if (failAt === 1) assert.ok(!commands.some((args) => args.includes('test:ci')));
    if (failAt < 3) assert.ok(!commands.some((args) => args.includes('opennextjs-cloudflare')));
  }
});

test('nonempty Next-build overrides reject both Cloudflare modes before running any command', () => {
  const original = process.env.SKIP_NEXT_APP_BUILD;
  for (const value of [
    '1',
    'true',
    'yes',
    '0',
    'false',
    'no',
    'TRUE',
    'YES',
    ' true ',
    ' ',
    'unknown',
  ]) {
    withNextBuildOverride(value, () => {
      assert.deepEqual(publicBuildArgs(buildManifest, frontendBuildManifest, buildConfig), [
        'build:public',
      ]);
      for (const args of [['--cloudflare'], ['--cloudflare-only']]) {
        const commands = [];
        assert.throws(
          () => runCi(args, (command) => commands.push(command)),
          /SKIP_NEXT_APP_BUILD must be unset or empty for Cloudflare CI\./,
        );
        assert.deepEqual(commands, [], `${value} must reject before the first command`);
      }
      assert.deepEqual(capture([]), publicSteps, 'ordinary public CI must remain unchanged');
    });
    assert.equal(process.env.SKIP_NEXT_APP_BUILD, original);
  }
});

test('absent or empty Next-build overrides preserve deferral and standalone Cloudflare checks', () => {
  const original = process.env.SKIP_NEXT_APP_BUILD;
  for (const value of [undefined, '']) {
    withNextBuildOverride(value, () => {
      assert.deepEqual(
        publicBuildArgs(buildManifest, frontendBuildManifest, buildConfig),
        combinedPublicSteps.at(-1),
      );
      assert.deepEqual(capture(['--cloudflare']), [
        ...fullGraphSteps,
        ...cloudflareSteps('validate:output:ci'),
      ]);
      assert.deepEqual(capture(['--cloudflare-only']), cloudflareSteps('check'));
      assert.deepEqual(capture([]), publicSteps);
    });
    assert.equal(process.env.SKIP_NEXT_APP_BUILD, original);
  }
});

test('Next-build override fixtures restore the environment even when a callback fails', () => {
  const original = process.env.SKIP_NEXT_APP_BUILD;
  const failure = new Error('fixture failed');
  for (const outer of [undefined, '', 'original-override']) {
    withNextBuildOverride(outer, () => {
      for (const value of [undefined, '', 'true']) {
        assert.throws(
          () =>
            withNextBuildOverride(value, () => {
              throw failure;
            }),
          (actual) => actual === failure,
        );
        assert.equal(process.env.SKIP_NEXT_APP_BUILD, outer);
      }
    });
    assert.equal(process.env.SKIP_NEXT_APP_BUILD, original);
  }
});

test('standalone commands never defer builds or trust output left by another invocation', () => {
  capture(['--cloudflare']);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(capture([]), publicSteps);
    assert.deepEqual(capture(['--cloudflare-only']), cloudflareSteps('check'));
  }
});

test('every failed combined stage stops immediately, including reused docs output validation', () => {
  const expected = [...fullGraphSteps, ...cloudflareSteps('validate:output:ci')];
  for (let failure = 0; failure < expected.length; failure++) {
    const commands = [];
    const error = new Error(`stage ${failure} failed`);
    assert.throws(
      () =>
        runCi(['--cloudflare'], (command) => {
          commands.push(command);
          if (commands.length === failure + 1) throw error;
        }),
      (actual) => actual === error,
    );
    assert.deepEqual(commands, expected.slice(0, failure + 1));
  }
});

test('every failed unknown-profile full fallback stage stops without trying CI aliases', () => {
  const expected = [...combinedPublicSteps, ...cloudflareSteps('validate:output')];
  for (let failure = 0; failure < expected.length; failure++) {
    const commands = [];
    const error = new Error(`fallback stage ${failure} failed`);
    assert.throws(
      () =>
        runPublicCi(
          (args) => {
            commands.push(args);
            if (commands.length === failure + 1) throw error;
          },
          { cloudflare: true, inspectGraph: () => null },
        ),
      (actual) => actual === error,
    );
    assert.deepEqual(commands, expected.slice(0, failure + 1));
  }
});

test('every failed standalone stage stops immediately without deferring its build', () => {
  for (const [args, expected] of [
    [[], publicSteps],
    [['--cloudflare-only'], cloudflareSteps('check')],
  ]) {
    for (let failure = 0; failure < expected.length; failure++) {
      const commands = [];
      const error = new Error(`stage ${failure} failed`);
      assert.throws(
        () =>
          runCi(args, (command) => {
            commands.push(command);
            if (commands.length === failure + 1) throw error;
          }),
        (actual) => actual === error,
      );
      assert.deepEqual(commands, expected.slice(0, failure + 1));
    }
  }
});

test('standalone docs failures prevent both docs dry-runs', () => {
  const commands = [];
  assert.throws(() =>
    runCi(['--cloudflare-only'], (command) => {
      commands.push(command);
      if (command.at(-1) === 'check') throw new Error('docs failed');
    }),
  );
  assert.deepEqual(commands, cloudflareSteps('check').slice(0, 4));
});

test('CLI rejects skip flags, unknown options and combined modes before running commands', () => {
  const filename = fileURLToPath(new URL('./public-ci.mjs', import.meta.url));
  for (const args of [
    ['--reuse-docs'],
    ['--skip-docs'],
    ['--cloudflare', '--cloudflare-only'],
    ['--cloudflare', '--skip-docs'],
    ['--skip-frontend'],
    ['--reuse-frontend'],
    ['--cloudflare', '--skipNextBuild'],
    ['--graph'],
  ]) {
    assert.throws(() => runCi(args, () => assert.fail('must not run')), /Usage:/);
    const result = spawnSync(process.execPath, [filename, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
  }
});

test('standalone audit and test commands retain security coverage, with CI policy tests wired in', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts['ci:public'], 'node scripts/public-ci.mjs');
  assert.equal(manifest.scripts['ci:cloudflare'], 'node scripts/public-ci.mjs --cloudflare-only');
  assert.equal(
    manifest.scripts['audit:production:high'],
    'pnpm test:dependency-security && pnpm audit --prod --audit-level high',
  );
  assert.equal(manifest.scripts['test:public'].match(/\btest:dependency-security\b/g)?.length, 1);
  for (const filename of ['verify-release-ci.test.mjs', 'public-ci.test.mjs']) {
    assert.equal(manifest.scripts['test:public'].split(filename).length - 1, 1);
  }
  for (const filename of ['http-cache-semantics', 'braces', 'production-dependencies']) {
    assert.ok(manifest.scripts['test:dependency-security'].includes(`${filename}.test.mjs`));
  }
});

test('reused docs coverage matches the complete standalone check contract', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const docs = JSON.parse(
    await readFile(new URL('../apps/docs/package.json', import.meta.url), 'utf8'),
  );
  for (const task of ['lint', 'typecheck', 'build']) {
    assert.equal(
      manifest.scripts[`${task}:public`],
      `turbo run ${task} --filter=!@agentdomain/contracts`,
    );
  }
  assert.ok(
    manifest.scripts['test:public'].endsWith('turbo run test --filter=!@agentdomain/contracts'),
  );
  assert.equal(docs.scripts.lint, docs.scripts['validate:content']);
  assert.equal(
    docs.scripts.check,
    'pnpm run validate:content && pnpm run typecheck && pnpm run test && pnpm run build && pnpm run validate:output',
    'New standalone docs gates must also be covered before combined CI reuses their output',
  );
});
