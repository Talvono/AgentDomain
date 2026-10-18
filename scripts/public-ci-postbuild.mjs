import { spawn } from 'node:child_process';
import {
  createReadStream,
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CLEANUP_GRACE_MS = 5_000;

const WEB = String.raw`
tools="$RUNNER_TEMP/siwe-browser-tools"
archive="$RUNNER_TEMP/playwright-core-1.62.1.tgz"
mkdir -p "$tools"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
  --connect-timeout 10 --max-time 60 --retry 0 \
  --output "$archive" https://registry.npmjs.org/playwright-core/-/playwright-core-1.62.1.tgz
printf '%s  %s\n' 'c0f612c0404963d187ada2125eacaab71d276b42e93b75c45fb8cd0e19ed6dec7bb73512ee42e766c3a516bb85241e078bfae10cc8d71aa1dec0367af2761957' "$archive" | sha512sum --check --status
tar -xzf "$archive" -C "$tools"
browser="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"
test -n "$browser"
AGENTDOMAIN_TEST_BROWSER_EXECUTABLE="$browser" node apps/frontend/test/siwe-auth.browser.mjs "$tools/package"

pnpm --dir apps/frontend exec opennextjs-cloudflare preview --env preview --ip 127.0.0.1 --port 8790 >"$RUNNER_TEMP/frontend-worker.log" 2>&1 &
worker_pid=$!
cleanup_worker() {
  kill "$worker_pid" 2>/dev/null || true
}
trap cleanup_worker EXIT
ready=false
for attempt in $(seq 1 60); do
  if curl --fail --silent --max-time 2 --output /dev/null http://127.0.0.1:8790/terms; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  cat "$RUNNER_TEMP/frontend-worker.log"
  exit 1
fi
node apps/frontend/test/footer-routes.smoke.mjs http://127.0.0.1:8790
`;

const NATIVE_PYTHON = String.raw`
RELEASE_VERSION="$(python -B scripts/release-artifacts.py source-version)"
python -m venv "$RUNNER_TEMP/python-build"
"$RUNNER_TEMP/python-build/bin/python" -m pip install --disable-pip-version-check --require-hashes -r scripts/python-build-requirements.lock
"$RUNNER_TEMP/python-build/bin/python" scripts/release-artifacts.py build-python --output "$RUNNER_TEMP/python-release"

UV_VERSION=0.11.33
UV_LINUX_X64_SHA256=aa9fca823c03289fb6e3460b3dc864f3ea895cafaf9b99247701a67b17d1b018
archive="$RUNNER_TEMP/uv-$UV_VERSION-linux-x64.tar.gz"
install_dir="$RUNNER_TEMP/uv-$UV_VERSION"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
  --connect-timeout 10 --max-time 60 --retry 0 \
  --output "$archive" "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz"
printf '%s  %s\n' "$UV_LINUX_X64_SHA256" "$archive" | sha256sum --check --status
mkdir -p "$install_dir"
tar -xzf "$archive" -C "$install_dir" --strip-components=1 uv-x86_64-unknown-linux-gnu/uv
chmod 0755 "$install_dir/uv"
"$install_dir/uv" --version
export PATH="$install_dir:$PATH"

# Keep both framework subshells in this lane's owned process group.
set +m
(
export OTEL_SDK_DISABLED=true CREWAI_TELEMETRY_DISABLED=true CREWAI_TRACING_ENABLED=false PYTHONDONTWRITEBYTECODE=1
python -m venv "$RUNNER_TEMP/agentdomain-crewai"
uv --no-config --no-cache --no-python-downloads pip install --python "$RUNNER_TEMP/agentdomain-crewai/bin/python" --require-hashes --no-build -r packages/mcp-server/examples/crewai/requirements.lock
"$RUNNER_TEMP/agentdomain-crewai/bin/python" -m pip install --no-deps --no-index --force-reinstall "$RUNNER_TEMP/python-release/dist/agentdomain_crewai-$RELEASE_VERSION-py3-none-any.whl"
"$RUNNER_TEMP/agentdomain-crewai/bin/python" -m pip check
"$RUNNER_TEMP/agentdomain-crewai/bin/python" -I -c 'import importlib.util, importlib.metadata, sys, sysconfig; from pathlib import Path; assert importlib.metadata.version("agentdomain-crewai") == sys.argv[1]; assert Path(importlib.util.find_spec("agentdomain_crewai").origin).resolve().is_relative_to(Path(sysconfig.get_path("purelib")).resolve())' "$RELEASE_VERSION"
"$RUNNER_TEMP/agentdomain-crewai/bin/python" packages/mcp-server/test/crewai-package.py --dist "$RUNNER_TEMP/python-release/dist" -v
AGENTDOMAIN_CREWAI_PYTHON="$RUNNER_TEMP/agentdomain-crewai/bin/python" node packages/mcp-server/test/crewai-integration.mjs
) &
crewai_pid=$!

(
unset CREWAI_TELEMETRY_DISABLED CREWAI_TRACING_ENABLED
export OTEL_SDK_DISABLED=true PYTHONDONTWRITEBYTECODE=1
python -m venv "$RUNNER_TEMP/agentdomain-autogen"
"$RUNNER_TEMP/agentdomain-autogen/bin/python" -m pip install --disable-pip-version-check -r packages/mcp-server/examples/autogen/framework-requirements.txt -c packages/mcp-server/examples/autogen/constraints.txt
"$RUNNER_TEMP/agentdomain-autogen/bin/python" -m pip install --no-deps --no-index --force-reinstall "$RUNNER_TEMP/python-release/dist/agentdomain_autogen-$RELEASE_VERSION-py3-none-any.whl"
"$RUNNER_TEMP/agentdomain-autogen/bin/python" -m pip check
"$RUNNER_TEMP/agentdomain-autogen/bin/python" -I -c 'import importlib.util, importlib.metadata, sys, sysconfig; from pathlib import Path; assert importlib.metadata.version("agentdomain-autogen") == sys.argv[1]; assert Path(importlib.util.find_spec("agentdomain_autogen").origin).resolve().is_relative_to(Path(sysconfig.get_path("purelib")).resolve())' "$RELEASE_VERSION"
"$RUNNER_TEMP/agentdomain-autogen/bin/python" packages/autogen-plugin/test/verify_artifacts.py "$RUNNER_TEMP/python-release/dist"
AGENTDOMAIN_AUTOGEN_PYTHON="$RUNNER_TEMP/agentdomain-autogen/bin/python" node --test packages/mcp-server/test/autogen.integration.test.mjs
) &
autogen_pid=$!

if wait "$crewai_pid"; then
  crewai_status=0
else
  crewai_status=$?
fi
if wait "$autogen_pid"; then
  autogen_status=0
else
  autogen_status=$?
fi
if [ "$crewai_status" -ne 0 ]; then
  exit "$crewai_status"
fi
exit "$autogen_status"
`;

export function postbuildLanes(scope) {
  if (scope === 'docs') return [];
  if (scope === 'frontend') return [{ name: 'web', script: WEB }];
  if (scope === 'full')
    return [
      { name: 'web', script: WEB },
      { name: 'native-python', script: NATIVE_PYTHON },
    ];
  throw new Error('Post-build scope must be full, frontend or docs');
}

async function printLog(path, output) {
  for await (const chunk of createReadStream(path)) {
    if (!output.write(chunk)) await new Promise((done) => output.once('drain', done));
  }
}

// Each Bash lane leads its own process group, including the preview worker.
// TERM gives browser cleanup handlers time to run; KILL also covers descendants
// whose launcher exited or ignored cancellation. No unrelated PID is signalled.
export async function superviseLanes(
  lanes,
  {
    runnerTemp,
    cwd = ROOT,
    env = process.env,
    signals = process,
    output = process.stdout,
    graceMs = CLEANUP_GRACE_MS,
    spawnLane = spawn,
  } = {},
) {
  const names = lanes.map(({ name }) => name);
  if (
    names.length > 2 ||
    new Set(names).size !== names.length ||
    names.some((name) => !['web', 'native-python'].includes(name))
  )
    throw new Error('Only the two fixed post-build lanes are allowed');
  if (process.platform !== 'linux') throw new Error('Post-build process groups require Linux');
  if (!runnerTemp || !isAbsolute(runnerTemp)) throw new Error('Absolute RUNNER_TEMP required');
  const parent = realpathSync(runnerTemp);
  const directory = mkdtempSync(join(parent, 'public-ci-postbuild-'));
  const children = [];
  let failure;
  let timer;
  const stopChild = (child, signal) => {
    if (!Number.isInteger(child.pid) || child.pid <= 1) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') failure ??= error;
    }
  };
  const stop = (signal) => {
    for (const { child } of children) stopChild(child, signal);
  };
  const fail = (error) => {
    failure ??= error;
    stop('SIGTERM');
    timer ??= setTimeout(() => stop('SIGKILL'), graceMs);
  };
  const onTerm = () =>
    fail(Object.assign(new Error('Post-build cancelled by SIGTERM'), { exitCode: 143 }));
  const onInt = () =>
    fail(Object.assign(new Error('Post-build cancelled by SIGINT'), { exitCode: 130 }));
  signals.on('SIGTERM', onTerm);
  signals.on('SIGINT', onInt);
  try {
    for (const lane of lanes) {
      if (failure) break;
      const temporary = join(directory, lane.name);
      mkdirSync(join(temporary, 'tmp'), { recursive: true, mode: 0o700 });
      const log = join(temporary, 'lane.log');
      const fd = openSync(log, 'wx', 0o600);
      let child;
      try {
        child = spawnLane(
          'bash',
          [
            '--noprofile',
            '--norc',
            '-e',
            '-u',
            '-o',
            'pipefail',
            '-c',
            `trap 'wait; exit 143' TERM\ntrap 'wait; exit 130' INT\n${lane.script}`,
          ],
          {
            cwd,
            detached: true,
            shell: false,
            env: {
              ...env,
              RUNNER_TEMP: temporary,
              TMPDIR: join(temporary, 'tmp'),
              TMP: join(temporary, 'tmp'),
              TEMP: join(temporary, 'tmp'),
            },
            stdio: ['ignore', fd, fd],
          },
        );
      } finally {
        closeSync(fd);
      }
      const done = new Promise((settled) => {
        child.once('error', (error) => {
          fail(error);
          settled();
        });
        child.once('close', (code, signal) => {
          if (code !== 0 || signal)
            fail(
              Object.assign(new Error(`${lane.name} failed (${signal ?? code})`), {
                exitCode: Number.isInteger(code) && code > 0 ? code : 1,
              }),
            );
          else stopChild(child, 'SIGKILL');
          settled();
        });
      });
      children.push({ child, done, log, name: lane.name });
    }
    await Promise.all(children.map(({ done }) => done));
    stop('SIGKILL');
    for (const child of children) {
      output.write(`\n--- Public CI post-build: ${child.name} ---\n`);
      await printLog(child.log, output);
    }
  } catch (error) {
    fail(error);
  } finally {
    clearTimeout(timer);
    stop('SIGKILL');
    await Promise.all(children.map(({ done }) => done));
    signals.removeListener('SIGTERM', onTerm);
    signals.removeListener('SIGINT', onInt);
    if (dirname(directory) !== parent) throw new Error('Unexpected post-build cleanup path');
    rmSync(directory, { recursive: true });
  }
  if (failure) throw failure;
  return names;
}

export async function main(argv = process.argv.slice(2), env = process.env, run = superviseLanes) {
  if (argv.length !== 0) throw new Error('Post-build accepts no caller-selected commands or flags');
  const lanes = postbuildLanes(env.PUBLIC_CI_POSTBUILD_SCOPE);
  await run(lanes, { runnerTemp: env.RUNNER_TEMP, env });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, 'complete=true\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  });
}
