import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const originalManifestHashes = {
  'apps/docs': 'affc5a8989455a0f2400f738379438db630ed65d2e37f69768c5f930cfd406df',
  'apps/frontend': '6574377970745719e884691391304f83cce3baf69328718e27281f185e5858cf',
  'packages/shared': 'e69fa04cd6e5af8d5c147a92957ae16094be4eee8b50f0d80bd1f02e205ebceb',
  'packages/sdk': 'c38c0291fd3e1613741d622d84dcd2eab0124681c80f2163c7d08c78bbc8f072',
  'packages/mcp-server': 'd7525237600ab85a5038ecca43aff80c8e5ed7958ec3247dc0924eef11483d24',
  'packages/agentkit-plugin': '7704b0da406c7c02ed056145f1f103289b251a86797bbf889cd1f4a3418fe7ac',
  'packages/eliza-plugin': '2d09cd45c45300956b708636d2fb2fbe63171600089d05bb720dce328905e559',
  'packages/langchain-plugin': '3825deae0a3824b29438d99517591b5f5439aaf7f70f472cad3eb1b0d3ff8fc6',
};
const originalTurboHash = 'c2d5658becbfcb5a1e4dfa2d3e9b1a93ac0630afbb48485daa24e48d88756fdb';
const coreTasks = ['lint:ci', 'typecheck:ci', 'test:ci', 'build:ci'];
const compiled = [
  'shared',
  'sdk',
  'mcp-server',
  'agentkit-plugin',
  'eliza-plugin',
  'langchain-plugin',
];
const aliases = Object.fromEntries(
  compiled.map((name) => [
    `packages/${name}`,
    {
      'build:ci': 'tsc',
      'lint:ci': ['shared', 'sdk'].includes(name)
        ? 'echo ok'
        : name === 'langchain-plugin'
          ? 'tsc --noEmit'
          : 'echo "no lint"',
      'typecheck:ci': name === 'langchain-plugin' ? 'tsc -p tsconfig.test.json' : 'tsc --noEmit',
      'test:ci': 'node --test test/*.test.mjs',
    },
  ]),
);
aliases['apps/docs'] = {
  'build:ci': 'astro build && node ../../scripts/seo/indexnow.mjs prepare-key --site=docs',
  'lint:ci': 'node scripts/validate-content.mjs',
  'typecheck:ci': 'astro check',
  'test:ci': 'node --test test/*.test.mjs',
  'validate:output:ci': 'node scripts/validate-output.mjs',
};
aliases['apps/frontend'] = {
  'lint:ci': 'eslint .',
  'typecheck:ci': 'pnpm run assets && tsc --noEmit',
  'test:ci':
    'pnpm run assets && node --test test/*.test.mjs && tsx --test test/*.test.ts && pnpm run test:seo',
};
const task = (dependsOn, outputs) => ({ dependsOn, ...(outputs ? { outputs } : {}), cache: false });
const ciTasks = {
  'build:ci': task(['^build:ci'], ['dist/**', 'out/**', '.next/**', '.open-next/**', '.astro/**']),
  'lint:ci': task(['^lint:ci']),
  'typecheck:ci': task(['^build:ci', 'build:ci'], []),
  'test:ci': task(['^build:ci', 'build:ci', 'typecheck:ci'], ['coverage/**']),
  '@agentdomain/langchain-plugin#lint:ci': task(['^lint:ci', '^build:ci', 'build:ci']),
  '@agentdomain/langchain-plugin#typecheck:ci': task(['^build:ci', 'build:ci', 'lint:ci'], []),
  '@agentdomain/frontend#build:ci': task(['^build:ci'], []),
  '@agentdomain/frontend#test:ci': task(['^build:ci'], ['coverage/**']),
  '@agentdomain/frontend#typecheck:ci': task(['^build:ci'], []),
  '@agentdomain/docs#typecheck:ci': task(['^build:ci', 'lint:ci'], []),
  '@agentdomain/docs#test:ci': task(['^build:ci', 'typecheck:ci'], ['coverage/**']),
  '@agentdomain/docs#build:ci': task(['^build:ci', 'test:ci'], ['dist/**', '.astro/**']),
  '@agentdomain/docs#validate:output:ci': task(['build:ci'], []),
};

