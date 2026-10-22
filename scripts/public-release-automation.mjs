import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, isDeepStrictEqual } from 'node:util';
import {
  releaseContext,
  releaseSourceContext,
  assertReleaseContext,
  assertReleaseCheckout,
  assertSourceIdentity,
  RELEASE_POLICY,
} from './public-release-identity.mjs';
import { qualifyReleaseCi } from './verify-release-ci.mjs';

export const AUTOMATION_LIMITS = Object.freeze({
  requestMs: 10_000,
  commandMs: 180_000,
  jsonBytes: 4 * 1024 * 1024,
  archiveBytes: 64 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  requests: 80,
  runs: 10,
  attempts: 10,
  jobs: 100,
  releases: 100,
  attestations: 4,
});
export const READINESS_LIMITS = Object.freeze({
  rounds: 6,
  deadlineMs: 360_000,
  backoffMs: Object.freeze([30_000, 30_000, 60_000, 60_000, 120_000]),
});
export const PUBLISHERS = Object.freeze({
  'publish-npm.yml': Object.freeze({
    name: 'Publish npm packages',
    ecosystem: 'npm',
    step: 'Publish all six established packages using OIDC only',
  }),
  'publish-python.yml': Object.freeze({
    name: 'Publish Python packages',
    ecosystem: 'Python',
    step: 'Publish selected verified distributions and OIDC attestations',
  }),
});
export const NPM_PACKAGES = Object.freeze([
  'shared',
  'sdk',
  'mcp-server',
  'agentkit-plugin',
  'eliza-plugin',
  'langchain-plugin',
]);
export const PYTHON_PACKAGES = Object.freeze(['agentdomain-crewai', 'agentdomain-autogen']);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STABLE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA = /^[0-9a-f]{40}$/;
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const fail = (code) => {
  throw new Error(`PUBLIC_RELEASE_${code}`);
};
const need = (condition, code) => {
  if (!condition) fail(code);
};
export function stableVersion(value) {
  need(
    typeof value === 'string' && value.trim() === value && STABLE.test(value),
    'VERSION_INVALID',
  );
  return value;
}
export function compareVersions(a, b) {
  const left = stableVersion(a).split('.').map(BigInt),
    right = stableVersion(b).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function operator(actor) {
  return (
    actor?.login === RELEASE_POLICY.operator.login &&
    String(actor.id) === RELEASE_POLICY.operator.id &&
    actor.type === 'User'
  );
}
function repository(repo, context) {
  return (
    repo?.full_name === context.repository &&
    String(repo.id) === context.repositoryId &&
    repo.owner?.login === context.owner &&
    String(repo.owner.id) === context.ownerId
  );
}
export function assertRun(run, context, workflow, { success = true } = {}) {
  need(
    positive(run?.id) &&
      positive(run.run_attempt) &&
      positive(run.workflow_id) &&
      run.path === `.github/workflows/${workflow}` &&
      run.name === (PUBLISHERS[workflow]?.name ?? 'Complete public release') &&
      run.event === 'workflow_run' &&
      run.head_branch === 'main' &&
      run.head_sha === context.sha &&
      run.url === `https://api.github.com/repos/${context.repository}/actions/runs/${run.id}` &&
      operator(run.actor) &&
      operator(run.triggering_actor) &&
      repository(run.repository, context) &&
      repository(run.head_repository, context),
    'RUN_IDENTITY',
  );
  if (success)
    need(run.status === 'completed' && run.conclusion === 'success', 'RUN_NOT_SUCCESSFUL');
  return run;
}
function ownWorkflow(env) {
  const ref = `${env.GITHUB_REPOSITORY}/.github/workflows/`;
  return env.GITHUB_WORKFLOW_REF?.startsWith(ref)
    ? env.GITHUB_WORKFLOW_REF.slice(ref.length).split('@')[0]
    : '';
}
export function finalizerContext(env, event) {
  const context = {
    repository: env.GITHUB_REPOSITORY,
    repositoryId: env.GITHUB_REPOSITORY_ID,
    owner: env.GITHUB_REPOSITORY_OWNER,
    ownerId: env.GITHUB_REPOSITORY_OWNER_ID,
    actor: env.GITHUB_ACTOR,
    actorId: env.GITHUB_ACTOR_ID,
    triggeringActor: env.GITHUB_TRIGGERING_ACTOR,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
  };
  assertSourceIdentity(context);
  need(
    context.owner === RELEASE_POLICY.activeOwner &&
      env.GITHUB_EVENT_NAME === 'workflow_run' &&
      context.ref === 'refs/heads/main' &&
      SHA.test(context.sha ?? '') &&
      context.actor === RELEASE_POLICY.operator.login &&
      context.actorId === RELEASE_POLICY.operator.id &&
      context.triggeringActor === RELEASE_POLICY.operator.login &&
      context.workflowRef ===
        `${context.repository}/.github/workflows/complete-public-release.yml@refs/heads/main` &&
      event?.action === 'completed' &&
      repository(event.repository, context),
    'FINALIZER_CONTEXT',
  );
  const workflow = event.workflow_run?.path?.replace('.github/workflows/', '');
  need(Object.hasOwn(PUBLISHERS, workflow ?? ''), 'PUBLISHER_UNKNOWN');
  assertRun(event.workflow_run, context, workflow);
  return { context, workflow };
}
export async function planCompletion({
  env,
  event,
  source,
  api,
  registryJson,
  qualify = qualifyReleaseCi,
  bindSource = releaseSourceContext,
  emit = () => {},
  now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const { context: initial, workflow: triggered } = finalizerContext(env, event);
  const state = await source();
  need(
    state.sha === initial.sha && state.clean === true && SHA.test(state.parentSha ?? ''),
    'CHECKOUT_INVALID',
  );
  const version = stableVersion(state.version),
    parentVersion = stableVersion(state.parentVersion);
  need(compareVersions(version, parentVersion) >= 0, 'VERSION_NOT_INCREASING');
  const output = {
    'release-needed': 'false',
    version,
    'source-sha': initial.sha,
  };
  if (version === parentVersion) {
    emit({ ...output, reason: 'unchanged-version' });
    return { ...output, reason: 'unchanged-version' };
  }
  const ciPath = `repos/${initial.repository}/actions/workflows/public-ci.yml/runs?branch=main&event=push&head_sha=${initial.sha}&per_page=10`;
  const candidates = boundedRuns(await api(ciPath)).sort((a, b) => b.id - a.id);
  need(candidates.length > 0, 'CI_MISSING');
  const ci = candidates[0],
    context = bindSource(env, { workflow: 'complete-public-release.yml', sourceRun: ci });
  need(isDeepStrictEqual(await checkout(source, context), state), 'CHECKOUT_CHANGED');
  const own = await ownRun(env, context, 'complete-public-release.yml', api);
  await qualifyParent(state, context, api);
  need((await qualify(context, api)) === ci.id, 'CI_BINDING');
  const publication = await publisherPair(context, version, ci, api);
  if (!publication) {
    emit({ ...output, reason: 'waiting-for-other-publisher' });
    return { ...output, reason: 'waiting-for-other-publisher' };
  }
  const latest = publication.latest[triggered];
  need(
    latest.id === event.workflow_run.id && latest.run_attempt === event.workflow_run.run_attempt,
    'STALE_PUBLISHER_EVENT',
  );
  await waitForRegistryVersions({ context, version, api, registryJson, now, sleep });
  need(isDeepStrictEqual(await checkout(source, context), state), 'CHECKOUT_CHANGED');
  need(
    isDeepStrictEqual(
      runBinding(await api(`repos/${context.repository}/actions/runs/${own.id}`)),
      runBinding(own),
    ),
    'OWN_RUN_CHANGED',
  );
  // Readiness grants no publication/provenance authority; complete independently requalifies everything.
  output['release-needed'] = 'true';
  output.reason = 'registry-ready';
  emit(output);
  return output;
}
async function waitForRegistryVersions({ context, version, api, registryJson, now, sleep }) {
  const pending = new Map([
    ...NPM_PACKAGES.map((slug) => [
      `https://registry.npmjs.org/${encodeURIComponent(`@agentdomain/${slug}`)}/${version}`,
      { name: `@agentdomain/${slug}`, ecosystem: 'npm' },
    ]),
    ...PYTHON_PACKAGES.map((name) => [
      `https://pypi.org/pypi/${name}/${version}/json`,
      { name, ecosystem: 'pypi' },
    ]),
  ]);
  const deadline = now() + READINESS_LIMITS.deadlineMs;
  const remaining = () => {
    const ms = deadline - now();
    need(ms > 0, 'READINESS_DEADLINE');
    return ms;
  };
  const signal = () =>
    AbortSignal.timeout(Math.max(1, Math.min(AUTOMATION_LIMITS.requestMs, Math.ceil(remaining()))));
  for (let round = 0; round < READINESS_LIMITS.rounds; round++) {
    remaining();
    for (const [url, expected] of pending) {
      const metadata = await registryJson(url, {
        optional: true,
        requireObject: true,
        signal: signal(),
      });
      remaining();
      if (metadata === null) continue; // Only the native transport's explicit 404 means processing.
      const identity = expected.ecosystem === 'npm' ? metadata : metadata?.info;
      need(
        identity?.name === expected.name && identity.version === version,
        'REGISTRY_VERSION_IDENTITY',
      );
      pending.delete(url);
    }
    if (!pending.size) {
      const main = await api(`repos/${context.repository}/commits/main`, { signal: signal() });
      remaining();
      need(main.sha === context.sha, 'MAIN_ADVANCED');
      return;
    }
    if (round === READINESS_LIMITS.rounds - 1) fail('REGISTRY_NOT_READY');
    const delay = READINESS_LIMITS.backoffMs[round];
    need(delay < remaining(), 'READINESS_DEADLINE');
    await sleep(delay);
    remaining();
    const main = await api(`repos/${context.repository}/commits/main`, { signal: signal() });
    remaining();
    need(main.sha === context.sha, 'MAIN_ADVANCED');
  }
}
async function checkout(source, context) {
  const state = await source();
  assertReleaseCheckout(context, state.sha);
  need(state.clean === true && SHA.test(state.parentSha ?? ''), 'CHECKOUT_INVALID');
  return {
    ...state,
    parentVersion: stableVersion(state.parentVersion),
    version: stableVersion(state.version),
  };
}
async function qualifyParent(state, context, api) {
  const parent = await api(`repos/${context.repository}/commits/${state.parentSha}`);
  need(
    parent.sha === state.parentSha && parent.commit?.verification?.verified === true,
    'PARENT_UNSIGNED',
  );
}
async function ownRun(env, context, workflow, api) {
  const id = Number(env.GITHUB_RUN_ID),
    attempt = Number(env.GITHUB_RUN_ATTEMPT);
  need(positive(id) && positive(attempt), 'OWN_RUN_INVALID');
  const run = await api(`repos/${context.repository}/actions/runs/${id}`);
  assertRun(run, context, workflow, { success: false });
  need(
    run.id === id && run.run_attempt === attempt && ['in_progress', 'queued'].includes(run.status),
    'OWN_RUN_INVALID',
  );
  const actor = await api(`users/${context.triggeringActor}`);
  need(operator(actor), 'OPERATOR_INVALID');
  return run;
}
export async function planRelease({
  env,
  context,
  source,
  api,
  qualify = qualifyReleaseCi,
  emit = () => {},
}) {
  context ??= releaseContext(env);
  const workflow = ownWorkflow(env);
  need(Object.hasOwn(PUBLISHERS, workflow), 'PUBLISHER_UNKNOWN');
  assertReleaseContext(context, true, workflow);
  need(
    context.eventName === 'workflow_run' &&
      positive(context.sourceRun?.id) &&
      context.sourceRun.head_sha === context.sha,
    'SOURCE_BINDING',
  );
  const state = await checkout(source, context);
  const output = {
    'release-needed': 'false',
    version: state.version,
    'source-sha': context.sha,
    'ci-run-id': String(context.sourceRun.id),
    'ci-run-attempt': String(context.sourceRun.run_attempt),
  };
  // Ordinary main commits never perform remote release qualification or registry operations.
  if (state.version === state.parentVersion) {
    emit(output);
    return output;
  }
  need(compareVersions(state.version, state.parentVersion) > 0, 'VERSION_NOT_INCREASING');
  const own = await ownRun(env, context, workflow, api);
  await qualifyParent(state, context, api);
  need((await qualify(context, api)) === context.sourceRun.id, 'CI_BINDING');
  const path = `repos/${context.repository}/actions/workflows/${workflow}/runs?branch=main&event=workflow_run&head_sha=${context.sha}&per_page=10`;
  const previous = boundedRuns(await api(path))
    .filter((run) => run.id <= own.id)
    .sort((a, b) => b.id - a.id);
  const published = await findPublication(
    context,
    state.version,
    context.sourceRun,
    workflow,
    previous,
    api,
    own,
  );
  need(isDeepStrictEqual(await checkout(source, context), state), 'CHECKOUT_CHANGED');
  const current = await api(`repos/${context.repository}/actions/runs/${own.id}`);
  need(isDeepStrictEqual(runBinding(current), runBinding(own)), 'OWN_RUN_CHANGED');
  // This suppresses duplicate mutations only; it never claims registry provenance is qualified.
  output['release-needed'] = published ? 'false' : 'true';
  emit(output);
  return output;
}
function runBinding(run) {
  return Object.fromEntries(
    [
      'id',
      'run_attempt',
      'workflow_id',
      'head_sha',
      'head_branch',
      'path',
      'event',
      'status',
      'conclusion',
      'actor',
      'triggering_actor',
      'repository',
      'head_repository',
    ].map((k) => [k, run[k]]),
  );
}
function boundedRuns(payload) {
  need(
    Array.isArray(payload?.workflow_runs) &&
      payload.total_count === payload.workflow_runs.length &&
      payload.workflow_runs.length <= AUTOMATION_LIMITS.runs &&
      payload.workflow_runs.every((r) => positive(r?.id)) &&
      new Set(payload.workflow_runs.map((r) => r.id)).size === payload.workflow_runs.length,
    'RUN_LIST_INVALID',
  );
  return payload.workflow_runs;
}
export function assertPublishJobs(payload, run, workflow, version, ci) {
  const jobs = payload?.jobs;
  need(
    Array.isArray(jobs) &&
      payload.total_count === jobs.length &&
      jobs.length > 0 &&
      jobs.length < AUTOMATION_LIMITS.jobs &&
      new Set(jobs.map((j) => j.id)).size === jobs.length,
    'JOBS_INVALID',
  );
  const expected = `Publish ${PUBLISHERS[workflow].ecosystem} ${version} (Public CI ${ci.id}/${ci.run_attempt})`;
  const matches = jobs.filter((job) => job.name === expected);
  need(matches.length === 1, 'EXACT_PUBLISH_JOB_REQUIRED');
  const job = matches[0];
  need(
    positive(job.id) &&
      job.run_id === run.id &&
      (job.run_attempt === undefined || job.run_attempt === run.run_attempt) &&
      job.run_url === run.url &&
      job.head_sha === run.head_sha &&
      job.head_branch === 'main' &&
      job.workflow_name === PUBLISHERS[workflow].name &&
      job.status === 'completed' &&
      job.conclusion === 'success',
    'PUBLISH_JOB_FAILED',
  );
  const steps = job.steps?.filter((step) => step.name === PUBLISHERS[workflow].step);
  need(
    steps?.length === 1 &&
      positive(steps[0].number) &&
      steps[0].status === 'completed' &&
      steps[0].conclusion === 'success',
    'PUBLISH_STEP_NOT_EXECUTED',
  );
  return job.id;
}
function assertPlannerOnly(payload, run, workflow, version, ci) {
  const expected = `Publish ${PUBLISHERS[workflow].ecosystem} ${version} (Public CI ${ci.id}/${ci.run_attempt})`;
  const jobs = payload?.jobs;
  need(
    payload?.total_count === 3 &&
      jobs?.length === 3 &&
      new Set(jobs.map((job) => job.id)).size === 3,
    'DUPLICATE_JOBS_INVALID',
  );
  for (const job of jobs)
    need(
      positive(job.id) &&
        job.run_id === run.id &&
        (job.run_attempt === undefined || job.run_attempt === run.run_attempt) &&
        job.head_sha === run.head_sha &&
        job.head_branch === 'main' &&
        job.run_url === run.url &&
        job.workflow_name === run.name &&
        job.status === 'completed',
      'DUPLICATE_JOB_BINDING',
    );
  const publish = jobs.filter((job) => job.name === expected);
  const planner = jobs.filter((job) => job.name === 'Plan a reviewed version change');
  need(
    publish.length === 1 &&
      publish[0].conclusion === 'skipped' &&
      planner.length === 1 &&
      planner[0].conclusion === 'success' &&
      jobs.filter((job) => job !== planner[0]).every((job) => job.conclusion === 'skipped'),
    'DUPLICATE_NOT_PLANNER_ONLY',
  );
  const steps = planner[0].steps?.filter(
    (step) => step.name === 'Skip unchanged versions before release builds',
  );
  need(
    steps?.length === 1 &&
      positive(steps[0].number) &&
      steps[0].status === 'completed' &&
      steps[0].conclusion === 'success',
    'DUPLICATE_PLANNER_NOT_EXECUTED',
  );
}
async function findPublication(context, version, ci, workflow, runs, api, own) {
  let inspected = 0;
  for (const run of runs) {
    assertRun(run, context, workflow, { success: false });
    const firstAttempt = own && run.id === own.id ? own.run_attempt - 1 : run.run_attempt;
    for (let attempt = firstAttempt; attempt >= 1; attempt--) {
      need(++inspected <= AUTOMATION_LIMITS.attempts, 'PUBLISHER_ATTEMPTS_OVERFLOW');
      const path = `repos/${context.repository}/actions/runs/${run.id}`;
      const detail = await api(attempt === run.run_attempt ? path : `${path}/attempts/${attempt}`);
      assertRun(detail, context, workflow);
      need(
        detail.id === run.id &&
          detail.run_attempt === attempt &&
          detail.workflow_id === run.workflow_id,
        'PUBLISHER_ATTEMPT_CHANGED',
      );
      if (attempt === run.run_attempt)
        need(isDeepStrictEqual(runBinding(detail), runBinding(run)), 'PUBLISHER_CHANGED');
      const jobs = await api(`${path}/attempts/${attempt}/jobs?per_page=100`);
      const expected = `Publish ${PUBLISHERS[workflow].ecosystem} ${version} (Public CI ${ci.id}/${ci.run_attempt})`;
      const publish = jobs?.jobs?.filter((job) => job.name === expected);
      if (publish?.length === 1 && publish[0].conclusion === 'success') {
        assertPublishJobs(jobs, detail, workflow, version, ci);
        return detail;
      }
      // A skipped green job is only an ignorable duplicate, never evidence of publication.
      assertPlannerOnly(jobs, detail, workflow, version, ci);
    }
  }
  return null;
}
async function publisherPair(context, version, ci, api) {
  const pair = {},
    latest = {};
  for (const workflow of Object.keys(PUBLISHERS)) {
    const path = `repos/${context.repository}/actions/workflows/${workflow}/runs?branch=main&event=workflow_run&head_sha=${context.sha}&per_page=10`;
    const runs = boundedRuns(await api(path)).sort((a, b) => b.id - a.id);
    if (!runs.length) return null;
    const run = assertRun(runs[0], context, workflow, { success: false });
    if (run.status !== 'completed') return null;
    assertRun(run, context, workflow);
    const published = await findPublication(context, version, ci, workflow, runs, api);
    need(published, 'ACTUAL_PUBLICATION_REQUIRED');
    pair[workflow] = published;
    latest[workflow] = run;
  }
  return { pair, latest };
}
const RELEASE_CHANGES = Object.freeze({
  '0.11.1': [
    'Canonical Talvono package source and issue links, with current installation examples.',
    'Coherent coordinated runtime and bridge package versions.',
    'Version-derived immutable artifact guards.',
    'Automatic OIDC publication with independently checked registry bytes and signed provenance.',
  ],
  '0.11.2': [
    'ElizaOS: a paid Premium Plan or the ENS add-on is selected only when the request names it; domain labels and words such as "provide" no longer add one.',
    'ElizaOS: one negation declines both add-ons ("without Basename or ENS"), plan purchases require a named plan, and quotes and registrations require a full domain.',
    'ElizaOS: quote replies list the term and every paid line before payment.',
  ],
});
export function releaseChanges(version) {
  const changes = RELEASE_CHANGES[version];
  return changes ? `\nPatch changes:\n${changes.map((line) => `- ${line}\n`).join('')}` : '';
}
function releaseBody(context, version, ci, pair, evidence) {
  const changes = releaseChanges(version);
  return (
    `Coordinated public release ${version}\n\nAgentDomain is the agent-native identity and communications infrastructure.\n` +
    changes +
    `\nSource: https://github.com/${context.repository}/commit/${context.sha}\n` +
    `Full Public CI: https://github.com/${context.repository}/actions/runs/${ci.id}/attempts/${ci.run_attempt}\n` +
    Object.entries(pair)
      .map(
        ([file, run]) =>
          `${file}: https://github.com/${context.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}\n`,
      )
      .join('') +
    '\nOfficial registry artifacts (bytes and signed provenance verified):\n' +
    evidence
      .map((row) => `${row.name}@${version} ${row.filename} sha256:${row.sha256}`)
      .join('\n') +
    '\n'
  );
}
async function exactTag(api, base, tag, sha) {
  const ref = await api(`${base}/git/ref/tags/${tag}`, { optional: true });
  if (ref === null) return null;
  need(
    ref.ref === `refs/tags/${tag}` && ref.object?.type === 'commit' && ref.object.sha === sha,
    'TAG_CONFLICT',
  );
  return ref;
}
function assertRelease(release, { tag, sha, body, version, repository }) {
  need(
    positive(release?.id) &&
      release.tag_name === tag &&
      release.target_commitish === sha &&
      release.name === `AgentDomain ${version}` &&
      release.body === body &&
      release.draft === false &&
      release.prerelease === false &&
      Array.isArray(release.assets) &&
      release.assets.length === 0 &&
      release.html_url === `https://github.com/${repository}/releases/tag/${tag}` &&
      release.url === `https://api.github.com/repos/${repository}/releases/${release.id}`,
    'RELEASE_CONFLICT',
  );
}
export async function finalizeRelease({
  env,
  event,
  source,
  api,
  verifyRegistries,
  qualify = qualifyReleaseCi,
  bindSource = releaseSourceContext,
  emit = () => {},
}) {
  const { context: initial, workflow: triggered } = finalizerContext(env, event);
  // The helper authenticates a real Public CI REST run, never a fabricated CI context.
  const ciPath = `repos/${initial.repository}/actions/workflows/public-ci.yml/runs?branch=main&event=push&head_sha=${initial.sha}&per_page=10`;
  const candidates = boundedRuns(await api(ciPath)).sort((a, b) => b.id - a.id);
  need(candidates.length > 0, 'CI_MISSING');
  const ci = candidates[0],
    context = bindSource(env, { workflow: 'complete-public-release.yml', sourceRun: ci });
  const state = await checkout(source, context);
  if (state.version === state.parentVersion) {
    emit({ completed: 'false', reason: 'unchanged-version' });
    return false;
  }
  need(compareVersions(state.version, state.parentVersion) > 0, 'VERSION_NOT_INCREASING');
  const own = await ownRun(env, context, 'complete-public-release.yml', api);
  await qualifyParent(state, context, api);
  need((await qualify(context, api)) === ci.id, 'CI_BINDING');
  const publication = await publisherPair(context, state.version, ci, api);
  if (!publication) {
    emit({ completed: 'false', reason: 'waiting-for-other-publisher' });
    return false;
  }
  const { pair, latest: publisherLatest } = publication;
  need(
    publisherLatest[triggered].id === event.workflow_run.id &&
      publisherLatest[triggered].run_attempt === event.workflow_run.run_attempt,
    'STALE_PUBLISHER_EVENT',
  );
  const evidence = await verifyRegistries({ context, version: state.version, pair });
  need(
    Array.isArray(evidence) &&
      evidence.length === 10 &&
      evidence.every((row) => /^[0-9a-f]{64}$/.test(row.sha256)),
    'REGISTRY_EVIDENCE',
  );
  const base = `repos/${context.repository}`,
    tag = `npm-v${state.version}`;
  const body = releaseBody(context, state.version, ci, pair, evidence);
  const spec = {
    tag,
    sha: context.sha,
    body,
    version: state.version,
    repository: context.repository,
  };
  const releases = await api(`${base}/releases?per_page=100`);
  need(
    Array.isArray(releases) && releases.length < AUTOMATION_LIMITS.releases,
    'RELEASE_LIST_OVERFLOW',
  );
  const stable = releases.filter(
    (r) =>
      !r.draft &&
      !r.prerelease &&
      /^npm-v/.test(r.tag_name ?? '') &&
      STABLE.test(r.tag_name.slice(5)),
  );
  const newest = stable.every((r) => compareVersions(state.version, r.tag_name.slice(5)) >= 0);
  const current = await api(`${base}/releases/tags/${tag}`, { optional: true });
  if (current) assertRelease(current, spec);
  await exactTag(api, base, tag, context.sha);
  // Re-read all mutable authorization evidence immediately before irreversible writes.
  need((await qualify(context, api)) === ci.id, 'CI_CHANGED');
  need(isDeepStrictEqual(await checkout(source, context), state), 'CHECKOUT_CHANGED');
  need(
    isDeepStrictEqual(await publisherPair(context, state.version, ci, api), publication),
    'PUBLISHER_CHANGED',
  );
  need(
    isDeepStrictEqual(runBinding(await api(`${base}/actions/runs/${own.id}`)), runBinding(own)),
    'OWN_RUN_CHANGED',
  );
  const anchor = await api(`${base}/commits/${context.sha}`);
  need(
    anchor.sha === context.sha && anchor.commit?.verification?.verified === true,
    'ANCHOR_UNSIGNED',
  );
  api.reserve?.(8);
  if (!(await exactTag(api, base, tag, context.sha)))
    await api(`${base}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/tags/${tag}`, sha: context.sha },
    });
  need(await exactTag(api, base, tag, context.sha), 'TAG_READBACK');
  if (!current)
    await api(`${base}/releases`, {
      method: 'POST',
      body: {
        tag_name: tag,
        target_commitish: context.sha,
        name: `AgentDomain ${state.version}`,
        body,
        draft: false,
        prerelease: false,
        make_latest: newest ? 'true' : 'false',
      },
    });
  const readback = await api(`${base}/releases/tags/${tag}`);
  assertRelease(readback, spec);
  const latest = await api(`${base}/releases/latest`);
  need(
    newest
      ? latest.id === readback.id && latest.tag_name === tag
      : latest.tag_name !== tag &&
          /^npm-v/.test(latest.tag_name ?? '') &&
          compareVersions(latest.tag_name.slice(5), state.version) > 0,
    'LATEST_READBACK',
  );
  await exactTag(api, base, tag, context.sha);
  emit({ completed: 'true', version: state.version, 'release-url': readback.html_url });
  return true;
}

