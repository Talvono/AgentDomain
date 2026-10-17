import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  PACKAGES,
  VERSION,
  releaseRows,
  publishEnvironment,
  publishRelease,
} from './npm-release.mjs';
import { postbuildLanes } from './public-ci-postbuild.mjs';

const rows =
  PACKAGES.map(
    (name) => `@agentdomain/${name}\t${VERSION}\tpackages/agentdomain-${name}-${VERSION}.tgz`,
  ).join('\n') + '\n';
const env = {
  GITHUB_REPOSITORY: '0xmdrakib/AgentDomain',
  GITHUB_REPOSITORY_ID: '1310051881',
  GITHUB_REPOSITORY_OWNER: '0xmdrakib',
  GITHUB_REPOSITORY_OWNER_ID: '113634586',
  GITHUB_ACTOR: '0xmdrakib',
  GITHUB_ACTOR_ID: '113634586',
  GITHUB_TRIGGERING_ACTOR: '0xmdrakib',
  GITHUB_WORKFLOW_REF: '0xmdrakib/AgentDomain/.github/workflows/publish-npm.yml@refs/heads/main',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REF: 'refs/heads/main',
  NODE_AUTH_TOKEN: 'old',
  NPM_BOOTSTRAP_TOKEN: 'sensitive-test',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-test',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.actions.githubusercontent.com/test',
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agentdomain-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages'));
  writeFileSync(join(root, 'publish-order.tsv'), rows);
  for (const [, , file] of releaseRows(rows)) writeFileSync(join(root, file), 'immutable');
  return root;
}