function readInputs() {
  const manifests = {};
  for (const parent of ['apps', 'packages']) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      const path = `${parent}/${entry.name}`;
      const manifest = join(root, path, 'package.json');
      if (!existsSync(manifest)) continue;
      assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
      assert.ok(lstatSync(manifest).isFile() && !lstatSync(manifest).isSymbolicLink());
      manifests[path] = JSON.parse(readFileSync(manifest, 'utf8'));
    }
  }
  return { manifests, turbo: JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8')) };
}

function verifyAliases(manifests) {
  assert.deepEqual(
    Object.keys(manifests).sort(),
    Object.keys(aliases).sort(),
    'exact workspace inventory',
  );
  for (const [path, expected] of Object.entries(aliases)) {
    const manifest = structuredClone(manifests[path]);
    const scripts = manifest.scripts;
    assert.deepEqual(
      Object.fromEntries(Object.entries(scripts).filter(([name]) => name.endsWith(':ci'))),
      expected,
    );
    for (const [name, command] of Object.entries(expected)) {
      assert.equal(scripts[name], command);
      for (const original of [name, name.slice(0, -3)]) {
        assert.equal(scripts[`pre${original}`], undefined, `${path}: unreviewed pre hook`);
        assert.equal(scripts[`post${original}`], undefined, `${path}: unreviewed post hook`);
      }
      delete scripts[name];
    }
    assert.equal(
      digest(manifest),
      originalManifestHashes[path],
      `${path}: standalone/source metadata changed`,
    );
  }
}

function verifyTurbo(turbo) {
  const original = structuredClone(turbo);
  for (const [name, expected] of Object.entries(ciTasks)) {
    assert.deepEqual(original.tasks[name], expected, `exact fresh CI graph: ${name}`);
    delete original.tasks[name];
  }
  assert.equal(digest(original), originalTurboHash, 'original standalone graph must be unchanged');
}

function nativeGraph(filter = '--filter=!@agentdomain/contracts') {
  const env = Object.fromEntries(
    ['PATH', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TMP', 'TEMP']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  env.TURBO_TELEMETRY_DISABLED = '1';
  env.DO_NOT_TRACK = '1';
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/turbo/bin/turbo'),
      'run',
      ...coreTasks,
      'validate:output:ci',
      filter,
      '--force',
      '--no-daemon',
      '--dry-run=json',
    ],
    { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 8_388_608 },
  );
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(result.stdout);
  assert.equal(graph.turboVersion, '2.10.12');
  return graph;
}

test('CI-only additions preserve every original script, hook, version and dependency', () => {
  const inputs = readInputs();
  verifyAliases(inputs.manifests);
  verifyTurbo(inputs.turbo);
});