export function createTransport({ token, fetcher = fetch } = {}) {
  let requests = 0,
    total = 0;
  async function bytes(
    url,
    { maxBytes = AUTOMATION_LIMITS.jsonBytes, method = 'GET', body, optional = false, signal } = {},
  ) {
    need(++requests <= AUTOMATION_LIMITS.requests, 'REQUEST_BUDGET');
    const parsed = new URL(url);
    need(
      ['api.github.com', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'].includes(
        parsed.hostname,
      ) &&
        parsed.protocol === 'https:' &&
        !parsed.username &&
        !parsed.password &&
        !parsed.hash,
      'REMOTE_URL',
    );
    need(
      method === 'GET' || (parsed.hostname === 'api.github.com' && method === 'POST'),
      'REMOTE_METHOD',
    );
    const headers = {
      accept: 'application/json',
      'user-agent': 'AgentDomain-public-release-finalizer',
    };
    if (parsed.hostname === 'api.github.com')
      Object.assign(headers, {
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      });
    if (body) headers['content-type'] = 'application/json';
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(AUTOMATION_LIMITS.requestMs)])
      : AbortSignal.timeout(AUTOMATION_LIMITS.requestMs);
    requestSignal.throwIfAborted();
    const response = await fetcher(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: requestSignal,
    });
    requestSignal.throwIfAborted();
    if (optional && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== (method === 'POST' ? 201 : 200)) {
      await response.body?.cancel();
      fail('REMOTE_STATUS');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      requestSignal.throwIfAborted();
      size += chunk.length;
      total += chunk.length;
      need(size <= maxBytes && total <= AUTOMATION_LIMITS.totalBytes, 'REMOTE_TOO_LARGE');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  const json = async (url, options) => {
    const result = await bytes(url, options);
    if (result === null) return null;
    const value = JSON.parse(result);
    if (options?.requireObject)
      need(value !== null && typeof value === 'object' && !Array.isArray(value), 'REMOTE_CONTENT');
    return value;
  };
  const api = (path, options) => json(`https://api.github.com/${path}`, options);
  api.reserve = (count) => need(requests + count <= AUTOMATION_LIMITS.requests, 'REQUEST_BUDGET');
  return { bytes, json, api };
}
const execute = async (command, args, options = {}) =>
  (
    await promisify(execFile)(command, args, {
      encoding: 'utf8',
      timeout: AUTOMATION_LIMITS.commandMs,
      maxBuffer: AUTOMATION_LIMITS.jsonBytes,
      windowsHide: true,
      ...options,
    })
  ).stdout;