test('six exact names, versions, order and safe paths only', () => {
  assert.equal(releaseRows(rows).length, 6);
  for (const bad of [
    rows.replace('/sdk\t', '/other\t'),
    rows.replaceAll('0.11.0', '0.11.1'),
    rows + rows,
    rows.replace('packages/agentdomain-shared', '../agentdomain-shared'),
    rows.replaceAll('\t', ' '),
  ])
    assert.throws(() => releaseRows(bad), /NPM_RELEASE_REFUSED/);
});
test('every publication strips ambient credentials and preserves only OIDC transport', () => {
  const ordinary = publishEnvironment(env, '@agentdomain/sdk', VERSION, undefined, false);
  assert.equal(ordinary.NPM_BOOTSTRAP_TOKEN, undefined);
  assert.equal(ordinary.NODE_AUTH_TOKEN, undefined);
  assert.equal(ordinary.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'oidc-test');
  const boot = publishEnvironment(env, '@agentdomain/langchain-plugin', VERSION, 'test-only', true);
  assert.equal(boot.NODE_AUTH_TOKEN, undefined);
  assert.equal(boot.NPM_CONFIG_IGNORE_SCRIPTS, 'true');
  assert.equal(boot.NPM_CONFIG_FETCH_RETRIES, '0');
});
test('five OIDC children receive no bootstrap token, even if caller mistakenly supplied one', async (t) => {
  const calls = [];
  await publishRelease({
    root: fixture(t),
    npmCli: '/verified/npm-cli.js',
    mode: 'oidc',
    env,
    token: 'test-only',
    lookup: async () => ({ status: 404 }),
    run: async (...call) => {
      calls.push(call);
      return 0;
    },
  });
  assert.equal(calls.length, 5);
  for (const [, args, childEnv] of calls) {
    assert(args.includes('--ignore-scripts'));
    assert(args.includes('--provenance'));
    assert.equal(childEnv.NODE_AUTH_TOKEN, undefined);
    assert.equal(childEnv.NPM_BOOTSTRAP_TOKEN, undefined);
  }
});
test('LangChain missing-project publication has no static-token fallback', async (t) => {
  const calls = [];
  await publishRelease({
    root: fixture(t),
    npmCli: '/verified/npm-cli.js',
    mode: 'bootstrap',
    env,
    token: 'test-only',
    lookup: async () => ({ status: 404 }),
    run: async (...call) => {
      calls.push(call);
      return 0;
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].NODE_AUTH_TOKEN, undefined);
  assert(!calls[0][1].join(' ').includes('test-only'));
});
test('existing project or absent optional token uses OIDC without bootstrap', async (t) => {
  for (const token of ['test-only', undefined]) {
    const calls = [];
    await publishRelease({
      root: fixture(t),
      npmCli: '/verified/npm-cli.js',
      mode: 'bootstrap',
      env,
      token,
      lookup: async (path) => ({ status: path.endsWith(VERSION) ? 404 : 200 }),
      run: async (...call) => {
        calls.push(call);
        return 0;
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].NODE_AUTH_TOKEN, undefined);
  }
});
test('network/auth errors fail closed and unknown publish is not retried', async (t) => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(
      publishRelease({
        root: fixture(t),
        npmCli: 'npm',
        mode: 'oidc',
        env,
        lookup: async () => ({ status }),
        run: async () => {
          calls++;
          return 0;
        },
      }),
    );
    assert.equal(calls, 0);
  }
  let calls = 0;
  await assert.rejects(
    publishRelease({
      root: fixture(t),
      npmCli: 'npm',
      mode: 'oidc',
      env,
      lookup: async () => ({ status: 404 }),
      run: async () => {
        calls++;
        return null;
      },
    }),
  );
  assert.equal(calls, 1);
});
test('already published artifact must match exact immutable integrity', async (t) => {
  const root = fixture(t);
  const integrity = `sha512-${createHash('sha512').update('immutable').digest('base64')}`;
  const lookup = async () => ({
    status: 200,
    body: { name: '@agentdomain/langchain-plugin', version: VERSION, dist: { integrity } },
  });
  await publishRelease({
    root,
    npmCli: 'npm',
    mode: 'bootstrap',
    env,
    lookup,
    run: () => {
      throw Error('must not publish');
    },
  });
  writeFileSync(join(root, `packages/agentdomain-langchain-plugin-${VERSION}.tgz`), 'changed');
  await assert.rejects(publishRelease({ root, npmCli: 'npm', mode: 'bootstrap', env, lookup }));
});
test('wrong source context refuses before lookup', async (t) => {
  for (const patch of [
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_REPOSITORY: 'someone/AgentDomain' },
    { GITHUB_REPOSITORY_ID: '42' },
    { GITHUB_REPOSITORY_OWNER_ID: '42' },
    { GITHUB_ACTOR_ID: '42' },
    { GITHUB_SHA: 'unqualified' },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
    { ACTIONS_ID_TOKEN_REQUEST_URL: '' },
    {
      GITHUB_REPOSITORY: 'Talvono/AgentDomain',
      GITHUB_REPOSITORY_OWNER: 'Talvono',
      GITHUB_REPOSITORY_OWNER_ID: '342912183',
      GITHUB_WORKFLOW_REF: 'Talvono/AgentDomain/.github/workflows/publish-npm.yml@refs/heads/main',
      ACTIVE_RELEASE_OWNER: 'Talvono',
    },
  ]) {
    await assert.rejects(
      publishRelease({
        root: fixture(t),
        mode: 'bootstrap',
        env: { ...env, ...patch },
        lookup: () => {
          throw Error('must not lookup');
        },
      }),
      /NPM_RELEASE_REFUSED/,
    );
  }
});

