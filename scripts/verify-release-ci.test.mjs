import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsers } from 'prettier/plugins/yaml';
import {
  RELEASE_CI_LIMITS,
  FULL_PUBLIC_CI_STEP,
  qualifyReleaseCi,
  verifyReleaseCi,
  githubRead,
} from './verify-release-ci.mjs';
import {
  assertReleaseContext,
  assertAutomaticReleaseEvent,
  assertReleaseCheckout,
  releaseContext,
  releaseSourceContext,
  RELEASE_POLICY,
  RELEASE_CI_LIMITS as IDENTITY_LIMITS,
} from './public-release-identity.mjs';
import { postbuildLanes } from './public-ci-postbuild.mjs';

// Child fixtures inherit OS necessities, not the hosting workflow's identity or credentials.
function fixtureEnvironment(overrides = {}, ambient = process.env) {
  const allowed = new Set([
    'path',
    'systemroot',
    'windir',
    'home',
    'userprofile',
    'tmp',
    'temp',
    'tmpdir',
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(ambient).filter(([key]) => allowed.has(key.toLowerCase())),
    ),
    ...overrides,
  };
}

const context = {
  repository: '0xmdrakib/AgentDomain',
  repositoryId: '1310051881',
  owner: '0xmdrakib',
  ownerId: '113634586',
  actor: '0xmdrakib',
  actorId: '113634586',
  triggeringActor: '0xmdrakib',
  workflowRef: '0xmdrakib/AgentDomain/.github/workflows/publish-npm.yml@refs/heads/main',
  ref: 'refs/heads/main',
  sha: 'a'.repeat(40),
};
const run = {
  id: 1,
  run_attempt: 1,
  url: `https://api.github.com/repos/${context.repository}/actions/runs/1`,
  actor: { login: '0xmdrakib', id: 113634586, type: 'User' },
  triggering_actor: { login: '0xmdrakib', id: 113634586, type: 'User' },
  head_sha: context.sha,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  path: '.github/workflows/public-ci.yml',
  repository: {
    full_name: context.repository,
    id: 1310051881,
    owner: { login: context.owner, id: 113634586 },
  },
  head_repository: {
    full_name: context.repository,
    id: 1310051881,
    owner: { login: context.owner, id: 113634586 },
  },
};
const payload = (runs = [run]) => ({
  total_count: runs.length,
  workflow_runs: runs,
  current_main: { sha: context.sha },
  qualification_jobs: {
    total_count: 1,
    jobs: [
      {
        id: 10,
        run_id: runs[0]?.id,
        run_url: runs[0]?.url,
        head_sha: context.sha,
        head_branch: 'main',
        workflow_name: 'Public CI',
        name: 'Boundary, packages, frontend, docs, and Cloudflare',
        status: 'completed',
        conclusion: 'success',
        steps: [
          { name: FULL_PUBLIC_CI_STEP, number: 20, status: 'completed', conclusion: 'success' },
        ],
      },
    ],
  },
  source_commit: { sha: context.sha, commit: { verification: { verified: true } } },
  triggering_operator: { login: '0xmdrakib', id: 113634586 },
});

const automaticContext = {
  ...context,
  repository: 'Talvono/AgentDomain',
  owner: 'Talvono',
  ownerId: '342912183',
  workflowRef: 'Talvono/AgentDomain/.github/workflows/publish-npm.yml@refs/heads/main',
  eventName: 'workflow_run',
};
const automaticRepository = {
  full_name: automaticContext.repository,
  id: 1310051881,
  owner: { login: 'Talvono', id: 342912183, type: 'Organization' },
};
const automaticRun = {
  ...run,
  name: 'Public CI',
  workflow_id: 100,
  url: 'https://api.github.com/repos/Talvono/AgentDomain/actions/runs/1',
  repository: automaticRepository,
  head_repository: automaticRepository,
};
const automaticEvent = () =>
  structuredClone({
    action: 'completed',
    repository: automaticRepository,
    workflow_run: automaticRun,
  });
const boundContext = () => ({
  ...automaticContext,
  sourceRun: assertAutomaticReleaseEvent(automaticContext, automaticEvent()),
});
const automaticPayload = (runs = [automaticRun]) => {
  const p = payload(runs);
  p.triggering_operator.type = 'User';
  return p;
};
const automaticEnvironment = (eventPath) => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_run',
  GITHUB_EVENT_PATH: eventPath,
  GITHUB_REPOSITORY: automaticContext.repository,
  GITHUB_REPOSITORY_ID: automaticContext.repositoryId,
  GITHUB_REPOSITORY_OWNER: automaticContext.owner,
  GITHUB_REPOSITORY_OWNER_ID: automaticContext.ownerId,
  GITHUB_ACTOR: automaticContext.actor,
  GITHUB_ACTOR_ID: automaticContext.actorId,
  GITHUB_TRIGGERING_ACTOR: automaticContext.triggeringActor,
  GITHUB_WORKFLOW_REF: automaticContext.workflowRef,
  GITHUB_REF: automaticContext.ref,
  GITHUB_SHA: automaticContext.sha,
});

function fixtureRequest(p, paths) {
  return async (path) => {
    paths.push(path);
    if (path === `users/${automaticContext.triggeringActor}`)
      return structuredClone(p.triggering_operator);
    if (path.endsWith(`/commits/${automaticContext.sha}`)) return structuredClone(p.source_commit);
    if (path.endsWith('/commits/main')) return structuredClone(p.current_main);
    if (path.includes('/actions/workflows/public-ci.yml/runs?')) return structuredClone(p);
    if (/\/attempts\/\d+\/jobs\?per_page=100$/.test(path))
      return structuredClone(p.qualification_jobs);
    const selected = p.workflow_runs.find((item) => path.endsWith(`/actions/runs/${item.id}`));
    if (selected) return structuredClone(selected);
    assert.fail(path);
  };
}

test('automatic release event binds the actual publisher SHA to exact signed-source qualification', () => {
  const bound = boundContext();
  assert.deepEqual(bound.sourceRun, {
    id: 1,
    run_attempt: 1,
    workflow_id: 100,
    head_sha: context.sha,
  });
  assert.equal(verifyReleaseCi(automaticPayload(), bound), 1);
  for (const workflow of ['publish-npm.yml', 'publish-python.yml']) {
    const publisher = {
      ...bound,
      workflowRef: `${bound.repository}/.github/workflows/${workflow}@refs/heads/main`,
    };
    assertReleaseContext(publisher);
    assertReleaseCheckout(publisher, context.sha);
    assert.throws(() => assertReleaseCheckout(publisher, 'b'.repeat(40)));
  }
  assert.strictEqual(IDENTITY_LIMITS, RELEASE_CI_LIMITS);
  assert.equal(typeof githubRead, 'function');
});

