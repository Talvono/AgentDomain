import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parsers } from 'prettier/plugins/yaml';
import { CLEANUP_GRACE_MS, main, postbuildLanes, superviseLanes } from './public-ci-postbuild.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const linux = { skip: process.platform !== 'linux' };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentdomain-public-postbuild-'));
  t.after(() => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  const output = new PassThrough();
  let log = '';
  output.on('data', (chunk) => {
    log += chunk;
  });
  const signals = new EventEmitter();
  return {
    directory,
    signals,
    output,
    log: () => log,
    options: {
      runnerTemp: directory,
      cwd: ROOT,
      env: { ...process.env, PROOF_ROOT: directory },
      output,
      signals,
      graceMs: 50,
    },
  };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('offline process fixture did not settle');
}

async function stopped(pid) {
  await until(() => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return ['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  });
}

function clean(f) {
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  assert.equal(f.signals.listenerCount('SIGINT'), 0);
  assert.equal(
    readdirSync(f.directory).some((name) => name.startsWith('public-ci-postbuild-')),
    false,
  );
}

test('routing is fixed at two post-build lanes and never accepts unknown scope', () => {
  assert.deepEqual(
    postbuildLanes('full').map(({ name }) => name),
    ['web', 'native-python'],
  );
  assert.deepEqual(
    postbuildLanes('frontend').map(({ name }) => name),
    ['web'],
  );
  assert.deepEqual(postbuildLanes('docs'), []);
  for (const scope of [undefined, '', 'unknown', 'native-python', '--skip-web'])
    assert.throws(() => postbuildLanes(scope));
  assert.equal(CLEANUP_GRACE_MS, 5_000);
});

function verifyCommands(lanes) {
  const [web, native] = lanes.map(({ script }) => script);
  for (const line of [
    'https://registry.npmjs.org/playwright-core/-/playwright-core-1.62.1.tgz',
    'c0f612c0404963d187ada2125eacaab71d276b42e93b75c45fb8cd0e19ed6dec7bb73512ee42e766c3a516bb85241e078bfae10cc8d71aa1dec0367af2761957',
    'sha512sum --check --status',
    'AGENTDOMAIN_TEST_BROWSER_EXECUTABLE="$browser" node apps/frontend/test/siwe-auth.browser.mjs "$tools/package"',
    'pnpm --dir apps/frontend exec opennextjs-cloudflare preview --env preview --ip 127.0.0.1 --port 8790',
    'node apps/frontend/test/footer-routes.smoke.mjs http://127.0.0.1:8790',
    'for attempt in $(seq 1 60)',
    'curl --fail --silent --max-time 2 --output /dev/null http://127.0.0.1:8790/terms',
    'trap cleanup_worker EXIT',
  ])
    assert.equal(web.split(line).length - 1, 1, line);
  for (const line of [
    'python -m venv "$RUNNER_TEMP/python-build"',
    '"$RUNNER_TEMP/python-build/bin/python" -m pip install --disable-pip-version-check --require-hashes -r scripts/python-build-requirements.lock',
    '"$RUNNER_TEMP/python-build/bin/python" scripts/release-artifacts.py build-python --output "$RUNNER_TEMP/python-release"',
    'UV_VERSION=0.11.33',
    'UV_LINUX_X64_SHA256=aa9fca823c03289fb6e3460b3dc864f3ea895cafaf9b99247701a67b17d1b018',
    'https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz',
    'sha256sum --check --status',
    '--strip-components=1 uv-x86_64-unknown-linux-gnu/uv',
    '"$install_dir/uv" --version',
    'export PATH="$install_dir:$PATH"',
    'export OTEL_SDK_DISABLED=true CREWAI_TELEMETRY_DISABLED=true CREWAI_TRACING_ENABLED=false PYTHONDONTWRITEBYTECODE=1',
    'python -m venv "$RUNNER_TEMP/agentdomain-crewai"',
    'uv --no-config --no-cache --no-python-downloads pip install --python "$RUNNER_TEMP/agentdomain-crewai/bin/python" --require-hashes --no-build -r packages/mcp-server/examples/crewai/requirements.lock',
    '"$RUNNER_TEMP/agentdomain-crewai/bin/python" -m pip install --no-deps --no-index --force-reinstall "$RUNNER_TEMP/python-release/dist/agentdomain_crewai-0.11.0-py3-none-any.whl"',
    '"$RUNNER_TEMP/agentdomain-crewai/bin/python" -m pip check',
    '"$RUNNER_TEMP/agentdomain-crewai/bin/python" -I -c',
    'importlib.metadata.version("agentdomain-crewai") == "0.11.0"',
    'Path(importlib.util.find_spec("agentdomain_crewai").origin).resolve().is_relative_to(Path(sysconfig.get_path("purelib")).resolve())',
    '"$RUNNER_TEMP/agentdomain-crewai/bin/python" packages/mcp-server/test/crewai-package.py --dist "$RUNNER_TEMP/python-release/dist" -v',
    'AGENTDOMAIN_CREWAI_PYTHON="$RUNNER_TEMP/agentdomain-crewai/bin/python" node packages/mcp-server/test/crewai-integration.mjs',
    'python -m venv "$RUNNER_TEMP/agentdomain-autogen"',
    '"$RUNNER_TEMP/agentdomain-autogen/bin/python" -m pip install --disable-pip-version-check -r packages/mcp-server/examples/autogen/framework-requirements.txt -c packages/mcp-server/examples/autogen/constraints.txt',
    '"$RUNNER_TEMP/agentdomain-autogen/bin/python" -m pip install --no-deps --no-index --force-reinstall "$RUNNER_TEMP/python-release/dist/agentdomain_autogen-0.11.0-py3-none-any.whl"',
    '"$RUNNER_TEMP/agentdomain-autogen/bin/python" -m pip check',
    '"$RUNNER_TEMP/agentdomain-autogen/bin/python" -I -c',
    'importlib.metadata.version("agentdomain-autogen") == "0.11.0"',
    'Path(importlib.util.find_spec("agentdomain_autogen").origin).resolve().is_relative_to(Path(sysconfig.get_path("purelib")).resolve())',
    '"$RUNNER_TEMP/agentdomain-autogen/bin/python" packages/autogen-plugin/test/verify_artifacts.py "$RUNNER_TEMP/python-release/dist"',
    'AGENTDOMAIN_AUTOGEN_PYTHON="$RUNNER_TEMP/agentdomain-autogen/bin/python" node --test packages/mcp-server/test/autogen.integration.test.mjs',
  ])
    assert.equal(native.split(line).length - 1, 1, line);
  for (const script of [web, native]) {
    assert.equal(script.split('--connect-timeout 10 --max-time 60 --retry 0').length - 1, 1);
    assert.doesNotMatch(
      script,
      /--no-verify|--no-check|--ignore-requires-python|GITHUB_OUTPUT|Full public qualification passed/,
    );
  }
  for (const [script, commands] of [
    [
      web,
      [
        'sha512sum --check --status',
        'tar -xzf',
        'siwe-auth.browser.mjs',
        'opennextjs-cloudflare preview',
        'footer-routes.smoke.mjs',
      ],
    ],
    [
      native,
      [
        'scripts/release-artifacts.py build-python',
        'sha256sum --check --status',
        'tar -xzf',
        '"$install_dir/uv" --version',
        'uv --no-config --no-cache --no-python-downloads pip install',
        'agentdomain_crewai-0.11.0-py3-none-any.whl',
        '"$RUNNER_TEMP/agentdomain-crewai/bin/python" -m pip check',
        '"$RUNNER_TEMP/agentdomain-crewai/bin/python" -I -c',
        'crewai-package.py',
        'crewai-integration.mjs',
        'python -m venv "$RUNNER_TEMP/agentdomain-autogen"',
        'agentdomain_autogen-0.11.0-py3-none-any.whl',
        '"$RUNNER_TEMP/agentdomain-autogen/bin/python" -m pip check',
        '"$RUNNER_TEMP/agentdomain-autogen/bin/python" -I -c',
        'packages/autogen-plugin/test/verify_artifacts.py',
        'autogen.integration.test.mjs',
      ],
    ],
  ]) {
    const positions = commands.map((command) => script.indexOf(command));
    assert.ok(positions.every((position) => position >= 0));
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
    );
  }
}

test('every pinned browser, wheel, dependency, origin and native check remains mandatory', () => {
  verifyCommands(postbuildLanes('full'));
});

test('both unchanged command sequences parse as strict Bash without executing tools', linux, () => {
  for (const { script } of postbuildLanes('full')) {
    const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('command checks reject checksum, locked installation, origin, native and footer omissions', () => {
  for (const remove of [
    'sha512sum --check --status',
    'sha256sum --check --status',
    '--require-hashes --no-build',
    '-m pip check',
    '-I -c',
    'is_relative_to',
    'crewai-integration.mjs',
    'autogen.integration.test.mjs',
    'footer-routes.smoke.mjs',
  ]) {
    const changed = postbuildLanes('full').map((lane) => ({
      ...lane,
      script: lane.script.replaceAll(remove, ''),
    }));
    assert.throws(() => verifyCommands(changed), remove);
  }
  const reordered = postbuildLanes('full');
  reordered[0].script = reordered[0].script
    .replace('sha512sum --check --status', 'CHECKSUM_PLACEHOLDER')
    .replace('tar -xzf', 'sha512sum --check --status')
    .replace('CHECKSUM_PLACEHOLDER', 'tar -xzf');
  assert.throws(() => verifyCommands(reordered));
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

test('one Public CI job qualifies selected lanes before the unchanged full-marker identity', () => {
  const source = readFileSync(
    new URL('../.github/workflows/public-ci.yml', import.meta.url),
    'utf8',
  );
  const document = parsers.yaml.parse(source).children[0];
  const workflow = yamlValue(document.children.find(({ type }) => type === 'documentBody'));
  assert.deepEqual(Object.keys(workflow.jobs), ['verify']);
  const { steps } = workflow.jobs.verify;
  const scope = steps.findIndex((step) => step.id === 'public-scope');
  const guards = steps.findIndex((step) => step.name === 'Test release and routing guards');
  const lanes = steps.filter((step) => step.id === 'public-postbuild');
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].run, 'node scripts/public-ci-postbuild.mjs');
  assert.deepEqual(lanes[0].env, {
    PUBLIC_CI_POSTBUILD_SCOPE: '${{ steps.public-scope.outputs.scope }}',
  });
  assert.equal(lanes[0].if, undefined);
  assert.ok(scope >= 0 && guards > scope && steps.indexOf(lanes[0]) > guards);
  assert.ok(steps[guards].run.includes('node --test scripts/public-ci-postbuild.test.mjs'));
  for (const step of steps) assert.equal(step['continue-on-error'], undefined);
  const marker = steps.at(-1);
  assert.equal(marker.name, 'Full Public Qualification (agentdomain.public-ci.full.v1)');
  assert.equal(
    marker.if,
    "steps.public-scope.outputs.scope == 'full' && steps.public-postbuild.outputs.complete == 'true'",
  );
  assert.equal(marker.run, 'echo "Full public qualification passed for $GITHUB_SHA."');
  const expression = marker.if
    .replaceAll('steps.public-scope', "steps['public-scope']")
    .replaceAll('steps.public-postbuild', "steps['public-postbuild']");
  for (const scope of ['full', 'frontend', 'docs', undefined, 'unknown']) {
    for (const complete of ['true', 'false', undefined]) {
      const result = Function(
        'steps',
        `return (${expression})`,
      )({ 'public-scope': { outputs: { scope } }, 'public-postbuild': { outputs: { complete } } });
      assert.equal(result, scope === 'full' && complete === 'true');
    }
  }
});

test('invalid CLI selectors never start commands or write a completion marker', async (t) => {
  const f = fixture(t);
  const env = { RUNNER_TEMP: f.directory, GITHUB_OUTPUT: join(f.directory, 'output') };
  await assert.rejects(main(['--skip-web'], { ...env, PUBLIC_CI_POSTBUILD_SCOPE: 'full' }));
  await assert.rejects(main([], { ...env, PUBLIC_CI_POSTBUILD_SCOPE: 'unknown' }));
  assert.equal(existsSync(env.GITHUB_OUTPUT), false);
  assert.deepEqual(readdirSync(f.directory), []);
});

test('completion output is written only after every selected lane and cleanup succeed', async (t) => {
  const f = fixture(t);
  for (const scope of ['full', 'frontend', 'docs']) {
    const output = join(f.directory, `${scope}-output`);
    const env = {
      RUNNER_TEMP: f.directory,
      PUBLIC_CI_POSTBUILD_SCOPE: scope,
      GITHUB_OUTPUT: output,
    };
    await assert.rejects(
      main([], env, async (lanes) => {
        assert.deepEqual(lanes, postbuildLanes(scope));
        throw new Error('fixture lane or cleanup failed');
      }),
      /fixture lane or cleanup failed/,
    );
    assert.equal(existsSync(output), false);
    await main([], env, async (lanes) => {
      assert.equal(existsSync(output), false);
      assert.deepEqual(lanes, postbuildLanes(scope));
    });
    assert.equal(readFileSync(output, 'utf8'), 'complete=true\n');
  }
});

test(
  'two actual Bash lanes overlap with distinct temps/logs and leave no background process',
  linux,
  async (t) => {
    const f = fixture(t);
    const lanes = ['web', 'native-python'].map((name) => ({
      name,
      script: `printf '%s' "$RUNNER_TEMP" > "$PROOF_ROOT/${name}-temp"\nprintf '%s' "$TMPDIR" > "$PROOF_ROOT/${name}-tmp"\nprintf '%s' started > "$PROOF_ROOT/${name}-start"\nfor attempt in $(seq 1 100); do\n if [ -f "$PROOF_ROOT/web-start" ] && [ -f "$PROOF_ROOT/native-python-start" ]; then break; fi\n sleep 0.01\ndone\ntest -f "$PROOF_ROOT/web-start"\ntest -f "$PROOF_ROOT/native-python-start"\nsleep 60 &\nprintf '%s' "$!" > "$PROOF_ROOT/${name}-pid"\nprintf '%s' '${name}-log'`,
    }));
    assert.deepEqual(await superviseLanes(lanes, f.options), ['web', 'native-python']);
    const [web, native] = lanes.map(({ name }) =>
      readFileSync(join(f.directory, `${name}-temp`), 'utf8'),
    );
    assert.notEqual(web, native);
    for (const lane of lanes) {
      const temp = readFileSync(join(f.directory, `${lane.name}-temp`), 'utf8');
      assert.equal(readFileSync(join(f.directory, `${lane.name}-tmp`), 'utf8'), join(temp, 'tmp'));
      assert.equal(existsSync(temp), false);
      await stopped(Number(readFileSync(join(f.directory, `${lane.name}-pid`), 'utf8')));
      assert.ok(f.log().includes(`${lane.name}-log`));
    }
    clean(f);
  },
);

test(
  'failed native gate cancels and reaps the other lane without successful completion',
  linux,
  async (t) => {
    const f = fixture(t);
    const promise = superviseLanes(
      [
        { name: 'web', script: 'sleep 60 &\nprintf "%s" "$!" > "$PROOF_ROOT/web-pid"\nwait' },
        {
          name: 'native-python',
          script:
            'for attempt in $(seq 1 100); do [ -f "$PROOF_ROOT/web-pid" ] && break; sleep 0.01; done\nexit 7',
        },
      ],
      f.options,
    );
    await assert.rejects(promise, (error) => error.exitCode === 7);
    await stopped(Number(readFileSync(join(f.directory, 'web-pid'), 'utf8')));
    clean(f);
  },
);

test(
  'a finished web lane removes its worker before the native lane completes',
  linux,
  async (t) => {
    const f = fixture(t);
    let completed = false;
    const promise = superviseLanes(
      [
        { name: 'web', script: 'sleep 60 &\nprintf "%s" "$!" > "$PROOF_ROOT/web-pid"' },
        {
          name: 'native-python',
          script: 'while [ ! -f "$PROOF_ROOT/allow-native" ]; do sleep 0.01; done',
        },
      ],
      f.options,
    ).then(() => {
      completed = true;
    });
    try {
      await until(() => existsSync(join(f.directory, 'web-pid')));
      await stopped(Number(readFileSync(join(f.directory, 'web-pid'), 'utf8')));
      assert.equal(completed, false);
    } finally {
      writeFileSync(join(f.directory, 'allow-native'), 'ready');
      await promise;
    }
    clean(f);
  },
);

for (const signal of ['SIGTERM', 'SIGINT'])
  test(
    `${signal} cancellation forcibly cleans a resistant descendant and both lane groups`,
    linux,
    async (t) => {
      const f = fixture(t);
      const script =
        'bash -c \'trap "" TERM INT; printf "%s" "$BASHPID" > "$PROOF_ROOT/resistant-pid"; while :; do sleep 1; done\' &\nwait';
      const promise = superviseLanes(
        [
          { name: 'web', script },
          {
            name: 'native-python',
            script: 'sleep 60 &\nprintf "%s" "$!" > "$PROOF_ROOT/native-pid"\nwait',
          },
        ],
        f.options,
      );
      const rejection = assert.rejects(
        promise,
        (error) => error.exitCode === (signal === 'SIGTERM' ? 143 : 130),
      );
      await until(
        () =>
          existsSync(join(f.directory, 'resistant-pid')) &&
          existsSync(join(f.directory, 'native-pid')),
      );
      f.signals.emit(signal);
      await rejection;
      for (const name of ['resistant', 'native'])
        await stopped(Number(readFileSync(join(f.directory, `${name}-pid`), 'utf8')));
      clean(f);
    },
  );

test(
  'cancellation lets a browser-like launcher clean its detached service before group escalation',
  linux,
  async (t) => {
    const f = fixture(t);
    let pid;
    let serviceStopped = false;
    const script = String.raw`
"$PROOF_NODE" --input-type=module -e '
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
process.on("SIGTERM", () => setTimeout(() => { process.kill(-child.pid, "SIGKILL"); process.exit(143); }, 30));
writeFileSync(process.env.PROOF_ROOT + "/detached-pid", String(child.pid));
setInterval(() => {}, 1000);
'
`;
    t.after(() => {
      if (serviceStopped || !Number.isInteger(pid)) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    });
    const promise = superviseLanes([{ name: 'web', script }], {
      ...f.options,
      env: { ...f.options.env, PROOF_NODE: process.execPath },
      graceMs: 500,
    });
    const rejection = assert.rejects(promise, (error) => error.exitCode === 143);
    await until(() => existsSync(join(f.directory, 'detached-pid')));
    pid = Number(readFileSync(join(f.directory, 'detached-pid'), 'utf8'));
    f.signals.emit('SIGTERM');
    await rejection;
    await stopped(pid);
    serviceStopped = true;
    clean(f);
  },
);

test(
  'docs completes without spawning a lane and removes its temporary directory',
  linux,
  async (t) => {
    const f = fixture(t);
    const output = join(f.directory, 'github-output');
    await main([], {
      ...process.env,
      RUNNER_TEMP: f.directory,
      PUBLIC_CI_POSTBUILD_SCOPE: 'docs',
      GITHUB_OUTPUT: output,
    });
    assert.equal(readFileSync(output, 'utf8'), 'complete=true\n');
    clean(f);
  },
);

test('a partial launch failure still terminates the already-started lane', linux, async (t) => {
  const f = fixture(t);
  let child;
  let launches = 0;
  await assert.rejects(
    superviseLanes(
      [
        { name: 'web', script: 'sleep 60' },
        { name: 'native-python', script: 'exit 0' },
      ],
      {
        ...f.options,
        spawnLane(...args) {
          if (++launches === 2) throw new Error('fixture spawn failure');
          child = spawn(...args);
          return child;
        },
      },
    ),
    /fixture spawn failure/,
  );
  assert.equal(launches, 2);
  await stopped(child.pid);
  clean(f);
});

test('native frameworks use two same-group subshells and check both explicit wait statuses', () => {
  const native = postbuildLanes('full')[1].script;
  assert.equal(native.split(') &').length - 1, 2);
  assert.ok(native.includes('set +m\n(\nexport OTEL_SDK_DISABLED=true'));
  assert.ok(native.includes('crewai_pid=$!'));
  assert.ok(native.includes('autogen_pid=$!'));
  assert.ok(
    native.includes('if wait "$crewai_pid"; then\n  crewai_status=0\nelse\n  crewai_status=$?\nfi'),
  );
  assert.ok(
    native.includes(
      'if wait "$autogen_pid"; then\n  autogen_status=0\nelse\n  autogen_status=$?\nfi',
    ),
  );
  assert.ok(
    native.includes(
      'if [ "$crewai_status" -ne 0 ]; then\n  exit "$crewai_status"\nfi\nexit "$autogen_status"',
    ),
  );
  assert.ok(
    native.includes(
      'unset CREWAI_TELEMETRY_DISABLED CREWAI_TRACING_ENABLED\nexport OTEL_SDK_DISABLED=true PYTHONDONTWRITEBYTECODE=1',
    ),
  );
  assert.ok(native.indexOf('"$install_dir/uv" --version') < native.indexOf('crewai_pid=$!'));
  assert.doesNotMatch(native, /setsid|set -m|wait\s*(?:\n|$)|wait\s+-n/);
});

const mockWrapper = '#!/bin/sh\nexec "$PROOF_NODE" "$PROOF_TOOL" "$0" "$@"\n';
const mockTool = String.raw`
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const tool = process.argv[2];
const role = basename(tool);
const args = process.argv.slice(3);
const proof = process.env.PROOF_ROOT;
const wrapper = readFileSync(process.env.PROOF_WRAPPER, 'utf8');
const framework = basename(dirname(dirname(tool))).replace('agentdomain-', '');
const group = Number(readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ')[2]);
const env = Object.fromEntries(['OTEL_SDK_DISABLED', 'CREWAI_TELEMETRY_DISABLED', 'CREWAI_TRACING_ENABLED', 'PYTHONDONTWRITEBYTECODE'].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
const record = (phase, owner = framework) => appendFileSync(join(proof, 'calls.jsonl'), JSON.stringify({ role, phase, owner, args, env, pid: process.pid, parent: process.ppid, group, path: tool }) + '\n');
const awaitPeer = async () => {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (['crewai', 'autogen'].every((name) => existsSync(join(proof, name + '-start')))) return;
    await delay(5);
  }
  throw new Error('Frameworks did not overlap');
};
if (role === 'python' && args[0] === '-m' && args[1] === 'venv') {
  const target = args[2];
  const owner = basename(target).replace('agentdomain-', '');
  mkdirSync(join(target, 'bin'), { recursive: true });
  writeFileSync(join(target, 'bin/python'), wrapper, { mode: 0o755 });
  record('venv', owner);
  if (['crewai', 'autogen'].includes(owner)) {
    assert.ok(existsSync(join(proof, 'wheel-ready')));
    assert.ok(existsSync(join(proof, 'uv-ready')));
    writeFileSync(join(proof, owner + '-start'), JSON.stringify({ shell: process.ppid, group, venv: target }));
    await awaitPeer();
    if (process.env.PROOF_HOLD === 'true') {
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(join(proof, owner + '-descendant'), String(child.pid));
      process.on('SIGTERM', () => {});
      while (true) await delay(1000);
    }
  }
} else if (role === 'python' && args.includes('build-python')) {
  const output = args[args.indexOf('--output') + 1];
  mkdirSync(join(output, 'dist'), { recursive: true });
  for (const name of ['crewai', 'autogen']) writeFileSync(join(output, 'dist/agentdomain_' + name + '-0.11.0-py3-none-any.whl'), 'fixture-wheel-' + name);
  writeFileSync(join(proof, 'wheel-ready'), output);
  record('wheel-build', 'setup');
} else if (role === 'tar') {
  const target = args[args.indexOf('-C') + 1];
  writeFileSync(join(target, 'uv'), wrapper, { mode: 0o755 });
  record('extract', 'setup');
} else if (role === 'uv' && args[0] === '--version') {
  writeFileSync(join(proof, 'uv-ready'), 'verified');
  record('uv-version', 'setup');
} else if (role === 'curl' || role === 'sha256sum') {
  record(role, 'setup');
  if (role === 'sha256sum' && process.env.PROOF_FAIL_SETUP === 'true') process.exit(19);
} else if (role === 'uv') {
  assert.ok(existsSync(args[args.indexOf('--python') + 1]));
  record('dependencies', 'crewai');
} else if (role === 'python') {
  if (args[0] === '-m' && args[1] === 'pip' && args[2] === 'check') {
    record('pip-check');
    if ([framework, 'both'].includes(process.env.PROOF_FAIL_FRAMEWORK)) process.exit(framework === 'crewai' ? 11 : 17);
  } else if (args[0] === '-I') record('installed-origin');
  else if (args[0] === '-m' && args[1] === 'pip') {
    if (args.at(-1).endsWith('.whl')) assert.ok(existsSync(args.at(-1)));
    record('install');
  } else record('artifact-check');
} else if (role === 'node') {
  const owner = args.at(-1).includes('crewai') ? 'crewai' : 'autogen';
  record('complete', owner);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  child.unref();
  writeFileSync(join(proof, owner + '-descendant'), String(child.pid));
} else throw new Error('Unexpected mocked tool: ' + role);
`;

function nativeFixture(t, overrides = {}) {
  const f = fixture(t);
  const bin = join(f.directory, 'bin');
  mkdirSync(bin);
  const wrapper = join(f.directory, 'wrapper');
  const tool = join(f.directory, 'mock-tool.mjs');
  writeFileSync(wrapper, mockWrapper, { mode: 0o755 });
  writeFileSync(tool, mockTool);
  for (const name of ['python', 'node', 'curl', 'sha256sum', 'tar'])
    writeFileSync(join(bin, name), mockWrapper, { mode: 0o755 });
  const groups = [];
  t.after(async () => {
    for (const group of groups) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await stopped(group);
    }
  });
  const options = {
    ...f.options,
    env: {
      ...f.options.env,
      PATH: `${bin}:${process.env.PATH}`,
      PROOF_NODE: process.execPath,
      PROOF_TOOL: tool,
      PROOF_WRAPPER: wrapper,
      OTEL_SDK_DISABLED: 'fixture-parent',
      CREWAI_TELEMETRY_DISABLED: 'fixture-parent',
      CREWAI_TRACING_ENABLED: 'fixture-parent',
      PYTHONDONTWRITEBYTECODE: 'fixture-parent',
      ...overrides,
    },
    spawnLane(...args) {
      const child = spawn(...args);
      groups.push(child.pid);
      return child;
    },
  };
  return {
    ...f,
    groups,
    options,
    calls: () =>
      readFileSync(join(f.directory, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    run: () =>
      main(
        [],
        {
          PUBLIC_CI_POSTBUILD_SCOPE: 'full',
          GITHUB_OUTPUT: join(f.directory, 'github-output'),
        },
        (lanes) =>
          superviseLanes(
            [
              {
                name: 'web',
                script: 'sleep 60 &\nprintf "%s" "$!" > "$PROOF_ROOT/web-descendant"',
              },
              lanes[1],
            ],
            options,
          ),
      ),
  };
}

async function nativeStopped(f) {
  for (const pid of f.groups) await stopped(pid);
  for (const name of ['web', 'crewai', 'autogen']) {
    const path = join(f.directory, `${name}-descendant`);
    if (existsSync(path)) await stopped(Number(readFileSync(path, 'utf8')));
  }
  for (const name of ['crewai', 'autogen']) {
    const path = join(f.directory, `${name}-start`);
    if (existsSync(path)) await stopped(JSON.parse(readFileSync(path, 'utf8')).shell);
  }
  clean(f);
}

for (const failure of [undefined, 'crewai', 'autogen', 'both'])
  test(
    `actual native shell overlaps isolated frameworks and preserves ${failure ?? 'success'} status`,
    linux,
    async (t) => {
      const f = nativeFixture(t, { PROOF_FAIL_FRAMEWORK: failure ?? '' });
      if (failure)
        await assert.rejects(
          f.run(),
          (error) => error.exitCode === (failure === 'autogen' ? 17 : 11),
        );
      else await f.run();
      assert.equal(f.groups.length, 2);
      assert.notEqual(f.groups[0], f.groups[1]);
      const calls = f.calls();
      for (const phase of ['wheel-build', 'curl', 'sha256sum', 'extract', 'uv-version'])
        assert.equal(calls.filter((call) => call.phase === phase).length, 1, phase);
      const starts = ['crewai', 'autogen'].map((name) =>
        JSON.parse(readFileSync(join(f.directory, `${name}-start`), 'utf8')),
      );
      assert.notEqual(starts[0].shell, starts[1].shell);
      assert.notEqual(starts[0].venv, starts[1].venv);
      for (const start of starts) assert.equal(start.group, f.groups[1]);
      for (const name of ['crewai', 'autogen']) {
        const framework = calls.filter((call) => call.owner === name);
        assert.ok(framework.length > 0);
        for (const call of framework) {
          assert.equal(call.group, f.groups[1]);
          assert.equal(call.env.OTEL_SDK_DISABLED, 'true');
          assert.equal(call.env.PYTHONDONTWRITEBYTECODE, '1');
          assert.equal(call.env.CREWAI_TELEMETRY_DISABLED, name === 'crewai' ? 'true' : undefined);
          assert.equal(call.env.CREWAI_TRACING_ENABLED, name === 'crewai' ? 'false' : undefined);
        }
        const failed = failure === name || failure === 'both';
        assert.equal(framework.filter((call) => call.phase === 'complete').length, failed ? 0 : 1);
        assert.equal(
          framework.filter((call) => call.phase === 'installed-origin').length,
          failed ? 0 : 1,
        );
      }
      assert.equal(existsSync(join(f.directory, 'github-output')), !failure);
      if (!failure)
        assert.equal(readFileSync(join(f.directory, 'github-output'), 'utf8'), 'complete=true\n');
      await nativeStopped(f);
    },
  );

test(
  'failed common checksum setup never launches either framework or emits completion',
  linux,
  async (t) => {
    const f = nativeFixture(t, { PROOF_FAIL_SETUP: 'true' });
    await assert.rejects(f.run(), (error) => error.exitCode === 19);
    assert.equal(
      f.calls().some((call) => ['crewai', 'autogen'].includes(call.owner)),
      false,
    );
    assert.equal(existsSync(join(f.directory, 'github-output')), false);
    await nativeStopped(f);
  },
);

for (const signal of ['SIGTERM', 'SIGINT'])
  test(
    `${signal} cancellation kills both framework descendants in the original native group`,
    linux,
    async (t) => {
      const f = nativeFixture(t, { PROOF_HOLD: 'true' });
      const rejection = assert.rejects(
        f.run(),
        (error) => error.exitCode === (signal === 'SIGTERM' ? 143 : 130),
      );
      await until(() =>
        ['crewai', 'autogen'].every((name) => existsSync(join(f.directory, `${name}-descendant`))),
      );
      f.signals.emit(signal);
      await rejection;
      assert.equal(f.groups.length, 2);
      for (const name of ['crewai', 'autogen'])
        assert.equal(
          JSON.parse(readFileSync(join(f.directory, `${name}-start`), 'utf8')).group,
          f.groups[1],
        );
      assert.equal(existsSync(join(f.directory, 'github-output')), false);
      await nativeStopped(f);
    },
  );
