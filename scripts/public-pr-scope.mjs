import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sha = (value) =>
  typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value);
export const PUBLIC_PR_SCOPE_LIMITS = Object.freeze({
  eventBytes: 1_048_576,
  gitBytes: 8_388_608,
  gitMs: 10_000,
});

export function classifyPublicPaths(paths) {
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.some(
      (path) =>
        typeof path !== 'string' ||
        path.trim() !== path ||
        !/^[A-Za-z0-9_./ -]+$/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..') ||
        /(?:^|\/)[^/]*(?:brand|config|readme)[^/]*(?:\/|$)/i.test(path),
    )
  )
    return 'full';
  if (paths.every((path) => /^apps\/docs\/src\/content\/docs\/.+\.mdx?$/.test(path))) return 'docs';
  if (
    paths.every((path) => /^apps\/frontend\/(?:src|test)\/.+\.(?:ts|tsx|css|mjs|json)$/.test(path))
  )
    return 'frontend';
  return 'full';
}

function gitRead(directory, args) {
  const env = Object.fromEntries(
    ['PATH', 'SystemRoot', 'HOME', 'USERPROFILE', 'TMP', 'TEMP']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  const result = spawnSync(
    'git',
    ['--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd: directory,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: PUBLIC_PR_SCOPE_LIMITS.gitMs,
      maxBuffer: PUBLIC_PR_SCOPE_LIMITS.gitBytes,
    },
  );
  if (result.error || result.status !== 0) throw new Error('PUBLIC_PR_GIT_UNAVAILABLE');
  return result.stdout;
}

// Event metadata is insufficient: bind it to this clean, complete merge checkout.
// No saved receipt, caller-selected scope, remote API or Turbo affected result is trusted.
export function inspectPublicPrScope({ directory = root, env = process.env } = {}) {
  const full = { scope: 'full' };
  try {
    if (!['pull_request', 'push'].includes(env.GITHUB_EVENT_NAME)) return full;
    if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_SERVER_URL !== 'https://github.com')
      return full;
    const stat = lstatSync(env.GITHUB_EVENT_PATH);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PUBLIC_PR_SCOPE_LIMITS.eventBytes)
      return full;
    const bytes = readFileSync(env.GITHUB_EVENT_PATH);
    if (bytes.length > PUBLIC_PR_SCOPE_LIMITS.eventBytes) return full;
    const event = JSON.parse(bytes.toString('utf8'));
    const pr = event.pull_request;
    const policy = JSON.parse(
      readFileSync(resolve(directory, 'scripts/public-release-policy.json')),
    );
    const push = env.GITHUB_EVENT_NAME === 'push';
    const repository = push ? event.repository : pr?.base?.repo;
    if (
      String(repository?.id) !== policy.repositoryId ||
      String(env.GITHUB_REPOSITORY_ID) !== policy.repositoryId ||
      repository?.full_name !== `${repository?.owner?.login}/${policy.repository}` ||
      env.GITHUB_REPOSITORY !== repository.full_name ||
      policy.owners[repository.owner.login] !== String(repository.owner.id) ||
      env.GITHUB_ACTOR !== policy.operator.login ||
      env.GITHUB_ACTOR_ID !== policy.operator.id ||
      env.GITHUB_TRIGGERING_ACTOR !== policy.operator.login ||
      env.GITHUB_RUN_ATTEMPT !== '1' ||
      !sha(env.GITHUB_SHA)
    )
      return full;
    if (
      push &&
      (env.GITHUB_REF !== 'refs/heads/main' ||
        event.ref !== env.GITHUB_REF ||
        !sha(event.before) ||
        /^0{40}$/.test(event.before) ||
        event.after !== env.GITHUB_SHA ||
        event.before === event.after ||
        event.created !== false ||
        event.deleted !== false ||
        event.forced !== false ||
        event.sender?.login !== policy.operator.login ||
        String(event.sender?.id) !== policy.operator.id ||
        event.sender?.type !== 'User')
    )
      return full;
    if (
      !push &&
      (!['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(event.action) ||
        !Number.isSafeInteger(event.number) ||
        event.number < 1 ||
        pr?.number !== event.number ||
        env.GITHUB_REF !== `refs/pull/${event.number}/merge` ||
        !sha(env.GITHUB_SHA) ||
        !sha(pr?.base?.sha) ||
        !sha(pr?.head?.sha) ||
        pr.merge_commit_sha !== env.GITHUB_SHA ||
        pr.base.ref !== 'main' ||
        env.GITHUB_BASE_REF !== pr.base.ref ||
        env.GITHUB_HEAD_REF !== pr.head.ref ||
        String(repository?.id) !== policy.repositoryId ||
        String(env.GITHUB_REPOSITORY_ID) !== policy.repositoryId ||
        repository?.full_name !== `${repository?.owner?.login}/${policy.repository}` ||
        env.GITHUB_REPOSITORY !== repository.full_name ||
        policy.owners[repository.owner.login] !== String(repository.owner.id) ||
        event.repository?.id !== repository.id ||
        event.repository?.full_name !== repository.full_name ||
        pr.draft !== false ||
        pr.head.repo?.id !== repository.id ||
        pr.head.repo?.full_name !== repository.full_name ||
        pr.head.repo?.owner?.login !== repository.owner.login ||
        pr.head.repo?.owner?.id !== repository.owner.id)
    )
      return full;
    const git = (args) => gitRead(directory, args);
    const clean = () =>
      git(['status', '--porcelain=v1', '-z', '--untracked-files=all']) === '' &&
      git(['ls-files', '-v', '-z'])
        .split('\0')
        .filter(Boolean)
        .every((entry) => entry.startsWith('H '));
    const expectedRoot = lstatSync(directory);
    const checkoutRoot = lstatSync(resolve(git(['rev-parse', '--show-toplevel']).trim()));
    if (
      !expectedRoot.isDirectory() ||
      expectedRoot.isSymbolicLink() ||
      !checkoutRoot.isDirectory() ||
      checkoutRoot.isSymbolicLink() ||
      expectedRoot.ino === 0 ||
      expectedRoot.ino !== checkoutRoot.ino ||
      expectedRoot.dev !== checkoutRoot.dev ||
      git(['rev-parse', '--is-shallow-repository']).trim() !== 'false' ||
      !clean()
    )
      return full;
    const merge = git(['rev-parse', '--verify', 'HEAD']).trim();
    const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ');
    if (push) git(['merge-base', '--is-ancestor', event.before, merge]);
    if (
      merge !== env.GITHUB_SHA ||
      (!push &&
        (parents.length !== 3 ||
          parents[0] !== merge ||
          parents[1] !== pr.base.sha ||
          parents[2] !== pr.head.sha))
    )
      return full;
    // Disabling rename detection exposes both old and new paths, including deletions.
    const diff = git([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-only',
      '-z',
      push ? event.before : pr.base.sha,
      merge,
      '--',
    ]);
    if (!diff || !diff.endsWith('\0')) return full;
    const scope = classifyPublicPaths(diff.slice(0, -1).split('\0'));
    const indexState = git(['ls-files', '-v', '-z']);
    if (
      git(['rev-parse', '--verify', 'HEAD']).trim() !== merge ||
      !clean() ||
      !readFileSync(env.GITHUB_EVENT_PATH).equals(bytes)
    )
      return full;
    return {
      scope,
      assertSource() {
        // Allow only ignored build output, never new source, tracked edits or hiding flags.
        if (
          git(['rev-parse', '--verify', 'HEAD']).trim() !== merge ||
          git(['ls-files', '-v', '-z']) !== indexState ||
          git(['ls-files', '--others', '--exclude-standard', '-z']) !== '' ||
          git([
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--name-only',
            '-z',
            'HEAD',
            '--',
          ]) !== '' ||
          git([
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--name-only',
            '-z',
            '--cached',
            'HEAD',
            '--',
          ]) !== '' ||
          !readFileSync(env.GITHUB_EVENT_PATH).equals(bytes)
        )
          throw new Error('PUBLIC_PR_SOURCE_CHANGED');
      },
    };
  } catch {
    return full;
  }
}

export function resolvePublicPrScope(options) {
  return inspectPublicPrScope(options).scope;
}
