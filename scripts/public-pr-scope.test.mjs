import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parsers } from 'prettier/plugins/yaml';
import {
  classifyPublicPaths,
  inspectPublicPrScope,
  resolvePublicPrScope,
} from './public-pr-scope.mjs';
import { runCi, runPublicCi, runPublicPrCi } from './public-ci.mjs';
import { postbuildLanes } from './public-ci-postbuild.mjs';

const docs = 'apps/docs/src/content/docs/quickstart.mdx';
const frontend = 'apps/frontend/src/app/page.tsx';
const policy = JSON.parse(readFileSync(new URL('./public-release-policy.json', import.meta.url)));

function fixture(t, changes = [[docs, 'changed\n']], initial = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'agentdomain-public-pr-'));
  t.after(() => {
    assert.equal(dirname(temporary), resolve(tmpdir()));
    assert(basename(temporary).startsWith('agentdomain-public-pr-'));
    rmSync(temporary, { recursive: true, force: true });
  });
  const directory = join(temporary, 'repo');
  mkdirSync(directory);
  const git = (...args) => {
    const result = spawnSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        `core.hooksPath=${join(temporary, 'no-hooks')}`,
        ...args,
      ],
      { cwd: directory, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (path, value) => {
    const file = resolve(directory, path);
    assert(file.startsWith(directory + sep));
    if (value === null) rmSync(file);
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, value);
    }
  };
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Public routing fixture');
  git('config', 'user.email', 'routing@example.invalid');
  git('config', 'core.autocrlf', 'false');
  write('scripts/public-release-policy.json', JSON.stringify(policy));
  write('.gitignore', 'node_modules/\n.next/\n.open-next/\ndist/\nout/\n');
  for (const [path, value] of Object.entries({
    [docs]: 'original\n',
    [frontend]: 'original\n',
    ...initial,
  }))
    write(path, value);
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'feature');
  for (const [path, value] of changes) write(path, value);
  git('add', '-A');
  git('commit', '-m', 'head');
  const head = git('rev-parse', 'HEAD');
  git('checkout', 'main');
  git('merge', '--no-ff', 'feature', '-m', 'merge');
  const merge = git('rev-parse', 'HEAD');
  const repository = {
    id: Number(policy.repositoryId),
    full_name: '0xmdrakib/AgentDomain',
    owner: { login: '0xmdrakib', id: Number(policy.owners['0xmdrakib']) },
  };
  const event = {
    action: 'synchronize',
    number: 7,
    repository,
    pull_request: {
      draft: false,
      number: 7,
      merge_commit_sha: merge,
      base: { sha: base, ref: 'main', repo: repository },
      head: { sha: head, ref: 'feature', repo: repository },
    },
  };
  const eventPath = join(temporary, 'event.json');
  const saveEvent = () => writeFileSync(eventPath, JSON.stringify(event));
  saveEvent();
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_SHA: merge,
    GITHUB_REF: 'refs/pull/7/merge',
    GITHUB_BASE_REF: 'main',
    GITHUB_HEAD_REF: 'feature',
    GITHUB_REPOSITORY_ID: policy.repositoryId,
    GITHUB_REPOSITORY: repository.full_name,
    GITHUB_ACTOR: policy.operator.login,
    GITHUB_ACTOR_ID: policy.operator.id,
    GITHUB_TRIGGERING_ACTOR: policy.operator.login,
    GITHUB_RUN_ATTEMPT: '1',
  };
  return {
    directory,
    env,
    event,
    saveEvent,
    git,
    write,
    base,
    head,
    merge,
    inspect: () => resolvePublicPrScope({ directory, env }),
  };
}