test('automatic event refuses PR, forks, wrong source, wrong workflow, actors and incomplete attempts', () => {
  for (const mutate of [
    (event) => {
      event.action = 'requested';
    },
    (event) => {
      event.workflow_run.event = 'pull_request';
    },
    (event) => {
      event.workflow_run.event = 'pull_request_target';
    },
    (event) => {
      event.workflow_run.event = 'workflow_dispatch';
    },
    (event) => {
      event.workflow_run.status = 'in_progress';
    },
    (event) => {
      event.workflow_run.conclusion = 'failure';
    },
    (event) => {
      event.workflow_run.conclusion = 'skipped';
    },
    (event) => {
      event.workflow_run.head_branch = 'feature';
    },
    (event) => {
      event.workflow_run.head_sha = 'b'.repeat(40);
    },
    (event) => {
      event.workflow_run.id = '1';
    },
    (event) => {
      event.workflow_run.run_attempt = 0;
    },
    (event) => {
      event.workflow_run.workflow_id = 0;
    },
    (event) => {
      event.workflow_run.name = 'Other CI';
    },
    (event) => {
      event.workflow_run.path = '.github/workflows/publish-npm.yml';
    },
    (event) => {
      event.workflow_run.url = 'https://api.github.com/repos/foreign/AgentDomain/actions/runs/1';
    },
    (event) => {
      event.workflow_run.actor.id = 42;
    },
    (event) => {
      event.workflow_run.actor.type = 'Bot';
    },
    (event) => {
      event.workflow_run.triggering_actor.id = 42;
    },
    (event) => {
      event.workflow_run.triggering_actor.login = 'Talvono';
    },
    (event) => {
      event.workflow_run.triggering_actor.type = 'Bot';
    },
    (event) => {
      event.repository.id = 42;
    },
    (event) => {
      event.repository.owner.id = 42;
    },
    (event) => {
      event.workflow_run.repository.id = 42;
    },
    (event) => {
      event.workflow_run.repository.owner.id = 42;
    },
    (event) => {
      event.workflow_run.head_repository = null;
    },
    (event) => {
      event.workflow_run.head_repository.id = 42;
    },
    (event) => {
      event.workflow_run.head_repository.full_name = 'foreign/AgentDomain';
    },
    (event) => {
      event.workflow_run.head_repository.owner.login = '0xmdrakib';
    },
    (event) => {
      event.workflow_run.head_repository.owner.id = 113634586;
    },
  ]) {
    const event = automaticEvent();
    mutate(event);
    assert.throws(() => assertAutomaticReleaseEvent(automaticContext, event));
  }
  for (const patch of [
    { sha: 'b'.repeat(40) },
    { actorId: '42' },
    { triggeringActor: 'someone' },
    { repositoryId: '42' },
    { ownerId: '113634586' },
    { workflowRef: automaticContext.workflowRef.replace('main', 'feature') },
    { ref: 'refs/tags/npm-v0.11.1' },
    { eventName: 'workflow_dispatch' },
    { eventName: 'push' },
    { qualificationWorkflow: 'complete-public-release.yml' },
  ])
    assert.throws(() =>
      assertAutomaticReleaseEvent({ ...automaticContext, ...patch }, automaticEvent()),
    );
  assert.throws(() =>
    assertAutomaticReleaseEvent({ ...context, eventName: 'workflow_run' }, automaticEvent()),
  );
});

test('automatic qualification cannot substitute another run, workflow, attempt or newer partial green', () => {
  const bound = boundContext();
  for (const patch of [
    { id: 2, url: automaticRun.url.replace('/1', '/2') },
    { run_attempt: 2 },
    { workflow_id: 101 },
    { name: 'Other CI' },
    { event: 'workflow_dispatch' },
  ])
    assert.throws(() => verifyReleaseCi(automaticPayload([{ ...automaticRun, ...patch }]), bound));
  const newer = automaticPayload([
    automaticRun,
    { ...automaticRun, id: 2, url: automaticRun.url.replace('/1', '/2') },
  ]);
  newer.qualification_jobs.jobs[0].steps[0].conclusion = 'skipped';
  assert.throws(() => verifyReleaseCi(newer, bound), /RELEASE_CI_SUCCESS_REQUIRED/);
  const newestRun = newer.workflow_runs[1];
  const newestEvent = automaticEvent();
  newestEvent.workflow_run = newestRun;
  const newestBound = {
    ...automaticContext,
    sourceRun: assertAutomaticReleaseEvent(automaticContext, newestEvent),
  };
  const partial = automaticPayload([newestRun, automaticRun]);
  partial.qualification_jobs.jobs[0].steps[0].conclusion = 'skipped';
  assert.throws(
    () => verifyReleaseCi(partial, newestBound),
    /RELEASE_CI_FULL_QUALIFICATION_REQUIRED/,
  );
  for (const mutate of [
    (p) => {
      p.current_main.sha = 'b'.repeat(40);
    },
    (p) => {
      p.source_commit.commit.verification.verified = false;
    },
    (p) => {
      p.source_commit.sha = 'b'.repeat(40);
    },
    (p) => {
      p.qualification_jobs.jobs[0].steps[0].conclusion = 'skipped';
    },
    (p) => {
      p.qualification_jobs.jobs[0].run_attempt = 2;
    },
    (p) => {
      p.triggering_operator.type = 'Bot';
    },
  ]) {
    const p = automaticPayload();
    mutate(p);
    assert.throws(() => verifyReleaseCi(p, bound));
  }
  assert.throws(() => verifyReleaseCi(automaticPayload(), { ...bound, sourceRun: undefined }));
  assert.throws(() => verifyReleaseCi(automaticPayload(), { ...bound, eventName: undefined }));
});

test('automatic exact-trigger qualification keeps nine bounded reads and rejects all observed drift', async () => {
  const bound = boundContext();
  const paths = [];
  assert.equal(await qualifyReleaseCi(bound, fixtureRequest(automaticPayload(), paths)), 1);
  assert.equal(paths.length, 9);
  for (const drift of ['attempt', 'workflow', 'name', 'actor', 'repository', 'latest', 'main']) {
    let reads = 0;
    const request = fixtureRequest(automaticPayload(), []);
    await assert.rejects(() =>
      qualifyReleaseCi(bound, async (path) => {
        const result = await request(path);
        reads++;
        if (reads === 7) {
          if (drift === 'attempt') result.run_attempt = 2;
          if (drift === 'workflow') result.workflow_id = 101;
          if (drift === 'name') result.name = 'Other CI';
          if (drift === 'actor') result.actor.type = 'Bot';
          if (drift === 'repository') result.head_repository.owner.id = 42;
        }
        if (drift === 'latest' && reads === 8) {
          result.workflow_runs.push({ ...automaticRun, id: 2, status: 'queued', conclusion: null });
          result.total_count++;
        }
        if (drift === 'main' && reads === 9) result.sha = 'b'.repeat(40);
        return result;
      }),
    );
  }
});

test('releaseContext reads bounded event files without git or overriding ambient publisher variables', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentdomain-release-event-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = join(directory, 'event.json');
  const environment = {
    ...automaticEnvironment(eventPath),
    GITHUB_WORKSPACE: join(directory, 'no-checkout'),
  };
  const original = structuredClone(environment);
  const json = JSON.stringify(automaticEvent());
  await writeFile(eventPath, json.padEnd(RELEASE_CI_LIMITS.maxBytes, ' '));
  const bound = releaseContext(environment);
  assert.deepEqual(bound.sourceRun, boundContext().sourceRun);
  assert.deepEqual(environment, original);
  assert.equal(bound.sha, environment.GITHUB_SHA);
  assert.ok(Object.isFrozen(bound));
  assert.ok(Object.isFrozen(bound.sourceRun));
  for (const body of [
    '',
    '{',
    'private-body-marker',
    json.padEnd(RELEASE_CI_LIMITS.maxBytes + 1, ' '),
  ]) {
    await writeFile(eventPath, body);
    assert.throws(() => releaseContext(environment), /^Error: RELEASE_CONTEXT_INVALID$/);
  }
  assert.throws(() => releaseContext({ ...environment, GITHUB_EVENT_PATH: directory }));
  assert.throws(() =>
    releaseContext({ ...environment, GITHUB_EVENT_PATH: join(directory, 'missing') }),
  );
  await writeFile(eventPath, json);
  for (const eventName of [
    'workflow_dispatch',
    'push',
    'pull_request',
    'pull_request_target',
    'issue_comment',
    undefined,
  ])
    assert.throws(() => releaseContext({ ...environment, GITHUB_EVENT_NAME: eventName }));
  assert.throws(() => releaseContext({ ...environment, GITHUB_SHA: 'b'.repeat(40) }));
  assert.throws(() =>
    releaseContext({
      ...environment,
      GITHUB_WORKFLOW_REF: automaticContext.workflowRef.replace('main', 'feature'),
    }),
  );
  assert.doesNotThrow(() =>
    releaseContext({ ...environment, GITHUB_EVENT_NAME: undefined, GITHUB_ACTIONS: undefined }),
  );
});