test('compiler removal is exactly a freshly satisfied prefix, never a test or check tail', () => {
  const { manifests } = readInputs();
  for (const name of compiled) {
    const s = manifests[`packages/${name}`].scripts;
    const prefix =
      name === 'shared'
        ? 'pnpm run build && '
        : name === 'sdk'
          ? 'pnpm build && '
          : `pnpm --filter @agentdomain/sdk build && pnpm ${name === 'mcp-server' ? 'build' : 'run build'} && `;
    assert.equal(s.test, prefix + s['test:ci']);
    assert.equal(s.build, s['build:ci']);
    assert.equal(s.lint, s['lint:ci']);
    assert.equal(
      s.typecheck,
      name === 'langchain-plugin' ? `${s['lint:ci']} && ${s['typecheck:ci']}` : s['typecheck:ci'],
    );
  }
  const docs = manifests['apps/docs'].scripts;
  for (const name of ['build', 'typecheck', 'test', 'validate:output'])
    assert.equal(docs[name], 'pnpm run build:dependencies && ' + docs[`${name}:ci`]);
  assert.equal(docs['lint:ci'], docs['validate:content']);
  assert.equal(
    docs.check,
    'pnpm run validate:content && pnpm run typecheck && pnpm run test && pnpm run build && pnpm run validate:output',
  );
  const frontend = manifests['apps/frontend'].scripts;
  for (const name of ['lint', 'typecheck', 'test'])
    assert.equal(frontend[`${name}:ci`], frontend[name]);
  assert.equal(
    frontend['build:ci'],
    undefined,
    'no CI command may replace the later real OpenNext/Next build',
  );
  assert.match(frontend['build:cloudflare'], /opennextjs-cloudflare build/);
});

test('any alias, standalone command, lifecycle hook or workspace drift is rejected', () => {
  const { manifests } = readInputs();
  for (const [path, scripts] of Object.entries(aliases)) {
    for (const name of Object.keys(scripts)) {
      for (const mutate of [
        (s) => {
          delete s[name];
        },
        (s) => {
          s[name] += ' || true';
        },
        (s) => {
          s[`pre${name}`] = 'echo injected';
        },
        (s) => {
          s[`post${name}`] = 'echo injected';
        },
        (s) => {
          s[`pre${name.slice(0, -3)}`] = 'echo injected';
        },
        (s) => {
          s[`post${name.slice(0, -3)}`] = 'echo injected';
        },
      ]) {
        const changed = structuredClone(manifests);
        mutate(changed[path].scripts);
        assert.throws(() => verifyAliases(changed));
      }
    }
    for (const mutate of [
      (m) => {
        m.scripts.build += ' || true';
      },
      (m) => {
        m.version = '99.0.0';
      },
      (m) => {
        m.dependencies.extra = '1.0.0';
      },
      (m) => {
        m.scripts['unknown:ci'] = 'echo injected';
      },
    ]) {
      const changed = structuredClone(manifests);
      mutate(changed[path]);
      assert.throws(() => verifyAliases(changed));
    }
  }
  assert.throws(() =>
    verifyAliases({ ...manifests, 'packages/unknown': manifests['packages/shared'] }),
  );
});

test('graph drift cannot remove prerequisites, enable saved success or weaken standalone tasks', () => {
  const { turbo } = readInputs();
  for (const name of Object.keys(ciTasks)) {
    for (const mutate of [
      (task) => {
        task.dependsOn = [];
      },
      (task) => {
        task.cache = true;
      },
      (task) => {
        task.persistent = true;
      },
      (task) => {
        task.env = ['SKIP_CHECKS'];
      },
    ]) {
      const changed = structuredClone(turbo);
      mutate(changed.tasks[name]);
      assert.throws(() => verifyTurbo(changed));
    }
    const missing = structuredClone(turbo);
    delete missing.tasks[name];
    assert.throws(() => verifyTurbo(missing));
  }
  for (const mutate of [
    (t) => {
      t.tasks.build.dependsOn = [];
    },
    (t) => {
      t.tasks.test.outputs = [];
    },
    (t) => {
      t.globalEnv = ['SKIP_CHECKS'];
    },
    (t) => {
      t.tasks['unknown:ci'] = { cache: true };
    },
  ]) {
    const changed = structuredClone(turbo);
    mutate(changed);
    assert.throws(() => verifyTurbo(changed));
  }
});