test('reviewed policy flip refuses old-owner publication before registry lookup', async (t) => {
  const root = fixture(t);
  for (const file of ['npm-release.mjs', 'public-release-identity.mjs'])
    writeFileSync(join(root, file), readFileSync(new URL(`./${file}`, import.meta.url)));
  const policy = JSON.parse(readFileSync(new URL('./public-release-policy.json', import.meta.url)));
  writeFileSync(
    join(root, 'public-release-policy.json'),
    JSON.stringify({ ...policy, activeOwner: 'Talvono' }),
  );
  const flipped = await import(pathToFileURL(join(root, 'npm-release.mjs')).href);
  let lookups = 0;
  await assert.rejects(
    flipped.publishRelease({
      root,
      mode: 'oidc',
      env,
      lookup: () => {
        lookups++;
      },
    }),
    /NPM_RELEASE_REFUSED/,
  );
  assert.equal(lookups, 0);
  const future = {
    ...env,
    GITHUB_REPOSITORY: 'Talvono/AgentDomain',
    GITHUB_REPOSITORY_OWNER: 'Talvono',
    GITHUB_REPOSITORY_OWNER_ID: '342912183',
    GITHUB_WORKFLOW_REF: 'Talvono/AgentDomain/.github/workflows/publish-npm.yml@refs/heads/main',
  };
  let publications = 0;
  await flipped.publishRelease({
    root,
    npmCli: 'never-executed',
    mode: 'oidc',
    env: future,
    lookup: async () => ({ status: 404 }),
    run: async () => {
      publications++;
      return 0;
    },
  });
  assert.equal(publications, 5);
  assert.equal(flipped.publishEnvironment(future).NODE_AUTH_TOKEN, undefined);
});
test('both publishing workflows have no static-token fallback', () => {
  const npm = readFileSync(
    new URL('../.github/workflows/publish-npm.yml', import.meta.url),
    'utf8',
  );
  assert(!npm.includes('secrets.'));
  assert.match(npm, /npm_config_ignore_scripts: 'true'/);
  const python = readFileSync(
    new URL('../.github/workflows/publish-python.yml', import.meta.url),
    'utf8',
  );
  assert.match(python, /name: pypi-production/);
  assert.match(python, /attestations: true/);
  assert.match(python, /skip-existing: false/);
  assert(!python.includes('secrets.'));
  assert(python.indexOf('verify-release-ci.mjs') < python.indexOf('build-python --output'));
  assert(!python.split('\n  publish:')[1].includes('actions/checkout'));
});

test('npm stages the trusted identity helper and policy inside the sealed input inventory', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/publish-npm.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    workflow,
    /for script in npm-release\.mjs release-artifacts\.py public-release-identity\.mjs public-release-policy\.json; do/,
  );
  assert.match(workflow, /test "\$\(wc -l < "\$checksums"\)" -eq 12/);
  assert.match(workflow, /test "\$\(wc -l < "\$release_dir\/release\.sha256"\)" -eq 12/);
  const publish = workflow.split('\n  publish:')[1];
  assert.ok(
    publish.indexOf('sha256sum --check --strict release.sha256') <
      publish.indexOf('tooling/release-artifacts.py'),
  );
  assert.ok(
    publish.indexOf('sha256sum --check --strict release.sha256') <
      publish.indexOf('tooling/npm-release.mjs'),
  );
});

test('Python project choice never narrows validation or native integration tests', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/publish-python.yml', import.meta.url),
    'utf8',
  ).replaceAll('\r\n', '\n');
  assert.match(workflow, /^on:\n  workflow_dispatch:\n    inputs:\n      project:\n/m);
  const choice = workflow.match(/^      project:\n((?: {8}.+\n)+)/m)?.[1];
  assert.equal(typeof choice, 'string');
  assert.match(choice, /^        required: true$/m);
  assert.match(choice, /^        type: choice$/m);
  assert.match(choice, /^        default: all$/m);
  assert.deepEqual(
    [...choice.matchAll(/^          - (.+)$/gm)].map((match) => match[1]),
    ['all', 'agentdomain-crewai', 'agentdomain-autogen'],
  );

  const validation = workflow.split('\n  validate:\n')[1].split('\n  publish:\n')[0];
  assert.doesNotMatch(validation, /inputs\.project|PROJECT_TO_PUBLISH|--project/);
  assert.doesNotMatch(validation, /^ {6,}(?:if|continue-on-error):/m);
  assert.doesNotMatch(validation, /id-token: write/);
  assert.match(validation, /actions: read/);
  assert.match(
    validation,
    /release-manifest-sha256: \$\{\{ steps\.build\.outputs\.release-manifest-sha256 \}\}/,
  );
  assert.match(validation, /verifier-sha256: \$\{\{ steps\.build\.outputs\.verifier-sha256 \}\}/);
  const commands = [
    'node scripts/verify-release-ci.mjs',
    'python -B -m unittest discover -s scripts -p test_release_artifacts.py',
    'build-python --output "$RUNNER_TEMP/python-release"',
    'cp scripts/release-artifacts.py "$RUNNER_TEMP/python-release/verifier.py"',
    'AGENTDOMAIN_CREWAI_PYTHON="$RUNNER_TEMP/crewai/bin/python" node packages/mcp-server/test/crewai-integration.mjs',
    'AGENTDOMAIN_AUTOGEN_PYTHON="$RUNNER_TEMP/autogen/bin/python" node --test packages/mcp-server/test/autogen.integration.test.mjs',
    'uses: actions/upload-artifact@',
  ];
  let previous = -1;
  for (const command of commands) {
    const index = validation.indexOf(command);
    assert.ok(index > previous, `${command} must run unconditionally in validation order`);
    previous = index;
  }
});