test('releaseContext rejects symlinked event files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentdomain-release-event-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'event.json');
  const link = join(directory, 'link.json');
  await writeFile(target, JSON.stringify(automaticEvent()));
  try {
    await symlink(target, link, 'file');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip('Host does not permit file symlinks.');
    return;
  }
  assert.throws(() => releaseContext(automaticEnvironment(link)));
});

test('automatic CLI qualifies checkout-free sealed use and rejects manual publisher events', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentdomain-automatic-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = join(directory, 'event.json');
  const output = join(directory, 'output');
  await writeFile(eventPath, JSON.stringify(automaticEvent()));
  const filename = fileURLToPath(new URL('./verify-release-ci.mjs', import.meta.url));
  const environment = fixtureEnvironment({
    ...automaticEnvironment(eventPath),
    GITHUB_WORKSPACE: join(directory, 'checkout-does-not-exist'),
    GITHUB_OUTPUT: output,
  });
  const result = spawnSync(process.execPath, [filename], {
    env: environment,
    input: JSON.stringify(automaticPayload()),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(output, 'utf8'),
    `publication-authorized=${RELEASE_POLICY.activeOwner === 'Talvono'}\n`,
  );
  for (const eventName of ['workflow_dispatch', 'push', 'pull_request', undefined]) {
    const rejectedOutput = `${output}-${eventName ?? 'missing'}`;
    const rejected = spawnSync(process.execPath, [filename], {
      env: { ...environment, GITHUB_EVENT_NAME: eventName, GITHUB_OUTPUT: rejectedOutput },
      input: JSON.stringify(automaticPayload()),
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    await assert.rejects(readFile(rejectedOutput), { code: 'ENOENT' });
  }
});

test('CLI fixtures isolate ambient CI identity while real Actions events cannot fall back', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentdomain-ambient-ci-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventPath = join(directory, 'allowed-event.json');
  const hostilePath = join(directory, 'fork-event.json');
  const ambientOutput = join(directory, 'ambient-output');
  const output = join(directory, 'fixture-output');
  const fork = automaticEvent();
  fork.workflow_run.head_repository = {
    ...automaticRepository,
    full_name: 'foreign/AgentDomain',
    id: 42,
    owner: { login: 'foreign', id: 42 },
  };
  await writeFile(eventPath, JSON.stringify(automaticEvent()));
  await writeFile(hostilePath, JSON.stringify(fork));
  const ambient = {
    ...fixtureEnvironment(),
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: hostilePath,
    GITHUB_REPOSITORY: 'foreign/AgentDomain',
    GITHUB_REPOSITORY_ID: '42',
    GITHUB_REPOSITORY_OWNER: 'foreign',
    GITHUB_REPOSITORY_OWNER_ID: '42',
    GITHUB_ACTOR: 'foreign',
    GITHUB_ACTOR_ID: '42',
    GITHUB_TRIGGERING_ACTOR: 'foreign',
    GITHUB_WORKFLOW_REF: 'foreign/AgentDomain/.github/workflows/publish-npm.yml@refs/pull/84/merge',
    GITHUB_REF: 'refs/pull/84/merge',
    GITHUB_SHA: 'b'.repeat(40),
    GITHUB_OUTPUT: ambientOutput,
    GH_TOKEN: 'ambient-credential-must-not-pass',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ambient-oidc-must-not-pass',
    NODE_OPTIONS: '--ambient-node-option-must-not-pass',
  };
  const original = structuredClone(ambient);
  const environment = fixtureEnvironment(
    {
      ...automaticEnvironment(eventPath),
      GITHUB_OUTPUT: output,
    },
    ambient,
  );
  for (const key of ['CI', 'GH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'NODE_OPTIONS'])
    assert.equal(environment[key], undefined);
  assert.equal(environment.GITHUB_EVENT_NAME, 'workflow_run');
  assert.equal(environment.GITHUB_SHA, automaticContext.sha);
  assert.equal(environment.GITHUB_OUTPUT, output);
  assert.deepEqual(ambient, original);
  assert.throws(() => releaseContext(ambient));
  assert.doesNotThrow(() => releaseContext(environment));

  const filename = fileURLToPath(new URL('./verify-release-ci.mjs', import.meta.url));
  const input = JSON.stringify(automaticPayload());
  const accepted = spawnSync(process.execPath, [filename], {
    env: environment,
    input,
    encoding: 'utf8',
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(
    await readFile(output, 'utf8'),
    `publication-authorized=${RELEASE_POLICY.activeOwner === 'Talvono'}\n`,
  );
  await assert.rejects(readFile(ambientOutput), { code: 'ENOENT' });

  for (const [index, patch] of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_EVENT_NAME: undefined },
    { GITHUB_EVENT_PATH: hostilePath },
    { GITHUB_EVENT_PATH: undefined },
    { GITHUB_SHA: 'b'.repeat(40) },
  ].entries()) {
    const rejectedOutput = join(directory, `rejected-${index}`);
    const actions = { ...environment, ...patch, GITHUB_OUTPUT: rejectedOutput };
    assert.equal(actions.GITHUB_ACTIONS, 'true');
    assert.throws(() => releaseContext(actions));
    const rejected = spawnSync(process.execPath, [filename], {
      env: actions,
      input,
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    await assert.rejects(readFile(rejectedOutput), { code: 'ENOENT' });
  }
});

test('finalizer source context requires explicit exact Public CI binding without authorizing a publisher', async () => {
  const environment = {
    ...automaticEnvironment('intentionally-not-read'),
    GITHUB_WORKFLOW_REF:
      'Talvono/AgentDomain/.github/workflows/complete-public-release.yml@refs/heads/main',
  };
  const bound = releaseSourceContext(environment, {
    workflow: 'complete-public-release.yml',
    sourceRun: automaticRun,
  });
  assert.deepEqual(bound.sourceRun, boundContext().sourceRun);
  const paths = [];
  assert.equal(await qualifyReleaseCi(bound, fixtureRequest(automaticPayload(), paths)), 1);
  assert.equal(paths.length, 9);
  assert.throws(() => assertReleaseContext(bound, true));
  assert.throws(() => assertReleaseContext(bound, true, 'publish-npm.yml'));
  assert.throws(() => assertAutomaticReleaseEvent(bound, automaticEvent()));
  for (const options of [
    undefined,
    { workflow: 'publish-npm.yml', sourceRun: automaticRun },
    { workflow: 'other.yml', sourceRun: automaticRun },
    { workflow: 'complete-public-release.yml', sourceRun: bound.sourceRun },
    {
      workflow: 'complete-public-release.yml',
      sourceRun: { ...automaticRun, head_sha: 'b'.repeat(40) },
    },
    {
      workflow: 'complete-public-release.yml',
      sourceRun: { ...automaticRun, event: 'pull_request' },
    },
  ])
    assert.throws(() => releaseSourceContext(environment, options));
  assert.throws(() =>
    releaseSourceContext(
      { ...environment, GITHUB_EVENT_NAME: 'workflow_dispatch' },
      {
        workflow: 'complete-public-release.yml',
        sourceRun: automaticRun,
      },
    ),
  );
});

test('requires successful Public CI for the exact public main commit', () => {
  assert.equal(verifyReleaseCi(payload(), context), 1);
  for (const patch of [
    { repository: 'someone/AgentDomain' },
    { ref: 'refs/heads/codex/feature' },
    { sha: 'a'.repeat(39) },
    { repositoryId: '1310051882' },
    { ownerId: '342912183' },
    { actorId: '342912183' },
    { actor: 'Talvono' },
    { triggeringActor: 'someone' },
    { workflowRef: 'someone/AgentDomain/.github/workflows/publish-npm.yml@refs/heads/main' },
  ])
    assert.throws(() => verifyReleaseCi(payload(), { ...context, ...patch }));
});

test('partial green, absent or duplicated full marker and incomplete attempt jobs never authorize release', () => {
  for (const mutate of [
    (p) => {
      delete p.qualification_jobs;
    },
    (p) => {
      p.qualification_jobs.jobs[0].steps[0].conclusion = 'skipped';
    },
    (p) => {
      p.qualification_jobs.jobs[0].steps = [];
    },
    (p) => {
      p.qualification_jobs.jobs[0].steps.push(p.qualification_jobs.jobs[0].steps[0]);
    },
    (p) => {
      p.qualification_jobs.total_count = 2;
    },
    (p) => {
      p.qualification_jobs.jobs[0].head_sha = 'b'.repeat(40);
    },
    (p) => {
      p.qualification_jobs.jobs[0].run_id = 2;
    },
    (p) => {
      p.qualification_jobs.jobs[0].run_attempt = 2;
    },
    (p) => {
      p.current_main.sha = 'b'.repeat(40);
    },
    (p) => {
      p.total_count = 11;
    },
    (p) => {
      p.workflow_runs.push(structuredClone(p.workflow_runs[0]));
      p.total_count++;
    },
  ]) {
    const p = structuredClone(payload());
    mutate(p);
    assert.throws(() => verifyReleaseCi(p, context));
  }
  assert.equal(verifyReleaseCi(payload([{ ...run, event: 'workflow_dispatch' }]), context), 1);
  assert.throws(() =>
    verifyReleaseCi(
      payload([{ ...run, event: 'workflow_dispatch', actor: { ...run.actor, id: 42 } }]),
      context,
    ),
  );
  assert.throws(() =>
    verifyReleaseCi(payload([run, { ...run, id: 2, status: 'queued', conclusion: null }]), context),
  );
});

test('read-only release qualification binds the full marker to a fresh exact attempt in nine reads', async () => {
  const p = payload();
  const paths = [];
  const request = async (path) => {
    paths.push(path);
    if (path === `users/${context.triggeringActor}`) return structuredClone(p.triggering_operator);
    if (path.endsWith(`/commits/${context.sha}`)) return structuredClone(p.source_commit);
    if (path.endsWith('/commits/main')) return structuredClone(p.current_main);
    if (path.includes('/actions/workflows/public-ci.yml/runs?')) return structuredClone(p);
    if (path.endsWith('/attempts/1/jobs?per_page=100'))
      return structuredClone(p.qualification_jobs);
    if (path.endsWith('/actions/runs/1')) {
      const detail = structuredClone(run);
      detail.actor.avatar_url = 'https://avatars.githubusercontent.com/operator';
      detail.repository.description = 'Public repository';
      detail.head_repository.owner.html_url = 'https://github.com/0xmdrakib';
      return detail;
    }
    assert.fail(path);
  };
  assert.equal(await qualifyReleaseCi(context, request), 1);
  assert.equal(paths.length, 9);
  assert.ok(
    paths.includes(`repos/${context.repository}/actions/runs/1/attempts/1/jobs?per_page=100`),
  );
  for (const drift of ['attempt', 'latest', 'main', 'actor', 'repository']) {
    let reads = 0;
    await assert.rejects(() =>
      qualifyReleaseCi(context, async (path) => {
        const result = await request(path);
        reads++;
        if (drift === 'attempt' && reads === 7) result.run_attempt = 2;
        if (drift === 'latest' && reads === 8)
          result.workflow_runs.push({ ...run, id: 2, status: 'queued', conclusion: null });
        if (drift === 'latest' && reads === 8) result.total_count++;
        if (drift === 'main' && reads === 9) result.sha = 'b'.repeat(40);
        if (drift === 'actor' && reads === 7) result.triggering_actor.id = 42;
        if (drift === 'repository' && reads === 7) result.repository.owner.id = 42;
        return result;
      }),
    );
  }
});

test('a newer partial green cannot fall back to older full qualification', async () => {
  const p = payload([run, { ...run, id: 2, url: run.url.replace('/1', '/2') }]);
  let jobReads = 0;
  await assert.rejects(
    () =>
      qualifyReleaseCi(context, async (path) => {
        if (path === `users/${context.triggeringActor}`) return p.triggering_operator;
        if (path.endsWith(`/commits/${context.sha}`)) return p.source_commit;
        if (path.endsWith('/commits/main')) return p.current_main;
        if (path.includes('/actions/workflows/public-ci.yml/runs?')) return p;
        if (path.endsWith('/actions/runs/2')) return p.workflow_runs[1];
        if (path.endsWith('/actions/runs/2/attempts/1/jobs?per_page=100')) {
          jobReads++;
          const jobs = structuredClone(p.qualification_jobs);
          jobs.jobs[0].run_id = 2;
          jobs.jobs[0].run_url = p.workflow_runs[1].url;
          jobs.jobs[0].steps[0].conclusion = 'skipped';
          return jobs;
        }
        assert.fail(path);
      }),
    /RELEASE_CI_FULL_QUALIFICATION_REQUIRED/,
  );
  assert.equal(jobReads, 1);
});

test('rejects skipped, failed, unrelated, fork and pull-request checks', () => {
  for (const patch of [
    { id: '1' },
    { id: -1 },
    { head_sha: 'b'.repeat(40) },
    { head_branch: 'codex/feature' },
    { event: 'pull_request' },
    { status: 'in_progress' },
    { conclusion: 'skipped' },
    { conclusion: 'failure' },
    { path: '.github/workflows/publish-npm.yml' },
    { repository: { full_name: 'someone/AgentDomain' } },
    { head_repository: { full_name: 'someone/AgentDomain' } },
    { head_repository: null },
    { repository: { ...run.repository, id: 42 } },
    { head_repository: { ...run.head_repository, id: 42 } },
    { repository: { ...run.repository, owner: { login: context.owner, id: 42 } } },
    { head_repository: { ...run.head_repository, owner: { login: 'Talvono', id: 342912183 } } },
  ])
    assert.throws(() => verifyReleaseCi(payload([{ ...run, ...patch }]), context));
  for (const body of [null, {}, payload([]), payload(Array(11).fill(run))])
    assert.throws(() => verifyReleaseCi(body, context));
});

test('qualification accepts only both exact owner identities, not publication aliases', () => {
  const future = {
    ...context,
    repository: 'Talvono/AgentDomain',
    owner: 'Talvono',
    ownerId: '342912183',
    workflowRef: 'Talvono/AgentDomain/.github/workflows/publish-npm.yml@refs/heads/main',
  };
  const repository = {
    id: 1310051881,
    full_name: future.repository,
    owner: { login: 'Talvono', id: 342912183 },
  };
  assert.equal(
    verifyReleaseCi(
      payload([
        {
          ...run,
          url: `https://api.github.com/repos/${future.repository}/actions/runs/1`,
          repository,
          head_repository: repository,
        },
      ]),
      future,
    ),
    1,
  );
  for (const candidate of [context, future]) {
    if (candidate.owner === RELEASE_POLICY.activeOwner) assertReleaseContext(candidate, true);
    else assert.throws(() => assertReleaseContext(candidate, true));
  }
  assert.throws(() => assertReleaseContext({ ...future, ownerId: '113634586' }));
  assert.throws(() => assertReleaseContext({ ...future, actor: 'Talvono', actorId: '342912183' }));
  assert.ok(['0xmdrakib', 'Talvono'].includes(RELEASE_POLICY.activeOwner));
});

test('signature, source SHA and triggering human numeric identity must qualify', () => {
  for (const patch of [
    { source_commit: { sha: context.sha, commit: { verification: { verified: false } } } },
    { source_commit: { sha: 'b'.repeat(40), commit: { verification: { verified: true } } } },
    { source_commit: {} },
    { triggering_operator: { login: '0xmdrakib', id: 42 } },
    { triggering_operator: { login: 'Talvono', id: 113634586 } },
  ])
    assert.throws(() => verifyReleaseCi({ ...payload(), ...patch }, context));
});

test('only a trusted source-policy change switches publication authority', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentdomain-policy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyFile(
    new URL('./public-release-identity.mjs', import.meta.url),
    join(directory, 'public-release-identity.mjs'),
  );
  const nextOwner = RELEASE_POLICY.activeOwner === 'Talvono' ? '0xmdrakib' : 'Talvono';
  await writeFile(
    join(directory, 'public-release-policy.json'),
    JSON.stringify({ ...RELEASE_POLICY, activeOwner: nextOwner }),
  );
  const flipped = await import(pathToFileURL(join(directory, 'public-release-identity.mjs')).href);
  const future = {
    ...context,
    repository: 'Talvono/AgentDomain',
    owner: 'Talvono',
    ownerId: '342912183',
    workflowRef: 'Talvono/AgentDomain/.github/workflows/publish-npm.yml@refs/heads/main',
  };
  const next = nextOwner === 'Talvono' ? future : context;
  const previous = nextOwner === 'Talvono' ? context : future;
  flipped.assertReleaseContext(next, true);
  assert.throws(() => flipped.assertReleaseContext(previous, true));
  assert.throws(() => assertReleaseContext(next, true));
});

test('CLI rejects malformed and oversized bodies without logging their contents', () => {
  const filename = fileURLToPath(new URL('./verify-release-ci.mjs', import.meta.url));
  for (const input of ['private-body-marker', 'x'.repeat(RELEASE_CI_LIMITS.maxBytes + 1)]) {
    const result = spawnSync(process.execPath, [filename], {
      env: fixtureEnvironment(),
      input,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /private-body-marker|xxxxxxxx/);
    assert.equal(result.stdout, '');
  }
});

test('CLI emits publication authority only after exact-source qualification', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentdomain-qualification-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = fileURLToPath(new URL('./verify-release-ci.mjs', import.meta.url));
  for (const owner of ['0xmdrakib', 'Talvono']) {
    const repository = `${owner}/AgentDomain`;
    const ownerId = RELEASE_POLICY.owners[owner];
    const source = {
      full_name: repository,
      id: 1310051881,
      owner: { login: owner, id: Number(ownerId) },
    };
    const output = join(directory, owner);
    const environment = fixtureEnvironment({
      GITHUB_REPOSITORY: repository,
      GITHUB_REPOSITORY_ID: '1310051881',
      GITHUB_REPOSITORY_OWNER: owner,
      GITHUB_REPOSITORY_OWNER_ID: ownerId,
      GITHUB_ACTOR: '0xmdrakib',
      GITHUB_ACTOR_ID: '113634586',
      GITHUB_TRIGGERING_ACTOR: '0xmdrakib',
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish-npm.yml@refs/heads/main`,
      GITHUB_REF: context.ref,
      GITHUB_SHA: context.sha,
      GITHUB_OUTPUT: output,
      ACTIVE_RELEASE_OWNER: 'Talvono',
      PUBLICATION_AUTHORIZED: 'true',
    });
    const result = spawnSync(process.execPath, [filename], {
      env: environment,
      input: JSON.stringify(
        payload([
          {
            ...run,
            url: `https://api.github.com/repos/${repository}/actions/runs/1`,
            repository: source,
            head_repository: source,
          },
        ]),
      ),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(output, 'utf8'),
      `publication-authorized=${owner === RELEASE_POLICY.activeOwner}\n`,
    );
    const rejectedOutput = `${output}-rejected`;
    const rejected = spawnSync(process.execPath, [filename], {
      env: { ...environment, GITHUB_OUTPUT: rejectedOutput },
      input: JSON.stringify(payload([])),
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 1);
    await assert.rejects(readFile(rejectedOutput), { code: 'ENOENT' });
  }
});

test('publish validation requires this check before packing, with read-only Actions access', async () => {
  const source = await readFile(
    new URL('../.github/workflows/publish-npm.yml', import.meta.url),
    'utf8',
  );
  const validation = source.split('\n  publish:')[0];
  assert.match(validation, /actions: read/);
  assert.match(validation, /node scripts\/verify-release-ci\.mjs --github/);
  assert.ok(
    validation.indexOf('node scripts/verify-release-ci.mjs') <
      validation.indexOf('pack_release packages/shared'),
  );
  const publish = source.split('\n  publish:')[1];
  assert.doesNotMatch(publish, /actions: write|contents: write/);
  const reader = await readFile(new URL('./verify-release-ci.mjs', import.meta.url), 'utf8');
  assert.match(reader, /\['api', '--hostname', 'github\.com', '--method', 'GET', path\]/);
  assert.doesNotMatch(reader, /--paginate|--method', '(?:POST|PATCH|PUT|DELETE)'/);
});

// Use the existing formatter's YAML parser, keeping scalar text uncoerced (including "on").
function yamlValue(node) {
  if (!node) return null;
  if (['mapping', 'flowMapping'].includes(node.type)) {
    const entries = node.children.map(({ children }) => children.map(yamlValue));
    assert.equal(new Set(entries.map(([key]) => key)).size, entries.length, 'Duplicate YAML key');
    return Object.fromEntries(entries);
  }
  if (['sequence', 'flowSequence'].includes(node.type)) return node.children.map(yamlValue);
  if (['plain', 'quoteSingle', 'quoteDouble', 'blockLiteral', 'blockFolded'].includes(node.type))
    return node.value;
  assert.ok(
    ['documentBody', 'mappingKey', 'mappingValue', 'sequenceItem', 'flowSequenceItem'].includes(
      node.type,
    ),
    `Unsupported YAML node: ${node.type}`,
  );
  assert.ok(node.children.length <= 1);
  return yamlValue(node.children[0]);
}

async function readYaml(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const { children } = parsers.yaml.parse(source);
  assert.equal(children.length, 1, `${path} must have one YAML document`);
  return yamlValue(children[0].children.find(({ type }) => type === 'documentBody'));
}

const workflows = {};
for (const file of await readdir(new URL('../.github/workflows/', import.meta.url))) {
  if (/\.ya?ml$/.test(file)) workflows[file] = await readYaml(`.github/workflows/${file}`);
}

function assertCodeqlPins(steps) {
  const codeql = steps.filter((step) => step.uses?.startsWith('github/codeql-action/'));
  const references = codeql.map(({ uses }) => uses.split('@'));
  assert.equal(references.filter(([action]) => action === 'github/codeql-action/init').length, 1);
  assert.equal(
    references.filter(([action]) => action === 'github/codeql-action/analyze').length,
    1,
  );
  for (const [, sha] of references) assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(
    new Set(references.map(([, sha]) => sha)).size,
    1,
    'CodeQL subactions must share a SHA',
  );
}

test('all workflow actions keep immutable pins and setup actions stay coordinated', () => {
  const setupPins = new Map([
    ['actions/setup-python', new Set()],
    ['pnpm/action-setup', new Set()],
  ]);
  for (const workflow of Object.values(workflows)) {
    for (const job of Object.values(workflow.jobs)) {
      for (const { uses } of [job, ...(job.steps ?? [])]) {
        if (!uses || uses.startsWith('./')) continue;
        assert.match(uses, /(?:@[0-9a-f]{40}|@sha256:[0-9a-f]{64})$/);
        const [action, sha] = uses.split('@');
        setupPins.get(action)?.add(sha);
      }
    }
  }
  for (const [action, pins] of setupPins) assert.equal(pins.size, 1, `${action} pins must agree`);
});

test('CodeQL init and analyze share an immutable release, rejecting either partial update', () => {
  assertCodeqlPins(workflows['codeql.yml'].jobs.analyze.steps);
  const oldSha = 'cdf488f595d80d6e07e03d4674febd5ab45fa938';
  const newSha = 'b96794f015dfd88f77b49b1c93e0fa7110f94c63';
  const pair = (init, analyze) => [
    { uses: `github/codeql-action/init@${init}` },
    { uses: `github/codeql-action/analyze@${analyze}` },
  ];
  assertCodeqlPins(pair(newSha, newSha));
  assert.throws(() => assertCodeqlPins(pair(newSha, oldSha)), /must share a SHA/);
  assert.throws(() => assertCodeqlPins(pair(oldSha, newSha)), /must share a SHA/);
  assert.throws(() => assertCodeqlPins(pair('v4', 'v4')));
  assert.throws(() => assertCodeqlPins(pair(newSha, newSha).slice(0, 1)));
});

test('Dependabot groups CodeQL subactions for version and security updates without ignoring them', async () => {
  const config = await readYaml('.github/dependabot.yml');
  const actions = config.updates.find((update) => update['package-ecosystem'] === 'github-actions');
  assert.equal(actions.directory, '/');
  assert.equal(actions.ignore, undefined);
  assert.equal(actions.allow, undefined);
  for (const [name, appliesTo] of [
    ['codeql-actions', 'version-updates'],
    ['codeql-security-updates', 'security-updates'],
  ]) {
    const group = actions.groups[name];
    assert.equal(group['applies-to'] ?? 'version-updates', appliesTo);
    assert.deepEqual(group.patterns, ['github/codeql-action', 'github/codeql-action/*']);
    assert.equal(group['exclude-patterns'], undefined);
    assert.equal(group['update-types'], undefined);
  }
});

test('CodeQL and dependency review remain mandatory on pull requests with scoped permissions', () => {
  for (const [file, jobName] of [
    ['codeql.yml', 'analyze'],
    ['dependency-review.yml', 'review'],
  ]) {
    const workflow = workflows[file];
    assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
    assert.equal(workflow.on.pull_request, null);
    assert.equal(workflow.on.pull_request_target, undefined);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    const job = workflow.jobs[jobName];
    assert.equal(job['continue-on-error'], undefined);
    for (const step of job.steps) {
      assert.equal(step.if, undefined);
      assert.equal(step['continue-on-error'], undefined);
    }
  }
  const codeql = workflows['codeql.yml'];
  assert.deepEqual(codeql.on.push.branches, ['main']);
  assert.ok(codeql.on.schedule.some(({ cron }) => cron));
  assert.equal(codeql.jobs.analyze.if, undefined);
  assert.deepEqual(codeql.jobs.analyze.permissions, {
    actions: 'read',
    contents: 'read',
    packages: 'read',
    'security-events': 'write',
  });
  const review = workflows['dependency-review.yml'].jobs.review;
  assert.equal(review.if, 'github.event.pull_request.base.repo.full_name == github.repository');
  assert.equal(review.permissions, undefined);
});

test('setup updates preserve Python and pnpm inputs without removed pip-install usage', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const pnpmVersion = manifest.packageManager.replace(/^pnpm@/, '');
  for (const workflow of Object.values(workflows)) {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/setup-python@'))
          assert.deepEqual(step.with, { 'python-version': '3.12' });
        if (step.uses?.startsWith('pnpm/action-setup@'))
          assert.deepEqual(step.with, { version: pnpmVersion });
      }
    }
  }
});

