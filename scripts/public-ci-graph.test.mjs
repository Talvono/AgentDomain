import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  PUBLIC_CI_GRAPH_CONTRACT as contract,
  inspectPublicCiGraph,
  qualifiesPublicCiGraph,
  reviewedCiTurboSource,
} from './public-ci-graph.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
function profile() {
  return {
    manifest: {
      name: 'agentdomain-public',
      packageManager: 'pnpm@10.33.2',
      scripts: { ...contract.rootScripts },
    },
    packages: Object.fromEntries(
      Object.entries(contract.packages).map(([path, value]) => [
        path,
        {
          name: value.name,
          scripts: { ...value.scripts },
          dependencies: { ...value.workspaceDependencies },
        },
      ]),
    ),
    configHashes: { ...contract.configHashes },
    workspaceDirectories: [...contract.workspaceDirectories],
    turboVersion: '2.10.12',
    typescriptVersion: '5.9.3',
    hasOverrides: false,
  };
}

test('only the exact reviewed CI script, compiler and graph profile authorizes deduplication', () => {
  assert.equal(qualifiesPublicCiGraph(profile()), true);
  for (const mutate of [
    (p) => {
      p.manifest.name = 'other';
    },
    (p) => {
      p.manifest.packageManager = 'pnpm@10.33.3';
    },
    (p) => {
      p.workspaceDirectories.push('packages/foreign');
    },
    (p) => {
      delete p.packages['packages/sdk'];
    },
    (p) => {
      p.packages['packages/sdk'].name = '@foreign/sdk';
    },
    (p) => {
      p.packages['packages/sdk'].dependencies['@agentdomain/shared'] = 'workspace:*';
    },
    (p) => {
      p.packages['apps/frontend'].dependencies['@agentdomain/private'] = 'workspace:*';
    },
    (p) => {
      p.packages['packages/sdk'].optionalDependencies = { '@agentdomain/shared': 'workspace:^' };
    },
    (p) => {
      p.turboVersion = 'new-version';
    },
    (p) => {
      p.typescriptVersion = 'new-version';
    },
    (p) => {
      p.hasOverrides = true;
    },
    (p) => {
      p.packages['apps/frontend'].scripts['build:ci'] = 'next build';
    },
    (p) => {
      p.packages['apps/docs'].scripts['new:ci'] = 'node new-check.mjs';
    },
  ]) {
    const changed = profile();
    mutate(changed);
    assert.equal(qualifiesPublicCiGraph(changed), false);
  }
  for (const value of [null, {}, undefined]) assert.equal(qualifiesPublicCiGraph(value), false);
});

test('every original or CI command and its lifecycle hooks remain guarded', () => {
  for (const directory of ['root', ...Object.keys(contract.packages)]) {
    const scripts =
      directory === 'root' ? contract.rootScripts : contract.packages[directory].scripts;
    for (const task of Object.keys(scripts))
      for (const [key, value] of [
        [task, undefined],
        [task, `${scripts[task]} && node extra.mjs`],
        [`pre${task}`, ''],
        [`post${task}`, 'node hook.mjs'],
      ]) {
        const changed = profile();
        (directory === 'root' ? changed.manifest : changed.packages[directory]).scripts[key] =
          value;
        assert.equal(qualifiesPublicCiGraph(changed), false, `${directory}/${key}`);
      }
  }
});

test('compiler, dependency, source-config and graph drift cannot select a reduced compiler path', () => {
  for (const path of Object.keys(contract.configHashes)) {
    for (const value of [undefined, '0'.repeat(64)]) {
      const changed = profile();
      changed.configHashes[path] = value;
      assert.equal(qualifiesPublicCiGraph(changed), false, path);
    }
  }
  const changed = profile();
  changed.configHashes['unknown.config.json'] = 'a'.repeat(64);
  assert.equal(qualifiesPublicCiGraph(changed), false);
  const source = readFileSync(resolve(root, 'turbo.json'), 'utf8');
  assert.equal(reviewedCiTurboSource(source), true);
  assert.equal(
    reviewedCiTurboSource(source.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')),
    true,
  );
  assert.equal(reviewedCiTurboSource(`${source}\n`), false);
  assert.equal(reviewedCiTurboSource(source.replaceAll('"cache": false', '"cache": true')), false);
});

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'agentdomain-ci-graph-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const paths = [
    'package.json',
    ...Object.keys(contract.packages).map((path) => `${path}/package.json`),
    ...Object.keys(contract.configHashes),
    'scripts/public-ci.mjs',
    'scripts/public-ci-graph.mjs',
    'apps/frontend/test/isolation.test.mjs',
    'node_modules/turbo/package.json',
    'node_modules/typescript/package.json',
  ];
  for (const path of paths) {
    const target = resolve(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(root, path), target);
  }
  return { directory, inspect: () => inspectPublicCiGraph({ directory }) };
}