test('Python publishing stages a fixed verified subset before the pinned OIDC action', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/publish-python.yml', import.meta.url),
    'utf8',
  ).replaceAll('\r\n', '\n');
  const validation = workflow.split('\n  validate:\n')[1].split('\n  publish:\n')[0];
  const publish = workflow.split('\n  publish:\n')[1];
  for (const job of [validation, publish]) {
    assert.match(job, /github\.repository_id == '1310051881'/);
    assert.match(job, /github\.actor_id == '113634586'/);
    assert.match(job, /github\.repository_owner_id == '342912183'/);
  }
  assert.match(publish, /needs\.validate\.outputs\.publication-authorized == 'true'/);
  assert.match(workflow, /^concurrency:\n  group: publish-python\n  cancel-in-progress: false$/m);
  assert.match(publish, /^    needs: validate$/m);
  assert.match(publish, /^    environment:\n      name: pypi-production$/m);
  assert.match(publish, /^    permissions:\n      contents: read\n      id-token: write$/m);
  assert.match(
    publish,
    /EXPECTED_RELEASE_MANIFEST_SHA256: \$\{\{ needs\.validate\.outputs\.release-manifest-sha256 \}\}/,
  );
  assert.match(
    publish,
    /EXPECTED_VERIFIER_SHA256: \$\{\{ needs\.validate\.outputs\.verifier-sha256 \}\}/,
  );
  assert.match(
    publish,
    /EXPECTED_POLICY_SHA256: \$\{\{ needs\.validate\.outputs\.policy-sha256 \}\}/,
  );
  assert.match(validation, /cp scripts\/public-release-policy\.json/);
  assert.match(validation, /policy-sha256=%s/);
  assert.ok(
    publish.indexOf('release-inputs/public-release-policy.json') <
      publish.indexOf('stage-python --output'),
  );
  assert.match(publish, /^          PROJECT_TO_PUBLISH: \$\{\{ inputs\.project \}\}$/m);
  assert.equal(workflow.split('${{ inputs.project }}').length - 1, 1);

  const command =
    'python -B release-inputs/verifier.py stage-python --output release-inputs --project "$PROJECT_TO_PUBLISH"';
  const steps = publish.split('\n      - ').slice(1);
  const stage = steps.find((step) => step.includes(command));
  assert.equal(typeof stage, 'string');
  const script = stage.split('\n        run: |\n')[1];
  assert.equal(typeof script, 'string');
  assert.doesNotMatch(script, /\$\{\{/);
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /\[\[ "\$EXPECTED_VERIFIER_SHA256" =~ \^\[0-9a-f\]\{64\}\$ \]\]/);
  const hashCheck = script.indexOf(
    'printf \'%s  release-inputs/verifier.py\\n\' "$EXPECTED_VERIFIER_SHA256" | sha256sum --check --status',
  );
  assert.ok(hashCheck >= 0 && script.indexOf(command) > hashCheck);
  assert.equal(steps.indexOf(stage), steps.length - 2);
  const upload = steps.at(-1);
  assert.match(
    upload,
    /^        uses: pypa\/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33 # release\/v1$/m,
  );
  assert.match(upload, /^          packages-dir: release-inputs\/publish-dist\/$/m);
  assert.match(upload, /^          attestations: true$/m);
  assert.match(upload, /^          skip-existing: false$/m);
  assert.match(upload, /^          print-hash: true$/m);
  assert.doesNotMatch(publish, /actions\/checkout|build-python|pip install|secrets\.|password:/);
  assert.doesNotMatch(publish, /^ {6,}(?:if|continue-on-error):/m);
});