function isolatedEnv(env) {
  const result = { ...env };
  for (const key of Object.keys(result))
    if (/token|password|secret|^npm_config_|^node_options$/i.test(key)) delete result[key];
  return {
    ...result,
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    NPM_CONFIG_FETCH_RETRIES: '0',
    NPM_CONFIG_FETCH_TIMEOUT: '10000',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_USERCONFIG: env.RUNNER_TEMP
      ? join(env.RUNNER_TEMP, 'absent-release-user-npmrc')
      : '',
    NPM_CONFIG_GLOBALCONFIG: env.RUNNER_TEMP
      ? join(env.RUNNER_TEMP, 'absent-release-global-npmrc')
      : '',
    PYTHONDONTWRITEBYTECODE: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_RETRIES: '0',
  };
}

// All certificate, DSSE, transparency-log and trust-root verification belongs to official libraries.
// This wrapper only adds exact release policy and checks authenticated statement fields.
export const PROVENANCE_VERIFIER_PY = String.raw`
import hashlib, json, sys
from pathlib import Path
from pypi_attestations import Attestation, Distribution, GitHubPublisher
from sigstore.models import Bundle
from sigstore.verify import Verifier, policy

data = json.load(sys.stdin)
repo, sha = data['repository'], data['sha']
verifier = Verifier.production()
for row in data['files']:
    blob = Path(row['path']).read_bytes()
    workflow = row['workflow']
    identity = f'https://github.com/{repo}/.github/workflows/{workflow}@refs/heads/main'
    invocation = f"https://github.com/{repo}/actions/runs/{row['run']}/attempts/{row['attempt']}"
    if row['ecosystem'] == 'npm':
        bundles = row['provenance']['attestations']
        selected = [b for b in bundles if b['predicateType'] == 'https://slsa.dev/provenance/v1']
        assert len(selected) == 1
        bundle = Bundle.from_json(json.dumps(selected[0]['bundle']))
        kind, payload = verifier.verify_dsse(bundle, policy.Identity(identity=identity, issuer='https://token.actions.githubusercontent.com'))
        assert kind == 'application/vnd.in-toto+json'
        statement = json.loads(payload)
        assert statement['_type'] == 'https://in-toto.io/Statement/v1'
        assert statement['predicateType'] == 'https://slsa.dev/provenance/v1'
        assert statement['subject'] == [{'name': row['purl'], 'digest': {'sha512': hashlib.sha512(blob).hexdigest()}}]
        definition = statement['predicate']['buildDefinition']
        assert definition['buildType'] == 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1'
        assert definition['externalParameters']['workflow'] == {'ref': 'refs/heads/main', 'repository': f'https://github.com/{repo}', 'path': f'.github/workflows/{workflow}'}
        assert definition['resolvedDependencies'] == [{'uri': f'git+https://github.com/{repo}@refs/heads/main', 'digest': {'gitCommit': sha}}]
        assert definition['internalParameters']['github'] == {'event_name': 'workflow_run', 'repository_id': data['repositoryId'], 'repository_owner_id': data['ownerId']}
        details = statement['predicate']['runDetails']
        assert details['metadata']['invocationId'] == invocation
        assert details['builder']['id'] == 'https://github.com/actions/runner/github-hosted'
        attestations = [Attestation.from_bundle(bundle)]
    else:
        provenance = row['provenance']
        assert provenance['version'] == 1 and len(provenance['attestation_bundles']) == 1
        group = provenance['attestation_bundles'][0]
        publisher = group['publisher']
        assert publisher['kind'] == 'GitHub' and publisher['repository'] == repo and publisher['workflow'] == workflow
        assert publisher['environment'] == 'pypi-production'
        attestations = [Attestation.model_validate(a) for a in group['attestations']]
        assert 1 <= len(attestations) <= 4
        types = []
        for attestation in attestations:
            # Environment is checked in PyPI's publisher record, not attested by Fulcio.
            predicate, _ = attestation.verify(GitHubPublisher(repository=repo, workflow=workflow), Distribution(name=row['filename'], digest=hashlib.sha256(blob).hexdigest()), offline=True)
            types.append(predicate)
        assert types.count('https://docs.pypi.org/attestations/publish/v1') == 1
    expected = {9: identity, 11: 'github-hosted', 12: f'https://github.com/{repo}', 13: sha,
                14: 'refs/heads/main', 15: data['repositoryId'], 17: data['ownerId'],
                18: identity, 19: sha, 20: 'workflow_run', 21: invocation, 22: 'public'}
    for attestation in attestations:
        claims = attestation.certificate_claims
        assert all(claims.get(f'1.3.6.1.4.1.57264.1.{key}') == value for key, value in expected.items())
print('Exact official registry bytes and signed source/run provenance verified.')
`;