test('real installed Turbo schedules each compiler once, with exact compiled-consumer prerequisites', () => {
  const { manifests } = readInputs();
  const graph = nativeGraph();
  assert.deepEqual(
    graph.packages.sort(),
    Object.values(manifests)
      .map((m) => m.name)
      .sort(),
  );
  const tasks = new Map(graph.tasks.map((task) => [task.taskId, task]));
  const expected = Object.values(manifests)
    .flatMap((m) => coreTasks.map((task) => `${m.name}#${task}`))
    .concat('@agentdomain/docs#validate:output:ci')
    .sort();
  assert.deepEqual([...tasks.keys()].sort(), expected);
  assert.equal(tasks.size, graph.tasks.length, 'one node per task, no duplicate execution');
  for (const task of graph.tasks) {
    assert.ok(task.taskId.endsWith(':ci'));
    assert.equal(task.resolvedTaskDefinition.cache, false);
    const [name, command] = task.taskId.split('#');
    const manifest = Object.values(manifests).find((m) => m.name === name);
    assert.equal(task.command, manifest.scripts[command] ?? '<NONEXISTENT>');
  }
  for (const name of compiled) {
    const id = `@agentdomain/${name}`;
    const manifest = manifests[`packages/${name}`];
    const dependencyBuilds = Object.keys(manifest.dependencies)
      .filter((dep) => dep.startsWith('@agentdomain/'))
      .map((dep) => `${dep}#build:ci`);
    assert.deepEqual(tasks.get(`${id}#build:ci`).dependencies.sort(), dependencyBuilds.sort());
    assert.ok(tasks.get(`${id}#test:ci`).dependencies.includes(`${id}#build:ci`));
    assert.ok(tasks.get(`${id}#test:ci`).dependencies.includes(`${id}#typecheck:ci`));
    assert.ok(tasks.get(`${id}#typecheck:ci`).dependencies.includes(`${id}#build:ci`));
    for (const build of dependencyBuilds)
      assert.ok(tasks.get(`${id}#test:ci`).dependencies.includes(build));
    assert.equal(
      graph.tasks.filter((task) => task.taskId === `${id}#build:ci` && task.command === 'tsc')
        .length,
      1,
    );
  }
  for (const task of ['build:ci', 'test:ci', 'typecheck:ci']) {
    assert.deepEqual(tasks.get(`@agentdomain/frontend#${task}`).dependencies.sort(), [
      '@agentdomain/sdk#build:ci',
      '@agentdomain/shared#build:ci',
    ]);
  }
  assert.equal(tasks.get('@agentdomain/frontend#build:ci').command, '<NONEXISTENT>');
  assert.ok(
    tasks
      .get('@agentdomain/langchain-plugin#lint:ci')
      .dependencies.includes('@agentdomain/langchain-plugin#build:ci'),
  );
  assert.ok(
    tasks
      .get('@agentdomain/langchain-plugin#typecheck:ci')
      .dependencies.includes('@agentdomain/langchain-plugin#lint:ci'),
  );
  for (const [after, before] of [
    ['typecheck:ci', 'lint:ci'],
    ['test:ci', 'typecheck:ci'],
    ['build:ci', 'test:ci'],
    ['validate:output:ci', 'build:ci'],
  ])
    assert.ok(
      tasks.get(`@agentdomain/docs#${after}`).dependencies.includes(`@agentdomain/docs#${before}`),
    );
});

test('native docs/frontend affected graphs retain exactly their dependency closure', () => {
  for (const [workspace, packages] of [
    ['docs', ['docs', 'shared']],
    ['frontend', ['frontend', 'sdk', 'shared']],
  ]) {
    const graph = nativeGraph(`--filter=@agentdomain/${workspace}...`);
    assert.deepEqual(graph.packages.sort(), packages.map((name) => `@agentdomain/${name}`).sort());
    assert.ok(graph.tasks.every((task) => !task.taskId.includes('@agentdomain/contracts')));
    for (const name of packages.filter((name) => name !== 'frontend'))
      assert.ok(
        graph.tasks.some(
          (task) =>
            task.taskId === `@agentdomain/${name}#build:ci` && task.command !== '<NONEXISTENT>',
        ),
      );
  }
});
