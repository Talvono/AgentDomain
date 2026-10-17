import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import {
  assertReleaseContext,
  releaseContext,
  RELEASE_POLICY,
} from './public-release-identity.mjs';

export const RELEASE_CI_LIMITS = Object.freeze({ maxBytes: 1_048_576, timeoutMs: 10_000 });
export const FULL_PUBLIC_CI_STEP = 'Full Public Qualification (agentdomain.public-ci.full.v1)';
const positive = (value) => Number.isSafeInteger(value) && value > 0;

function selectRun(payload, context) {
  assertReleaseContext(context);
  if (
    payload?.source_commit?.sha !== context.sha ||
    payload.source_commit.commit?.verification?.verified !== true ||
    payload.triggering_operator?.login !== RELEASE_POLICY.operator.login ||
    String(payload.triggering_operator?.id) !== RELEASE_POLICY.operator.id
  )
    throw new Error('RELEASE_SOURCE_UNQUALIFIED');
  if (
    !Array.isArray(payload?.workflow_runs) ||
    payload.workflow_runs.length > 10 ||
    payload.total_count !== payload.workflow_runs.length ||
    !payload.workflow_runs.every((run) => positive(run?.id)) ||
    new Set(payload.workflow_runs.map((run) => run.id)).size !== payload.workflow_runs.length
  )
    throw new Error('RELEASE_CI_RESPONSE_INVALID');
  const run = payload.workflow_runs
    .filter(
      (candidate) =>
        candidate.head_sha === context.sha &&
        candidate.head_branch === 'main' &&
        ['push', 'workflow_dispatch'].includes(candidate.event),
    )
    .sort((a, b) => b.id - a.id)[0];
  if (
    !run ||
    !(
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      positive(run.run_attempt) &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.path === '.github/workflows/public-ci.yml' &&
      run.url === `https://api.github.com/repos/${context.repository}/actions/runs/${run.id}` &&
      [run.actor, run.triggering_actor].every(
        (actor) =>
          actor?.login === RELEASE_POLICY.operator.login &&
          String(actor.id) === RELEASE_POLICY.operator.id &&
          actor.type === 'User',
      ) &&
      [run.repository, run.head_repository].every(
        (repo) =>
          repo?.full_name === context.repository &&
          String(repo.id) === RELEASE_POLICY.repositoryId &&
          repo.owner?.login === context.owner &&
          String(repo.owner?.id) === context.ownerId,
      )
    )
  )
    throw new Error('RELEASE_CI_SUCCESS_REQUIRED');
  return run;
}

export function verifyReleaseCi(payload, context) {
  const run = selectRun(payload, context);
  const jobs = payload.qualification_jobs;
  const job = jobs?.jobs?.[0];
  if (
    payload.current_main?.sha !== context.sha ||
    jobs?.total_count !== 1 ||
    jobs.jobs?.length !== 1 ||
    !positive(job?.id) ||
    job.run_id !== run.id ||
    job.run_url !== run.url ||
    (job.run_attempt !== undefined && job.run_attempt !== run.run_attempt) ||
    job.head_sha !== context.sha ||
    job.head_branch !== 'main' ||
    job.workflow_name !== 'Public CI' ||
    job.name !== 'Boundary, packages, frontend, docs, and Cloudflare' ||
    job.status !== 'completed' ||
    job.conclusion !== 'success' ||
    !Array.isArray(job.steps) ||
    job.steps.filter(
      (step) =>
        step.name === FULL_PUBLIC_CI_STEP &&
        positive(step.number) &&
        step.status === 'completed' &&
        step.conclusion === 'success',
    ).length !== 1 ||
    job.steps.filter((step) => step.name === FULL_PUBLIC_CI_STEP).length !== 1
  )
    throw new Error('RELEASE_CI_FULL_QUALIFICATION_REQUIRED');
  return run.id;
}

const actorIdentity = (actor) => ({ login: actor?.login, id: actor?.id, type: actor?.type });
const repositoryIdentity = (repository) => ({
  full_name: repository?.full_name,
  id: repository?.id,
  owner: { login: repository?.owner?.login, id: repository?.owner?.id },
});
const runIdentity = (run) => ({
  ...Object.fromEntries(
    [
      'id',
      'run_attempt',
      'head_sha',
      'head_branch',
      'event',
      'status',
      'conclusion',
      'path',
      'url',
    ].map((key) => [key, run[key]]),
  ),
  actor: actorIdentity(run.actor),
  triggering_actor: actorIdentity(run.triggering_actor),
  repository: repositoryIdentity(run.repository),
  head_repository: repositoryIdentity(run.head_repository),
});

export async function qualifyReleaseCi(context, request) {
  assertReleaseContext(context);
  const base = `repos/${context.repository}`;
  const source_commit = await request(`${base}/commits/${context.sha}`);
  const triggering_operator = await request(`users/${context.triggeringActor}`);
  const current_main = await request(`${base}/commits/main`);
  const path = `${base}/actions/workflows/public-ci.yml/runs?branch=main&head_sha=${context.sha}&per_page=10`;
  const initial = await request(path);
  const source = { source_commit, triggering_operator, current_main };
  const selected = selectRun({ ...initial, ...source }, context);
  const runPath = `${base}/actions/runs/${selected.id}`;
  const detail = await request(runPath);
  if (!isDeepStrictEqual(runIdentity(detail), runIdentity(selected)))
    throw new Error('RELEASE_CI_CHANGED');
  const qualification_jobs = await request(
    `${runPath}/attempts/${selected.run_attempt}/jobs?per_page=100`,
  );
  verifyReleaseCi({ ...initial, ...source, qualification_jobs }, context);
  const final = await request(runPath);
  const latest = selectRun({ ...(await request(path)), ...source }, context);
  const main = await request(`${base}/commits/main`);
  if (
    !isDeepStrictEqual(runIdentity(final), runIdentity(selected)) ||
    !isDeepStrictEqual(runIdentity(latest), runIdentity(selected)) ||
    main.sha !== context.sha
  )
    throw new Error('RELEASE_CI_CHANGED');
  return selected.id;
}

async function githubRead(path) {
  const { stdout } = await promisify(execFile)(
    'gh',
    ['api', '--hostname', 'github.com', '--method', 'GET', path],
    {
      timeout: RELEASE_CI_LIMITS.timeoutMs,
      maxBuffer: RELEASE_CI_LIMITS.maxBytes,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
}

async function main() {
  const context = releaseContext(process.env);
  const emit = (id) => {
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `publication-authorized=${context.owner === RELEASE_POLICY.activeOwner}\n`,
      );
    console.log(`Full Public CI passed for this exact main commit (run ${id}).`);
  };
  if (process.argv.slice(2).join(' ') === '--github') {
    emit(await qualifyReleaseCi(context, githubRead));
    return;
  }
  if (process.argv.length !== 2) throw new Error('RELEASE_CI_ARGUMENTS');
  const chunks = [];
  let bytes = 0;
  const deadline = setTimeout(() => {
    process.stdin.destroy(new Error('RELEASE_CI_INPUT_TIMEOUT'));
  }, RELEASE_CI_LIMITS.timeoutMs);
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > RELEASE_CI_LIMITS.maxBytes) throw new Error('RELEASE_CI_INPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const id = verifyReleaseCi(payload, context);
    emit(id);
  } finally {
    clearTimeout(deadline);
    process.stdin.destroy();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Release requires full Public CI qualification for this exact main commit.');
    process.exitCode = 1;
  });
}