export async function verifyOfficialRegistries(
  { context, version, pair },
  { transport, env = process.env, run = execute, verifyProvenance = verifyPython } = {},
) {
  need(
    env.RUNNER_TEMP && env.PUBLIC_RELEASE_NPM_CLI && env.PUBLIC_RELEASE_VERIFY_PYTHON,
    'TOOLS_MISSING',
  );
  const temp = mkdtempSync(join(env.RUNNER_TEMP, 'public-release-verify-'));
  const files = [],
    evidence = [],
    childEnv = isolatedEnv(env);
  childEnv.NPM_CONFIG_CACHE = join(temp, 'npm-cache');
  childEnv.XDG_CACHE_HOME = join(temp, 'cache');
  try {
    need(
      (
        await run(process.execPath, [env.PUBLIC_RELEASE_NPM_CLI, '--version'], { env: childEnv })
      ).trim() === '11.5.1',
      'NPM_TOOL_VERSION',
    );
    for (const slug of NPM_PACKAGES) {
      const name = `@agentdomain/${slug}`,
        filename = `agentdomain-${slug}-${version}.tgz`;
      const metadata = await transport.json(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
      );
      const url = `https://registry.npmjs.org/${name}/-/${slug}-${version}.tgz`;
      need(
        metadata.name === name &&
          metadata.version === version &&
          metadata.dist?.tarball === url &&
          Array.isArray(metadata.dist.signatures) &&
          metadata.dist.signatures.length > 0 &&
          metadata.dist.attestations?.provenance?.predicateType ===
            'https://slsa.dev/provenance/v1',
        'NPM_METADATA',
      );
      const blob = await transport.bytes(url, { maxBytes: AUTOMATION_LIMITS.archiveBytes });
      need(
        metadata.dist.integrity === `sha512-${createHash('sha512').update(blob).digest('base64')}`,
        'NPM_BYTES',
      );
      const attestationUrl = new URL(metadata.dist.attestations.url);
      need(
        attestationUrl.origin === 'https://registry.npmjs.org' &&
          attestationUrl.pathname.startsWith('/-/npm/v1/attestations/'),
        'NPM_ATTESTATION_URL',
      );
      const provenance = await transport.json(attestationUrl.href);
      need(
        Array.isArray(provenance.attestations) &&
          provenance.attestations.length > 0 &&
          provenance.attestations.length <= AUTOMATION_LIMITS.attestations,
        'NPM_ATTESTATIONS',
      );
      const path = join(temp, filename);
      writeFileSync(path, blob);
      const publisher = pair['publish-npm.yml'];
      files.push({
        name,
        filename,
        path,
        provenance,
        purl: `pkg:npm/%40agentdomain/${slug}@${version}`,
        ecosystem: 'npm',
        workflow: 'publish-npm.yml',
        run: publisher.id,
        attempt: publisher.run_attempt,
      });
      evidence.push({ name, filename, sha256: createHash('sha256').update(blob).digest('hex') });
    }
    for (const name of PYTHON_PACKAGES) {
      const metadata = await transport.json(`https://pypi.org/pypi/${name}/${version}/json`);
      need(
        metadata.info?.name === name &&
          metadata.info.version === version &&
          metadata.urls?.length === 2,
        'PYPI_METADATA',
      );
      const normalized = name.replaceAll('-', '_');
      const expected = [
        `${normalized}-${version}-py3-none-any.whl`,
        `${normalized}-${version}.tar.gz`,
      ];
      need(
        isDeepStrictEqual(metadata.urls.map((row) => row.filename).sort(), expected.sort()),
        'PYPI_FILES',
      );
      for (const item of metadata.urls) {
        const url = new URL(item.url);
        need(
          url.origin === 'https://files.pythonhosted.org' &&
            url.pathname.startsWith('/packages/') &&
            url.pathname.endsWith(`/${item.filename}`) &&
            item.yanked === false &&
            positive(item.size) &&
            item.size <= AUTOMATION_LIMITS.archiveBytes &&
            /^[0-9a-f]{64}$/.test(item.digests?.sha256 ?? ''),
          'PYPI_FILE',
        );
        const blob = await transport.bytes(url.href, { maxBytes: AUTOMATION_LIMITS.archiveBytes });
        need(
          blob.length === item.size &&
            createHash('sha256').update(blob).digest('hex') === item.digests.sha256,
          'PYPI_BYTES',
        );
        const provenance = await transport.json(
          `https://pypi.org/integrity/${name}/${version}/${item.filename}/provenance`,
        );
        const path = join(temp, item.filename);
        writeFileSync(path, blob);
        const publisher = pair['publish-python.yml'];
        files.push({
          name,
          filename: item.filename,
          path,
          provenance,
          ecosystem: 'pypi',
          workflow: 'publish-python.yml',
          run: publisher.id,
          attempt: publisher.run_attempt,
        });
        evidence.push({ name, filename: item.filename, sha256: item.digests.sha256 });
      }
    }
    const data = {
      repository: context.repository,
      repositoryId: context.repositoryId,
      ownerId: context.ownerId,
      sha: context.sha,
      files,
    };
    const input = JSON.stringify(data);
    need(Buffer.byteLength(input) <= 16 * AUTOMATION_LIMITS.jsonBytes, 'PROVENANCE_INPUT');
    // execFile input is not an option; write stdin explicitly and preserve its bounded process timeout.
    await verifyProvenance(env.PUBLIC_RELEASE_VERIFY_PYTHON, input, childEnv);
    // A synthetic six-node lock tree audits only these exact releases, never their dependency trees.
    const audit = join(temp, 'audit');
    mkdirSync(audit);
    const dependencies = Object.fromEntries(
      NPM_PACKAGES.map((slug) => [`@agentdomain/${slug}`, version]),
    );
    const packages = {
      '': { name: 'release-signature-verification', version: '0.0.0', dependencies },
    };
    for (const row of files.filter((row) => row.ecosystem === 'npm')) {
      const slug = row.name.split('/')[1],
        node = join(audit, 'node_modules', '@agentdomain', slug);
      mkdirSync(node, { recursive: true });
      writeFileSync(join(node, 'package.json'), JSON.stringify({ name: row.name, version }));
      const blob = readFileSync(row.path);
      packages[`node_modules/${row.name}`] = {
        name: row.name,
        version,
        resolved: `https://registry.npmjs.org/${row.name}/-/${slug}-${version}.tgz`,
        integrity: `sha512-${createHash('sha512').update(blob).digest('base64')}`,
      };
    }
    writeFileSync(join(audit, 'package.json'), JSON.stringify(packages['']));
    writeFileSync(
      join(audit, 'package-lock.json'),
      JSON.stringify({
        name: packages[''].name,
        version: '0.0.0',
        lockfileVersion: 3,
        requires: true,
        packages,
      }),
    );
    const result = JSON.parse(
      await run(
        process.execPath,
        [
          env.PUBLIC_RELEASE_NPM_CLI,
          'audit',
          'signatures',
          '--json',
          '--ignore-scripts',
          '--registry=https://registry.npmjs.org/',
          '--fetch-retries=0',
          '--fetch-timeout=10000',
        ],
        { cwd: audit, env: childEnv },
      ),
    );
    need(isDeepStrictEqual(result, { invalid: [], missing: [] }), 'NPM_SIGNATURES');
    return evidence.sort((a, b) => a.filename.localeCompare(b.filename));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
async function verifyPython(python, input, env) {
  await new Promise((resolve, reject) => {
    const child = execFile(
      python,
      ['-I', '-B', '-c', PROVENANCE_VERIFIER_PY],
      {
        env,
        timeout: AUTOMATION_LIMITS.commandMs,
        maxBuffer: AUTOMATION_LIMITS.jsonBytes,
        windowsHide: true,
      },
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
}
async function localSource() {
  const git = (args) => execute('git', args, { cwd: ROOT, timeout: AUTOMATION_LIMITS.requestMs });
  const sha = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
  const parentSha = (await git(['rev-parse', '--verify', 'HEAD^'])).trim();
  const parentVersion = JSON.parse(
    await git(['show', `${parentSha}:packages/shared/package.json`]),
  ).version;
  const version = (
    await execute('python', ['scripts/release-artifacts.py', 'source-version'], { cwd: ROOT })
  ).trim();
  const clean = (await git(['status', '--porcelain=v1', '--untracked-files=normal'])).trim() === '';
  return { sha, parentSha, parentVersion, version, clean };
}
function output(values) {
  need(process.env.GITHUB_OUTPUT, 'OUTPUT_REQUIRED');
  for (const [key, value] of Object.entries(values)) {
    need(typeof value === 'string' && !/[\r\n]/.test(value), 'OUTPUT_INVALID');
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}
async function main() {
  need(
    process.argv.length === 3 && ['plan', 'completion-plan', 'complete'].includes(process.argv[2]),
    'ARGUMENTS',
  );
  const transport = createTransport({ token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN });
  const deps = { env: process.env, source: localSource, api: transport.api, emit: output };
  if (process.argv[2] === 'plan') await planRelease(deps);
  else {
    const path = process.env.GITHUB_EVENT_PATH;
    need(path, 'EVENT_REQUIRED');
    let descriptor, bytes;
    try {
      descriptor = openSync(path, 'r');
      const info = fstatSync(descriptor);
      need(info.isFile() && info.size <= AUTOMATION_LIMITS.jsonBytes, 'EVENT_TOO_LARGE');
      const buffer = Buffer.alloc(AUTOMATION_LIMITS.jsonBytes + 1);
      const length = readSync(descriptor, buffer, 0, buffer.length, 0);
      need(length === info.size && length <= AUTOMATION_LIMITS.jsonBytes, 'EVENT_TOO_LARGE');
      bytes = buffer.subarray(0, length);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    const completion = {
      ...deps,
      event: JSON.parse(bytes),
      registryJson: transport.json,
    };
    if (process.argv[2] === 'completion-plan') await planCompletion(completion);
    else
      await finalizeRelease({
        ...completion,
        verifyRegistries: (options) => verifyOfficialRegistries(options, { transport }),
      });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `Public release stopped: ${error.message}. No failed mutation is retried; inspect remote state before rerunning.`,
    );
    process.exitCode = 1;
  });
}