test('only homogeneous docs content or frontend source/tests have reduced routes', () => {
  assert.equal(classifyPublicPaths([docs, 'apps/docs/src/content/docs/guides/email.md']), 'docs');
  assert.equal(classifyPublicPaths([frontend, 'apps/frontend/test/siwe-hook.test.ts']), 'frontend');
  for (const path of [
    'README.md',
    'apps/docs/README.md',
    'apps/frontend/README.md',
    'apps/frontend/src/lib/brand-assets.ts',
    'apps/frontend/src/components/brand/logo.tsx',
    'apps/frontend/src/config/settings.ts',
    'apps/frontend/public/logo.png',
    'apps/frontend/next.config.mjs',
    'apps/frontend/src/config.ts',
    'apps/docs/astro.config.mjs',
    'apps/docs/src/styles/docs.css',
    'packages/shared/src/schemas.ts',
    'packages/sdk/src/index.ts',
    'packages/mcp-server/src/index.ts',
    'packages/crewai-plugin/src/connector.py',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'turbo.json',
    'scripts/public-ci.mjs',
    '.github/workflows/public-ci.yml',
    'patches/braces@3.0.3.patch',
    'unknown/file.ts',
    '../apps/frontend/src/a.ts',
    'apps/frontend/src/../a.ts',
    'apps/frontend/src/a.ts\n',
    'apps/frontend/src/a.ts\0',
  ]) {
    assert.equal(classifyPublicPaths([path]), 'full', path);
    assert.equal(classifyPublicPaths([docs, path]), 'full', `mixed ${path}`);
  }
  assert.equal(classifyPublicPaths([docs, frontend]), 'full');
  for (const paths of [[], null, undefined, [null], ['']])
    assert.equal(classifyPublicPaths(paths), 'full');
});

test('real Git base, head and tested two-parent merge produce the docs route', (t) => {
  const f = fixture(t);
  assert.equal(
    lstatSync(resolve(f.git('rev-parse', '--show-toplevel'))).ino,
    lstatSync(f.directory).ino,
  );
  assert.equal(f.git('rev-parse', '--is-shallow-repository'), 'false');
  assert.equal(f.git('status', '--porcelain=v1', '-z', '--untracked-files=all'), '');
  assert(
    f
      .git('ls-files', '-v', '-z')
      .split('\0')
      .filter(Boolean)
      .every((entry) => entry.startsWith('H ')),
  );
  assert.equal(f.inspect(), 'docs');
  assert.equal(f.git('rev-list', '--parents', '-n', '1', 'HEAD'), `${f.merge} ${f.base} ${f.head}`);
});

test('frontend route is independently proven from actual Git', (t) => {
  const f = fixture(t, [[frontend, 'changed\n']]);
  assert.equal(f.inspect(), 'frontend');
});

function pushContext(f) {
  const event = {
    repository: f.event.repository,
    before: f.base,
    after: f.merge,
    ref: 'refs/heads/main',
    created: false,
    deleted: false,
    forced: false,
    sender: { login: policy.operator.login, id: Number(policy.operator.id), type: 'User' },
  };
  writeFileSync(f.env.GITHUB_EVENT_PATH, JSON.stringify(event));
  return { event, env: { ...f.env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: event.ref } };
}

for (const [path, scope] of [
  [docs, 'docs'],
  [frontend, 'frontend'],
])
  test(`trusted main push qualifies exact ${scope} range and retains source guards`, (t) => {
    const f = fixture(t, [[path, 'changed\n']]);
    const { env } = pushContext(f);
    const proof = inspectPublicPrScope({ directory: f.directory, env });
    assert.equal(proof.scope, scope);
    proof.assertSource();
    f.write(path, 'mutated after routing\n');
    assert.throws(proof.assertSource, /PUBLIC_PR_SOURCE_CHANGED/);
  });

test('main pushes require exact operator, real ancestor, complete nonforced event and first attempt', (t) => {
  const f = fixture(t);
  const { env, event } = pushContext(f);
  for (const patch of [
    { GITHUB_ACTIONS: 'false' },
    { GITHUB_SERVER_URL: 'https://github.example.invalid' },
    { GITHUB_ACTOR_ID: '42' },
    { GITHUB_ACTOR: 'foreign' },
    { GITHUB_TRIGGERING_ACTOR: 'foreign' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_REF: 'refs/heads/release' },
    { GITHUB_SHA: f.base },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_EVENT_NAME: 'release' },
  ])
    assert.equal(
      inspectPublicPrScope({ directory: f.directory, env: { ...env, ...patch } }).scope,
      'full',
    );
  for (const patch of [
    { before: '0'.repeat(40) },
    { before: 'f'.repeat(40) },
    { after: f.base },
    { ref: 'refs/heads/release' },
    { created: true },
    { deleted: true },
    { forced: true },
    { forced: undefined },
    { sender: { login: 'foreign', id: 42, type: 'User' } },
    { repository: { ...event.repository, id: 42 } },
  ]) {
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ ...event, ...patch }));
    assert.equal(inspectPublicPrScope({ directory: f.directory, env }).scope, 'full');
  }
});