test('build and release workflows use a coordinated supported Node 22 runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.node, '>=22.19.0');
  for (const file of ['public-ci.yml', 'publish-npm.yml', 'publish-python.yml']) {
    const setup = Object.values(workflows[file].jobs).flatMap((job) =>
      (job.steps ?? []).filter((step) => step.uses?.startsWith('actions/setup-node@')),
    );
    assert.ok(setup.length > 0, `${file}: missing Node setup`);
    for (const step of setup) assert.equal(step.with['node-version'], '22.23.2');
  }
});

test('public workflow combines checks once without weakening required contexts or runtime qualification', () => {
  const workflow = workflows['public-ci.yml'];
  const job = workflow.jobs.verify;
  assert.equal(job.name, 'Boundary, packages, frontend, docs, and Cloudflare');
  assert.equal(workflows['codeql.yml'].jobs.analyze.name, 'JavaScript and TypeScript');
  assert.equal(workflows['dependency-review.yml'].jobs.review.name, 'Review dependency changes');
  assert.equal(workflow.on.pull_request, null);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(job.if, undefined);
  const commands = job.steps.flatMap((step) => (step.run ? [step.run] : []));
  assert.equal(
    commands.filter((command) => command === 'pnpm ci:public --affected --cloudflare').length,
    1,
  );
  assert.doesNotMatch(commands.join('\n'), /pnpm ci:cloudflare|verify-release-ci\.test\.mjs/);
  assert.ok(
    commands.some((command) => command.includes('node --test scripts/npm-release.test.mjs')),
  );
  const postbuild = job.steps.filter((step) => step.id === 'public-postbuild');
  assert.equal(postbuild.length, 1);
  assert.equal(postbuild[0].run, 'node scripts/public-ci-postbuild.mjs');
  assert.equal(postbuild[0].if, undefined);
  assert.deepEqual(postbuild[0].env, {
    PUBLIC_CI_POSTBUILD_SCOPE: '${{ steps.public-scope.outputs.scope }}',
  });
  const lanes = postbuildLanes('full');
  assert.deepEqual(
    lanes.map(({ name }) => name),
    ['web', 'native-python'],
  );
  assert.ok(
    lanes[0].script.includes('node apps/frontend/test/siwe-auth.browser.mjs "$tools/package"'),
  );
  assert.ok(
    lanes[0].script.includes(
      'pnpm --dir apps/frontend exec opennextjs-cloudflare preview --env preview --ip 127.0.0.1 --port 8790',
    ),
  );
  assert.ok(
    lanes[0].script.includes(
      'node apps/frontend/test/footer-routes.smoke.mjs http://127.0.0.1:8790',
    ),
  );
  for (const step of job.steps) {
    assert.equal(step['continue-on-error'], undefined);
  }
});