function assertNativeInstallOrder(source) {
  assert(!source.includes('-r packages/mcp-server/examples/autogen/requirements.txt'));
  for (const [name, packageTest, nativeTest] of [
    [
      'crewai',
      'packages/mcp-server/test/crewai-package.py',
      'packages/mcp-server/test/crewai-integration.mjs',
    ],
    [
      'autogen',
      'packages/autogen-plugin/test/verify_artifacts.py',
      'packages/mcp-server/test/autogen.integration.test.mjs',
    ],
  ]) {
    const dependency = `-r packages/mcp-server/examples/${name}/${name === 'crewai' ? 'requirements.lock' : 'framework-requirements.txt'}`;
    const wheel = `--no-deps --no-index --force-reinstall "$RUNNER_TEMP/python-release/dist/agentdomain_${name}-${VERSION}-py3-none-any.whl"`;
    const start = source.indexOf(dependency);
    const end = source.indexOf(nativeTest);
    assert.ok(start >= 0 && end > start, `${name}: dependencies and native check required`);
    const section = source.slice(start, end + nativeTest.length);
    let previous = -1;
    for (const command of [
      dependency,
      wheel,
      '-m pip check',
      '-I -c',
      `find_spec("agentdomain_${name}")`,
      'is_relative_to',
      packageTest,
      nativeTest,
    ]) {
      const index = section.indexOf(command);
      assert.ok(index > previous, `${name}: ${command} must retain its qualification order`);
      previous = index;
    }
  }
  for (const command of ['--no-deps --no-index --force-reinstall', '-m pip check', 'find_spec('])
    assert.equal(source.split(command).length - 1, 2, command);
}

function nativeInstallSources() {
  const workflow = readFileSync(
    new URL('../.github/workflows/public-ci.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /^        run: node scripts\/public-ci-postbuild\.mjs$/m);
  assert.match(
    workflow,
    /^          PUBLIC_CI_POSTBUILD_SCOPE: \$\{\{ steps\.public-scope\.outputs\.scope \}\}$/m,
  );
  return [
    postbuildLanes('full').find(({ name }) => name === 'native-python').script,
    readFileSync(new URL('../.github/workflows/publish-python.yml', import.meta.url), 'utf8'),
  ];
}

test('first Python release installs framework dependencies before forcibly installing local wheels', () => {
  const input = readFileSync(
    new URL('../packages/mcp-server/examples/autogen/framework-requirements.txt', import.meta.url),
    'utf8',
  );
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert(lines.length > 0);
  for (const line of lines) {
    assert.match(
      line,
      /^(?:autogen-(?:agentchat|core|ext)(?:\[mcp\])?|mcp|pydantic)==[0-9]+\.[0-9]+\.[0-9]+$/,
    );
    assert(!line.includes('agentdomain'));
  }
  for (const source of nativeInstallSources()) assertNativeInstallOrder(source);
});

test('both native qualification paths reject missing or reordered framework, wheel and runtime checks', () => {
  for (const source of nativeInstallSources()) {
    for (const command of [
      'crewai/requirements.lock',
      'autogen/framework-requirements.txt',
      '--no-deps --no-index --force-reinstall',
      '-m pip check',
      'find_spec(',
      'is_relative_to',
      'crewai-package.py',
      'verify_artifacts.py',
      'crewai-integration.mjs',
      'autogen.integration.test.mjs',
    ])
      assert.throws(() => assertNativeInstallOrder(source.replaceAll(command, '')));
    const dependency = '-r packages/mcp-server/examples/autogen/framework-requirements.txt';
    const wheel = `--no-deps --no-index --force-reinstall "$RUNNER_TEMP/python-release/dist/agentdomain_autogen-${VERSION}-py3-none-any.whl"`;
    const reordered = source
      .replace(dependency, 'DEPENDENCY_PLACEHOLDER')
      .replace(wheel, dependency)
      .replace('DEPENDENCY_PLACEHOLDER', wheel);
    assert.throws(() => assertNativeInstallOrder(reordered));
  }
});