test('main range includes every pushed commit rather than only the last commit', (t) => {
  const f = fixture(t, [['packages/sdk/src/index.ts', 'shared change\n']]);
  f.write(docs, 'last docs change\n');
  f.git('add', '.');
  f.git('commit', '-m', 'last docs-only commit');
  f.merge = f.git('rev-parse', 'HEAD');
  f.env.GITHUB_SHA = f.merge;
  const { env } = pushContext(f);
  assert.equal(inspectPublicPrScope({ directory: f.directory, env }).scope, 'full');
});

test('an existing but unrelated before commit cannot reduce main qualification', (t) => {
  const f = fixture(t);
  f.git('checkout', '-b', 'unrelated', f.base);
  f.write(docs, 'unrelated branch\n');
  f.git('add', '.');
  f.git('commit', '-m', 'unrelated commit');
  const unrelated = f.git('rev-parse', 'HEAD');
  f.git('checkout', 'main');
  const { event, env } = pushContext(f);
  writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ ...event, before: unrelated }));
  assert.equal(inspectPublicPrScope({ directory: f.directory, env }).scope, 'full');
});

test('Talvono transfer preserves the same repository and merge checkout qualification', (t) => {
  const f = fixture(t);
  f.event.repository.full_name = 'Talvono/AgentDomain';
  f.event.repository.owner = { login: 'Talvono', id: Number(policy.owners.Talvono) };
  f.env.GITHUB_REPOSITORY = 'Talvono/AgentDomain';
  f.saveEvent();
  assert.equal(f.inspect(), 'docs');
  const { env } = pushContext(f);
  assert.equal(inspectPublicPrScope({ directory: f.directory, env }).scope, 'docs');
});

test('renames include the original path and cannot hide mixed-scope changes', (t) => {
  const f = fixture(
    t,
    [
      [docs, null],
      [frontend, 'original\n'],
    ],
    { [frontend]: 'frontend\n' },
  );
  assert.equal(f.inspect(), 'full');
});

test('deletions inside the docs route remain qualified docs work', (t) => {
  const f = fixture(t, [[docs, null]]);
  assert.equal(f.inspect(), 'docs');
});

test('all context mismatches select full, including forged base/head and owner identity', (t) => {
  const f = fixture(t);
  for (const [key, value] of [
    ['GITHUB_EVENT_NAME', 'push'],
    ['GITHUB_EVENT_NAME', 'workflow_dispatch'],
    ['GITHUB_ACTIONS', 'false'],
    ['GITHUB_SERVER_URL', 'https://github.example.invalid'],
    ['GITHUB_ACTOR', 'foreign'],
    ['GITHUB_ACTOR_ID', '42'],
    ['GITHUB_TRIGGERING_ACTOR', 'foreign'],
    ['GITHUB_RUN_ATTEMPT', '2'],
    ['GITHUB_SHA', f.head],
    ['GITHUB_REF', 'refs/heads/main'],
    ['GITHUB_BASE_REF', 'release'],
    ['GITHUB_HEAD_REF', 'other'],
    ['GITHUB_REPOSITORY', 'someone/AgentDomain'],
    ['GITHUB_REPOSITORY_ID', '42'],
    ['GITHUB_EVENT_PATH', join(f.directory, 'absent.json')],
  ])
    assert.equal(
      resolvePublicPrScope({ directory: f.directory, env: { ...f.env, [key]: value } }),
      'full',
    );
  const original = JSON.stringify(f.event);
  for (const mutate of [
    (e) => {
      e.pull_request.base.sha = f.head;
    },
    (e) => {
      e.pull_request.head.sha = f.base;
    },
    (e) => {
      e.pull_request.merge_commit_sha = f.head;
    },
    (e) => {
      e.pull_request.base.ref = 'release';
    },
    (e) => {
      e.pull_request.base.repo.owner.id = 42;
    },
    (e) => {
      e.number = 8;
    },
    (e) => {
      e.action = 'closed';
    },
    (e) => {
      e.pull_request.draft = true;
    },
    (e) => {
      e.pull_request.head.repo = { ...e.repository, id: 42 };
    },
    (e) => {
      e.pull_request.head.repo = { ...e.repository, full_name: 'foreign/AgentDomain' };
    },
  ]) {
    const event = JSON.parse(original);
    mutate(event);
    writeFileSync(f.env.GITHUB_EVENT_PATH, JSON.stringify(event));
    assert.equal(f.inspect(), 'full');
  }
  writeFileSync(f.env.GITHUB_EVENT_PATH, '{');
  assert.equal(f.inspect(), 'full');
  f.saveEvent();
  assert.equal(f.inspect(), 'docs');
});