test('release OIDC remains isolated to pinned identity and active-policy qualification', () => {
  for (const [file, environment] of [
    ['publish-npm.yml', 'npm-production'],
    ['publish-python.yml', 'pypi-production'],
  ]) {
    const workflow = workflows[file];
    assert.deepEqual(workflow.on, {
      workflow_run: { workflows: ['Public CI'], types: ['completed'], branches: ['main'] },
    });
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(workflow.jobs.plan.permissions, { contents: 'read', actions: 'read' });
    assert.equal(workflow.jobs.plan.environment, undefined);
    assert.equal(workflow.jobs.validate.needs, 'plan');
    assert.deepEqual(workflow.jobs.validate.permissions, { contents: 'read', actions: 'read' });
    assert.equal(workflow.jobs.validate.environment, undefined);
    const publish = workflow.jobs.publish;
    assert.deepEqual(publish.needs, ['plan', 'validate']);
    const registry = file === 'publish-npm.yml' ? 'npm' : 'Python';
    assert.equal(
      publish.name,
      `Publish ${registry} \${{ needs.plan.outputs.version }} (Public CI \${{ github.event.workflow_run.id }}/\${{ github.event.workflow_run.run_attempt }})`,
    );
    const github = {
      ref: 'refs/heads/main',
      repository_id: '1310051881',
      repository: 'Talvono/AgentDomain',
      repository_owner_id: '342912183',
      actor: '0xmdrakib',
      actor_id: '113634586',
      triggering_actor: '0xmdrakib',
      sha: automaticContext.sha,
      event_name: 'workflow_run',
      event: {
        action: 'completed',
        repository: structuredClone(automaticRepository),
        workflow_run: {
          ...automaticRun,
          actor: structuredClone(automaticRun.actor),
          triggering_actor: structuredClone(automaticRun.triggering_actor),
          repository: structuredClone(automaticRepository),
          head_repository: structuredClone(automaticRepository),
        },
      },
    };
    const evaluate = (job, source, authorized = 'true', needed = 'true') =>
      Function(
        'github',
        'needs',
        `return (${job.if
          .replaceAll('outputs.publication-authorized', "outputs['publication-authorized']")
          .replaceAll('outputs.release-needed', "outputs['release-needed']")})`,
      )(source, {
        plan: { outputs: { 'release-needed': needed } },
        validate: { outputs: { 'publication-authorized': authorized } },
      });
    for (const job of [workflow.jobs.plan, workflow.jobs.validate, publish]) {
      assert.equal(evaluate(job, github), true);
      for (const patch of [
        { ref: 'refs/heads/feature' },
        { repository_id: '42' },
        { repository: 'someone/AgentDomain' },
        { repository_owner_id: '42' },
        { actor_id: '42' },
        { actor: 'Talvono' },
        { triggering_actor: 'someone' },
        { repository: '0xmdrakib/AgentDomain', repository_owner_id: '113634586' },
        { sha: 'b'.repeat(40) },
        { event_name: 'workflow_dispatch' },
        { event_name: 'pull_request' },
      ])
        assert.equal(evaluate(job, { ...github, ...patch }), false);
      for (const mutate of [
        (source) => {
          source.event.action = 'requested';
        },
        (source) => {
          source.event.repository.id = 42;
        },
        (source) => {
          source.event.repository.owner.id = 42;
        },
        (source) => {
          source.event.repository.full_name = 'foreign/AgentDomain';
        },
        (source) => {
          source.event.workflow_run.head_branch = 'feature';
        },
        (source) => {
          source.event.workflow_run.head_sha = 'b'.repeat(40);
        },
        (source) => {
          source.event.workflow_run.status = 'in_progress';
        },
        (source) => {
          source.event.workflow_run.conclusion = 'failure';
        },
        (source) => {
          source.event.workflow_run.event = 'pull_request';
        },
        (source) => {
          source.event.workflow_run.event = 'workflow_dispatch';
        },
        (source) => {
          source.event.workflow_run.name = 'Other CI';
        },
        (source) => {
          source.event.workflow_run.path = '.github/workflows/other.yml';
        },
        (source) => {
          source.event.workflow_run.id = 0;
        },
        (source) => {
          source.event.workflow_run.run_attempt = 0;
        },
        (source) => {
          source.event.workflow_run.workflow_id = 0;
        },
        (source) => {
          source.event.workflow_run.repository.id = 42;
        },
        (source) => {
          source.event.workflow_run.repository.owner.id = 42;
        },
        (source) => {
          source.event.workflow_run.repository.full_name = 'foreign/AgentDomain';
        },
        (source) => {
          source.event.workflow_run.head_repository.id = 42;
        },
        (source) => {
          source.event.workflow_run.head_repository.owner.id = 42;
        },
        (source) => {
          source.event.workflow_run.head_repository.full_name = 'foreign/AgentDomain';
        },
        (source) => {
          source.event.workflow_run.actor.id = 42;
        },
        (source) => {
          source.event.workflow_run.actor.type = 'Bot';
        },
        (source) => {
          source.event.workflow_run.triggering_actor.id = 42;
        },
        (source) => {
          source.event.workflow_run.triggering_actor.type = 'Bot';
        },
      ]) {
        const source = structuredClone(github);
        mutate(source);
        assert.equal(evaluate(job, source), false, `${file}: ${job.name ?? 'validate'} ${mutate}`);
      }
      assert.equal(job['continue-on-error'], undefined);
    }
    assert.equal(evaluate(workflow.jobs.validate, github, 'true', 'false'), false);
    assert.equal(evaluate(publish, github, 'false'), false);
    assert.equal(
      workflow.jobs.validate.outputs['publication-authorized'],
      '${{ steps.source-qualification.outputs.publication-authorized }}',
    );
    const qualification = workflow.jobs.validate.steps.find(
      (step) => step.id === 'source-qualification',
    );
    assert.match(qualification.run, /node scripts\/verify-release-ci\.mjs --github/);
    assert.deepEqual(qualification.env, { GH_TOKEN: '${{ github.token }}' });
    assert.deepEqual(publish.environment, { name: environment });
    assert.deepEqual(publish.permissions, {
      contents: 'read',
      actions: 'read',
      'id-token': 'write',
    });
  }
});

