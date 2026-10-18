import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseContext, releaseContext } from './public-release-identity.mjs';

export const PACKAGES = [
  'shared',
  'sdk',
  'mcp-server',
  'agentkit-plugin',
  'eliza-plugin',
  'langchain-plugin',
];
const fail = (reason = '') => {
  throw new Error(`NPM_RELEASE_REFUSED${reason ? `: ${reason}` : ''}`);
};

export function releaseRows(text) {
  const rows = text
    .trimEnd()
    .split('\n')
    .map((line) => line.split('\t'));
  if (rows.length !== PACKAGES.length) fail();
  const version = rows[0][1];
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version ?? '')) fail();
  rows.forEach((row, i) => {
    if (
      JSON.stringify(row) !==
      JSON.stringify([
        `@agentdomain/${PACKAGES[i]}`,
        version,
        `packages/agentdomain-${PACKAGES[i]}-${version}.tgz`,
      ])
    )
      fail();
  });
  return rows;
}

export function publishEnvironment(base) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (
      /token|password|npm_config_.*auth/i.test(key) &&
      !['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'].includes(key)
    )
      delete env[key];
  }
  env.NPM_CONFIG_IGNORE_SCRIPTS = 'true';
  env.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/';
  env.NPM_CONFIG_FETCH_RETRIES = '0';
  return env;
}

export async function publishRelease({ root, npmCli, mode = 'oidc', env, lookup, run }) {
  if (mode !== 'oidc' || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || !env.ACTIONS_ID_TOKEN_REQUEST_URL)
    fail();
  try {
    assertReleaseContext(releaseContext(env), true, 'publish-npm.yml');
  } catch {
    fail();
  }
  const rows = releaseRows(readFileSync(resolve(root, 'publish-order.tsv'), 'utf8'));
  // Qualify the complete set before the first irreversible registry write.
  let existingUnqualified = false;
  for (const [name, version, filename] of rows) {
    const archive = resolve(root, filename);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`;
    const existing = await lookup(`${encodeURIComponent(name)}/${version}`);
    if (existing.status === 200) {
      if (
        existing.body?.name !== name ||
        existing.body?.version !== version ||
        existing.body?.dist?.integrity !== integrity
      )
        fail();
      // Registry metadata (including gitHead) is not verified signed provenance.
      existingUnqualified = true;
      continue;
    }
    if (existing.status !== 404) fail();
  }
  if (existingUnqualified) fail('EXISTING_PROVENANCE_UNQUALIFIED');
  for (const [, , filename] of rows) {
    const archive = resolve(root, filename);
    const childEnv = publishEnvironment(env);
    const result = await run(
      process.execPath,
      [
        npmCli,
        'publish',
        archive,
        '--access',
        'public',
        '--provenance',
        '--ignore-scripts',
        '--registry=https://registry.npmjs.org/',
      ],
      childEnv,
    );
    // A failed/unknown publication is never retried in this invocation.
    if (result !== 0) fail();
  }
}

async function registry(path) {
  const response = await fetch(`https://registry.npmjs.org/${path}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json' },
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: response.status };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) fail();
    chunks.push(chunk);
  }
  return { status: 200, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  delete process.env.NPM_BOOTSTRAP_TOKEN;
  try {
    await publishRelease({
      root: process.argv[2],
      npmCli: process.argv[3],
      mode: process.argv[4],
      env: process.env,
      lookup: registry,
      run: (command, args, env) =>
        spawnSync(command, args, { env, stdio: 'inherit', timeout: 180_000, shell: false }).status,
    });
  } catch (error) {
    console.error(
      error?.message === 'NPM_RELEASE_REFUSED: EXISTING_PROVENANCE_UNQUALIFIED'
        ? 'Existing npm artifacts require qualified signed provenance; nothing was published.'
        : 'npm release stopped; verify registry state before any later dispatch.',
    );
    process.exitCode = 1;
  }
}