test('dirty tracked/untracked source, wrong checkout and shallow history cannot reduce checks', (t) => {
  const f = fixture(t);
  f.write(docs, 'uncommitted\n');
  assert.equal(f.inspect(), 'full');
  f.write(docs, 'changed\n');
  f.write('untracked.txt', 'untracked\n');
  assert.equal(f.inspect(), 'full');
  f.write('untracked.txt', null);
  assert.equal(f.inspect(), 'docs');
  f.git('update-index', '--assume-unchanged', docs);
  f.write(docs, 'hidden edit\n');
  assert.equal(f.inspect(), 'full');
  f.write(docs, 'changed\n');
  f.git('update-index', '--no-assume-unchanged', docs);
  assert.equal(f.inspect(), 'docs');
  f.git('checkout', '--detach', f.head);
  assert.equal(f.inspect(), 'full');
  f.git('checkout', '--detach', f.merge);
  writeFileSync(join(f.directory, '.git', 'shallow'), `${f.base}\n`);
  assert.equal(f.inspect(), 'full');
});

test('no caller scope/base/skip variables or persisted result can authorize a route', (t) => {
  const f = fixture(t, [[frontend, 'changed\n']]);
  const env = {
    ...f.env,
    PUBLIC_PR_SCOPE: 'docs',
    PUBLIC_PR_BASE: f.head,
    TURBO_SCM_BASE: f.head,
    TURBO_SCM_HEAD: f.base,
    SKIP_CHECKS: 'true',
  };
  assert.equal(resolvePublicPrScope({ directory: f.directory, env }), 'frontend');
  f.write('scripts/public-ci.mjs', 'changed policy\n');
  assert.equal(resolvePublicPrScope({ directory: f.directory, env }), 'full');
  f.write('scripts/public-ci.mjs', null);
  assert.equal(
    resolvePublicPrScope({ directory: f.directory, env: { PUBLIC_PR_SCOPE: 'docs' } }),
    'full',
  );
  for (const args of [['--scope=docs'], ['--pull-request', '--scope=docs'], ['--pull-request']])
    assert.throws(() => runCi(args, () => assert.fail('No command should run')));
});

const guardCommands = [
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
];
const capture = (scope) => {
  const commands = [];
  assert.equal(
    runPublicPrCi(
      (command) => commands.push(command),
      () => ({ scope, assertSource() {} }),
    ),
    scope,
  );
  return commands;
};

test('every reduced route retains every mandatory guard and both exact Worker dry-runs', () => {
  for (const scope of ['docs', 'frontend']) {
    const commands = capture(scope);
    assert.deepEqual(commands.slice(0, guardCommands.length), guardCommands);
    const workspace = `@agentdomain/${scope}`;
    assert.deepEqual(commands.slice(-2), [
      ['--filter', workspace, 'exec', 'wrangler', 'deploy', '--dry-run', '--env='],
      ['--filter', workspace, 'exec', 'wrangler', 'deploy', '--dry-run', '--env', 'preview'],
    ]);
  }
  assert(capture('docs').some((args) => args.join(' ') === '--filter @agentdomain/docs check'));
  const frontendCommands = capture('frontend');
  assert(
    frontendCommands.some(
      (args) =>
        args.join(' ') ===
        'exec turbo run lint typecheck test --filter=@agentdomain/frontend... --force',
    ),
  );
  assert(
    frontendCommands.some(
      (args) =>
        args.join(' ') === '--filter @agentdomain/frontend exec opennextjs-cloudflare build',
    ),
  );
  assert(frontendCommands.some((args) => args.join(' ') === '--filter @agentdomain/docs test'));
});