test('publisher workflows consume sealed same-run inputs and requalify immediately before OIDC mutation', () => {
  for (const file of ['publish-npm.yml', 'publish-python.yml']) {
    const workflow = workflows[file];
    for (const job of [workflow.jobs.plan, workflow.jobs.validate]) {
      const checkout = job.steps.filter((step) => step.uses?.startsWith('actions/checkout@'));
      assert.equal(checkout.length, 1);
      assert.equal(checkout[0].with.ref, '${{ github.event.workflow_run.head_sha }}');
      assert.equal(checkout[0].with['persist-credentials'], 'false');
    }
    const publish = workflow.jobs.publish;
    assert.ok(publish.steps.every((step) => !step.uses?.startsWith('actions/checkout@')));
    const downloads = publish.steps.filter((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    assert.equal(downloads.length, 1);
    assert.deepEqual(Object.keys(downloads[0].with).sort(), ['name', 'path']);
    assert.match(downloads[0].with.name, /\$\{\{ github\.sha \}\}$/);
    const fresh = publish.steps.at(-2);
    assert.equal(fresh.name, 'Requalify the exact source immediately before publication');
    assert.deepEqual(fresh.env, { GH_TOKEN: '${{ github.token }}' });
    assert.match(fresh.run, /node .*(?:verify-release-ci|qualification)\.mjs"? --github$/);
    const commands = Object.values(workflow.jobs)
      .flatMap((job) => job.steps.flatMap((step) => (step.run ? [step.run] : [])))
      .join('\n');
    assert.doesNotMatch(
      commands,
      /inputs\.|github\.event\.inputs|GITHUB_(?:SHA|REF|REPOSITORY)\s*=/,
    );
    for (const job of Object.values(workflow.jobs)) {
      assert.equal(job.env?.GITHUB_SHA, undefined);
      for (const step of job.steps) assert.equal(step.env?.GITHUB_SHA, undefined);
    }
  }

  const npm = workflows['publish-npm.yml'];
  const pack = npm.jobs.validate.steps.find((step) => step.id === 'pack-release').run;
  assert.match(
    pack,
    /for script in npm-release\.mjs release-artifacts\.py public-release-identity\.mjs public-release-policy\.json verify-release-ci\.mjs; do/,
  );
  assert.match(pack, /test "\$\(wc -l < "\$checksums"\)" -eq 13/);
  const verified = npm.jobs.publish.steps.find(
    (step) => step.name === 'Verify staged release inputs',
  ).run;
  assert.match(verified, /test "\$\(wc -l < "\$release_dir\/release\.sha256"\)" -eq 13/);
  assert.ok(
    verified.indexOf('sha256sum --check --strict release.sha256') <
      verified.indexOf('tooling/release-artifacts.py'),
  );
  assert.match(
    npm.jobs.publish.steps.at(-1).run,
    /npm-release\.mjs" "\$release_dir" "\$npm_cli" oidc/,
  );

  const python = workflows['publish-python.yml'];
  const build = python.jobs.validate.steps.find((step) => step.id === 'build').run;
  const stage = python.jobs.publish.steps.find((step) => step.id === 'stage');
  for (const [output, filename] of [
    ['verifier', 'verifier.py'],
    ['policy', 'public-release-policy.json'],
    ['qualification', 'qualification.mjs'],
    ['identity', 'public-release-identity.mjs'],
  ]) {
    assert.equal(
      python.jobs.validate.outputs[`${output}-sha256`],
      `\${{ steps.build.outputs.${output}-sha256 }}`,
    );
    assert.ok(build.includes(`$RUNNER_TEMP/python-release/${filename}`));
    assert.equal(
      stage.env[`EXPECTED_${output.toUpperCase()}_SHA256`],
      `\${{ needs.validate.outputs.${output}-sha256 }}`,
    );
    const sealCheck = stage.run.indexOf(`release-inputs/${filename}\\n'`);
    assert.ok(
      sealCheck >= 0 && sealCheck < stage.run.indexOf('python -B release-inputs/verifier.py'),
    );
  }
  assert.equal(
    stage.env.EXPECTED_RELEASE_MANIFEST_SHA256,
    '${{ needs.validate.outputs.release-manifest-sha256 }}',
  );
  assert.match(stage.run, /stage-python --output release-inputs --project all$/m);
  assert.equal(python.jobs.publish.steps.at(-1).if, "steps.stage.outputs.publish-needed == 'true'");
  assert.equal(python.jobs.publish.steps.at(-1).with['skip-existing'], 'false');
});

test('public CrewAI install uses a pinned verified tool and fresh hash-checked wheels', async () => {
  const job = workflows['public-ci.yml'].jobs.verify;
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], 'false');
  const postbuild = job.steps.find((step) => step.id === 'public-postbuild');
  assert.equal(postbuild.run, 'node scripts/public-ci-postbuild.mjs');
  assert.equal(postbuild.if, undefined);
  assert.equal(postbuild['continue-on-error'], undefined);
  assert.deepEqual(postbuild.env, {
    PUBLIC_CI_POSTBUILD_SCOPE: '${{ steps.public-scope.outputs.scope }}',
  });
  const lanes = postbuildLanes('full');
  assert.deepEqual(
    lanes.map(({ name }) => name),
    ['web', 'native-python'],
  );
  for (const scope of ['docs', 'frontend'])
    assert.ok(postbuildLanes(scope).every(({ name }) => name !== 'native-python'));
  for (const scope of [undefined, '', 'unknown']) assert.throws(() => postbuildLanes(scope));
  const native = lanes[1].script;
  const helper = await readFile(new URL('./public-ci-postbuild.mjs', import.meta.url), 'utf8');
  assert.match(
    helper,
    /spawnLane\(\s*'bash',\s*\[\s*'--noprofile',\s*'--norc',\s*'-e',\s*'-u',\s*'-o',\s*'pipefail',\s*'-c'/,
  );
  assert.match(native, /^UV_VERSION=0\.11\.33$/m);
  assert.match(
    native,
    /^UV_LINUX_X64_SHA256=aa9fca823c03289fb6e3460b3dc864f3ea895cafaf9b99247701a67b17d1b018$/m,
  );
  for (const command of [
    "--proto '=https' --tlsv1.2",
    '--connect-timeout 10 --max-time 60 --retry 0',
    'https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz',
    'sha256sum --check --status',
    '--strip-components=1 uv-x86_64-unknown-linux-gnu/uv',
  ]) {
    assert.ok(native.includes(command), command);
  }
  assert.ok(native.indexOf('sha256sum --check --status') < native.indexOf('tar -xzf'));
  assert.ok(
    native.indexOf('"$install_dir/uv" --version') <
      native.indexOf('uv --no-config --no-cache --no-python-downloads pip install'),
  );
  assert.ok(native.includes('export PATH="$install_dir:$PATH"'));
  assert.ok(
    native.includes(
      'export OTEL_SDK_DISABLED=true CREWAI_TELEMETRY_DISABLED=true CREWAI_TRACING_ENABLED=false PYTHONDONTWRITEBYTECODE=1',
    ),
  );
  assert.doesNotMatch(native, /\|\s*(?:sh|bash)\b|\|\|/);
  for (const command of [
    'python -m venv "$RUNNER_TEMP/agentdomain-crewai"',
    'uv --no-config --no-cache --no-python-downloads pip install --python "$RUNNER_TEMP/agentdomain-crewai/bin/python" --require-hashes --no-build -r packages/mcp-server/examples/crewai/requirements.lock',
    '-m pip install --no-deps --no-index --force-reinstall "$RUNNER_TEMP/python-release/dist/agentdomain_crewai-$RELEASE_VERSION-py3-none-any.whl"',
    '-m pip check',
    'importlib.util.find_spec("agentdomain_crewai")',
    'packages/mcp-server/test/crewai-package.py',
    'packages/mcp-server/test/crewai-integration.mjs',
  ]) {
    assert.ok(native.includes(command), command);
  }
  assert.doesNotMatch(native, /--no-verify|--no-deps.*requirements\.lock|\|\|/);
  const lock = await readFile(
    new URL('../packages/mcp-server/examples/crewai/requirements.lock', import.meta.url),
    'utf8',
  );
  assert.match(lock, /^uv==0\.11\.33 \\/m);
});