test('trusted filesystem inspection binds all watched inputs within the invocation, not saved output', (t) => {
  const f = fixture(t);
  const proof = f.inspect();
  assert.ok(proof);
  assert.deepEqual(proof.args, contract.graphArgs);
  assert.deepEqual(proof.rootTests, contract.rootTests);
  proof.assertUnchanged();
  mkdirSync(resolve(f.directory, 'packages/sdk/dist'), { recursive: true });
  writeFileSync(resolve(f.directory, 'packages/sdk/dist/index.js'), 'same-invocation output');
  proof.assertUnchanged();
  writeFileSync(resolve(f.directory, 'packages/sdk/tsconfig.json'), '{}');
  assert.equal(f.inspect(), null);
  assert.throws(proof.assertUnchanged, /PUBLIC_CI_GRAPH_SOURCE_CHANGED/);
});

test('graph deduplication requires the explicit frontend isolation test as a regular file', (t) => {
  const f = fixture(t);
  const file = resolve(f.directory, 'apps/frontend/test/isolation.test.mjs');
  rmSync(file);
  assert.equal(f.inspect(), null);
  mkdirSync(file);
  assert.equal(f.inspect(), null);
});

for (const mutation of ['override', 'workspace', 'alias', 'orchestrator', 'isolation'])
  test(`post-inspection ${mutation} drift fails closed`, (t) => {
    const f = fixture(t);
    const proof = f.inspect();
    assert.ok(proof);
    if (mutation === 'override') writeFileSync(resolve(f.directory, 'apps/docs/turbo.jsonc'), '{}');
    if (mutation === 'workspace') {
      mkdirSync(resolve(f.directory, 'packages/foreign'));
      writeFileSync(resolve(f.directory, 'packages/foreign/package.json'), '{}');
    }
    if (mutation === 'alias') {
      const file = resolve(f.directory, 'packages/sdk/package.json');
      const manifest = JSON.parse(readFileSync(file));
      manifest.scripts['test:ci'] = 'echo passed';
      writeFileSync(file, JSON.stringify(manifest));
    }
    if (mutation === 'orchestrator')
      writeFileSync(resolve(f.directory, 'scripts/public-ci-graph.mjs'), 'changed');
    if (mutation === 'isolation')
      writeFileSync(resolve(f.directory, 'apps/frontend/test/isolation.test.mjs'), 'changed');
    assert.throws(proof.assertUnchanged, /PUBLIC_CI_GRAPH_SOURCE_CHANGED/);
    if (!['orchestrator', 'isolation'].includes(mutation)) assert.equal(f.inspect(), null);
  });

test('the actual Turbo graph has one compiler build per package, complete tests and no early frontend build', () => {
  const proof = inspectPublicCiGraph();
  assert.ok(proof, 'The integrated profile must qualify before publishing this change');
  const execution = spawnSync(
    process.execPath,
    [resolve(root, 'node_modules/turbo/bin/turbo'), ...proof.args.slice(2), '--dry=json'],
    { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(execution.status, 0, execution.stderr);
  const { tasks } = JSON.parse(execution.stdout);
  const executable = tasks.filter((task) => task.command && task.command !== '<NONEXISTENT>');
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  for (const { name } of Object.values(contract.packages)) {
    for (const task of ['lint:ci', 'typecheck:ci', 'test:ci'])
      assert.ok(byId.has(`${name}#${task}`));
    if (name !== '@agentdomain/frontend')
      assert.equal(executable.filter((task) => task.taskId === `${name}#build:ci`).length, 1);
  }
  assert.equal(executable.filter((task) => task.command === 'tsc').length, 6);
  assert.equal(
    executable.filter(
      (task) => task.package === '@agentdomain/frontend' && task.task === 'build:ci',
    ).length,
    0,
  );
  for (const task of executable) {
    assert.equal(task.resolvedTaskDefinition.cache, false, task.taskId);
    assert.equal(task.cache.local, false);
    assert.equal(task.cache.remote, false);
    assert.ok(
      !task.dependencies.some((dependency) => /#(?:build|test|typecheck|lint)$/.test(dependency)),
      task.taskId,
    );
  }
  for (const task of ['test:ci', 'typecheck:ci'])
    assert.deepEqual(byId.get(`@agentdomain/frontend#${task}`).dependencies.sort(), [
      '@agentdomain/sdk#build:ci',
      '@agentdomain/shared#build:ci',
    ]);
  for (const slug of [
    'shared',
    'sdk',
    'mcp-server',
    'agentkit-plugin',
    'eliza-plugin',
    'langchain-plugin',
  ]) {
    assert.ok(
      byId
        .get(`@agentdomain/${slug}#test:ci`)
        .dependencies.includes(`@agentdomain/${slug}#build:ci`),
    );
  }
  assert.ok(
    byId.get('@agentdomain/docs#test:ci').dependencies.includes('@agentdomain/docs#typecheck:ci'),
  );
  assert.ok(
    byId.get('@agentdomain/docs#build:ci').dependencies.includes('@agentdomain/docs#test:ci'),
  );
  assert.ok(
    byId
      .get('@agentdomain/langchain-plugin#typecheck:ci')
      .dependencies.includes('@agentdomain/langchain-plugin#lint:ci'),
  );
  proof.assertUnchanged();
});