test('routing regressions are mandatory once in full and scoped guard commands', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const suite = 'scripts/public-pr-scope.test.mjs';
  const fullGuards = manifest.scripts['test:public']
    .split(' && ')
    .filter((command) => command.startsWith('node --test '));
  assert.equal(fullGuards.length, 1);
  assert.equal(fullGuards[0].split(' ').filter((argument) => argument === suite).length, 1);
  const fullCommands = capture('full');
  const umbrella = fullCommands.filter((command) => command[0] === 'test:public');
  const combinedGuards = fullCommands.filter(
    (command) => command.slice(0, 3).join(' ') === 'exec node --test',
  );
  assert.equal(umbrella.length + combinedGuards.length, 1);
  if (combinedGuards.length === 1)
    assert.deepEqual(combinedGuards[0], ['exec', ...fullGuards[0].split(' ')]);
  const fallback = [];
  runPublicCi((command) => fallback.push(command), {
    cloudflare: true,
    inspectGraph: () => null,
  });
  assert.equal(fallback.filter((command) => command[0] === 'test:public').length, 1);
  assert.equal(fallback.filter((command) => command.includes(suite)).length, 0);
  for (const scope of ['docs', 'frontend']) {
    const guards = capture(scope).filter(
      (command) => command.slice(0, 3).join(' ') === 'exec node --test',
    );
    assert.equal(guards.length, 1);
    assert.equal(guards[0].filter((argument) => argument === suite).length, 1);
  }
  const workflow = readFileSync(
    new URL('../.github/workflows/public-ci.yml', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(workflow, /node --test scripts\/public-pr-scope\.test\.mjs/);
});

test('main and unavailable context preserve the complete unchanged full command sequence', (t) => {
  const f = fixture(t);
  const expected = [];
  runPublicCi((args) => expected.push(args), { cloudflare: true });
  for (const eventName of ['push', 'workflow_dispatch', undefined]) {
    const commands = [];
    const scope = runPublicPrCi(
      (args) => commands.push(args),
      () =>
        inspectPublicPrScope({
          directory: f.directory,
          env: { ...f.env, GITHUB_EVENT_NAME: eventName },
        }),
    );
    assert.equal(scope, 'full');
    assert.deepEqual(commands, expected);
  }
});

test('all failed stages block success, with no later command or automatic retry', () => {
  for (const scope of ['docs', 'frontend', 'full']) {
    const expected = capture(scope);
    for (let failure = 0; failure < expected.length; failure++) {
      const commands = [];
      assert.throws(
        () =>
          runPublicPrCi(
            (command) => {
              commands.push(command);
              if (commands.length === failure + 1) throw new Error('stage failed');
            },
            () => ({ scope, assertSource() {} }),
          ),
        /stage failed/,
      );
      assert.deepEqual(commands, expected.slice(0, failure + 1));
    }
  }
});

test('scope is recollected before builds on every invocation and drift blocks completion', () => {
  let changedReads = 0;
  assert.throws(
    () =>
      runPublicPrCi(
        () => {},
        () => ({
          scope: ++changedReads === 2 ? 'full' : 'docs',
          assertSource() {},
        }),
      ),
    /PUBLIC_PR_SCOPE_CHANGED/,
  );
  assert.equal(changedReads, 2);
  let reads = 0;
  let sourceChecks = 0;
  for (let i = 0; i < 2; i++)
    runPublicPrCi(
      () => {},
      () => {
        reads++;
        return {
          scope: 'docs',
          assertSource() {
            sourceChecks++;
          },
        };
      },
    );
  assert.equal(reads, 4);
  assert.equal(sourceChecks, 2);
});

test('ignored build artifacts do not invalidate scope, while changed source commits still block', (t) => {
  const f = fixture(t);
  const inspect = () => inspectPublicPrScope({ directory: f.directory, env: f.env });
  assert.equal(
    runPublicPrCi((args) => {
      if (args.join(' ') === '--filter @agentdomain/docs check') {
        for (const path of [
          'node_modules/generated/output.txt',
          'apps/frontend/.next/build-manifest.json',
          'apps/frontend/.open-next/worker.js',
          'apps/docs/dist/index.html',
          'out/output.txt',
        ])
          f.write(path, 'build output\n');
        assert.equal(f.git('ls-files', '--others', '--exclude-standard', '-z'), '');
      }
    }, inspect),
    'docs',
  );
  assert.throws(
    () =>
      runPublicPrCi((args) => {
        if (args.join(' ') === '--filter @agentdomain/docs check')
          f.git('checkout', '--detach', f.head);
      }, inspect),
    /PUBLIC_PR_SOURCE_CHANGED/,
  );
});

for (const [name, route, mutate] of [
  ['unstaged SDK source', 'docs', (f, sdk) => f.write(sdk, 'export const changed = true;\n')],
  [
    'staged SDK source',
    'docs',
    (f, sdk) => {
      f.write(sdk, 'export const changed = true;\n');
      f.git('add', sdk);
    },
  ],
  [
    'policy source',
    'frontend',
    (f) => f.write('scripts/public-release-policy.json', `${JSON.stringify(policy)}\n`),
  ],
  [
    'assume-unchanged SDK source',
    'docs',
    (f, sdk) => {
      f.git('update-index', '--assume-unchanged', sdk);
      f.write(sdk, 'export const changed = true;\n');
    },
  ],
  [
    'skip-worktree SDK source',
    'frontend',
    (f, sdk) => {
      f.git('update-index', '--skip-worktree', sdk);
      f.write(sdk, 'export const changed = true;\n');
    },
  ],
  [
    'index-only SDK source',
    'docs',
    (f, sdk, original) => {
      f.write(sdk, 'export const changed = true;\n');
      f.git('add', sdk);
      f.write(sdk, original);
      assert.equal(f.git('diff', '--name-only', 'HEAD', '--'), '');
    },
  ],
  ...['docs', 'frontend'].map((route) => [
    `untracked frontend source during ${route} build`,
    route,
    (f) => {
      const extra = 'apps/frontend/src/extra-runtime-input.tsx';
      f.write(extra, 'export const extra = true;\n');
      assert.equal(f.git('diff', '--name-only', 'HEAD', '--'), '');
      assert.equal(f.git('ls-files', '--others', '--exclude-standard'), extra);
    },
  ]),
]) {
  test(`post-guard source mutation blocks completion: ${name}`, (t) => {
    const sdk = 'packages/sdk/src/index.ts';
    const original = 'export const original = true;\n';
    const changed = route === 'docs' ? docs : frontend;
    const f = fixture(t, [[changed, 'changed\n']], { [sdk]: original });
    const inspect = () => inspectPublicPrScope({ directory: f.directory, env: f.env });
    assert.equal(f.inspect(), route);
    let mutated = false;
    assert.throws(
      () =>
        runPublicPrCi((args) => {
          if (
            args.join(' ') ===
            (route === 'docs'
              ? '--filter @agentdomain/docs check'
              : '--filter @agentdomain/frontend exec opennextjs-cloudflare build')
          ) {
            mutate(f, sdk, original);
            mutated = true;
            assert.equal(f.git('rev-parse', 'HEAD'), f.merge);
          }
        }, inspect),
      /PUBLIC_PR_SOURCE_CHANGED/,
    );
    assert.equal(mutated, true);
  });
}

test('installed Turbo proves the frontend workload dependency closure without running tasks', () => {
  const directory = new URL('..', import.meta.url);
  const env = Object.fromEntries(
    ['PATH', 'SystemRoot', 'HOME', 'USERPROFILE', 'TMP', 'TEMP']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  env.TURBO_TELEMETRY_DISABLED = '1';
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/turbo/bin/turbo', import.meta.url)),
      'run',
      'lint',
      'typecheck',
      'test',
      '--filter=@agentdomain/frontend...',
      '--force',
      '--dry-run=json',
    ],
    { cwd: directory, env, encoding: 'utf8', windowsHide: true, maxBuffer: 8_388_608 },
  );
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(result.stdout);
  assert.deepEqual(graph.packages.sort(), [
    '@agentdomain/frontend',
    '@agentdomain/sdk',
    '@agentdomain/shared',
  ]);
  const tasks = new Set(graph.tasks.map((task) => task.taskId));
  for (const name of graph.packages)
    for (const task of ['lint', 'typecheck', 'test']) assert(tasks.has(`${name}#${task}`));
  for (const name of ['@agentdomain/shared', '@agentdomain/sdk'])
    assert(tasks.has(`${name}#build`));
});

function yamlValue(node) {
  if (!node) return null;
  if (['mapping', 'flowMapping'].includes(node.type))
    return Object.fromEntries(node.children.map(({ children }) => children.map(yamlValue)));
  if (['sequence', 'flowSequence'].includes(node.type)) return node.children.map(yamlValue);
  if (['plain', 'quoteSingle', 'quoteDouble', 'blockLiteral', 'blockFolded'].includes(node.type))
    return node.value;
  assert(node.children.length <= 1);
  return yamlValue(node.children[0]);
}

test('workflow retains source guards, exact post-build lanes and fail-closed full completion', () => {
  const source = readFileSync(
    new URL('../.github/workflows/public-ci.yml', import.meta.url),
    'utf8',
  );
  const document = parsers.yaml.parse(source).children[0];
  const workflow = yamlValue(document.children.find(({ type }) => type === 'documentBody'));
  assert.equal(workflow.on.pull_request, null);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  const job = workflow.jobs.verify;
  assert.equal(job.name, 'Boundary, packages, frontend, docs, and Cloudflare');
  assert.equal(job.if, undefined);
  for (const step of job.steps) assert.equal(step['continue-on-error'], undefined);
  const step = (name) => {
    const found = job.steps.find((item) => item.name === name);
    assert(found, name);
    return found;
  };
  assert.equal(step('Check out public source').with['fetch-depth'], '0');
  for (const name of [
    'Reject secrets from the complete Git history',
    'Verify public boundary before dependency installation',
    'Test release and routing guards',
  ])
    assert.equal(step(name).if, undefined);
  assert.match(
    step('Reject secrets from the complete Git history').run,
    /--all --full-history HEAD/,
  );
  const guards = step('Test release and routing guards').run;
  for (const name of [
    'npm-release.test.mjs',
    'public-ci-postbuild.test.mjs',
    'test_release_artifacts.py',
    'test_python_boundary.py',
  ])
    assert(guards.includes(name));
  assert.equal(
    step('Verify affected public source with mandatory full fallback').run,
    'pnpm ci:public --affected --cloudflare',
  );
  const postbuild = step('Qualify isolated web and native Python post-build lanes');
  assert.equal(postbuild.id, 'public-postbuild');
  assert.equal(postbuild.run, 'node scripts/public-ci-postbuild.mjs');
  assert.equal(postbuild.if, undefined);
  assert.deepEqual(postbuild.env, {
    PUBLIC_CI_POSTBUILD_SCOPE: '${{ steps.public-scope.outputs.scope }}',
  });
  assert.equal(job.steps.filter((item) => item.id === 'public-postbuild').length, 1);
  assert.ok(
    job.steps.indexOf(postbuild) >
      job.steps.indexOf(step('Verify affected public source with mandatory full fallback')),
  );
  assert.ok(
    job.steps.indexOf(postbuild) > job.steps.indexOf(step('Test release and routing guards')),
  );
  for (const [scope, expected] of [
    ['full', ['web', 'native-python']],
    ['frontend', ['web']],
    ['docs', []],
  ])
    assert.deepEqual(
      postbuildLanes(scope).map(({ name }) => name),
      expected,
    );
  for (const scope of [undefined, '', 'unknown']) assert.throws(() => postbuildLanes(scope));

  const evaluate = (item, event, scope, complete) =>
    Function(
      'github',
      'steps',
      `return (${item.if
        .replaceAll('steps.public-scope', "steps['public-scope']")
        .replaceAll('steps.public-postbuild', "steps['public-postbuild']")})`,
    )(
      { event_name: event },
      {
        'public-scope': { outputs: { scope } },
        'public-postbuild': { outputs: { complete } },
      },
    );
  assert.equal(workflow.on.workflow_dispatch, null);
  const marker = step('Full Public Qualification (agentdomain.public-ci.full.v1)');
  assert.equal(job.steps.at(-1), marker);
  assert.equal(
    marker.if,
    "steps.public-scope.outputs.scope == 'full' && steps.public-postbuild.outputs.complete == 'true'",
  );
  for (const event of ['push', 'pull_request', 'workflow_dispatch'])
    for (const scope of ['full', 'docs', 'frontend', undefined, 'unknown'])
      for (const complete of ['true', 'false', '', undefined])
        assert.equal(
          evaluate(marker, event, scope, complete),
          scope === 'full' && complete === 'true',
        );
});
