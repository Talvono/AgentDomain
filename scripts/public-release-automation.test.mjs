import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  planRelease,
  planCompletion,
  finalizeRelease,
  stableVersion,
  compareVersions,
  assertPublishJobs,
  finalizerContext,
  createTransport,
  verifyOfficialRegistries,
  PUBLISHERS,
  NPM_PACKAGES,
  PYTHON_PACKAGES,
  AUTOMATION_LIMITS,
  PROVENANCE_VERIFIER_PY,
} from './public-release-automation.mjs';

const sha = 'a'.repeat(40),
  parentSha = 'b'.repeat(40),
  version = '0.11.1';
const actor = { login: '0xmdrakib', id: 113634586, type: 'User' };
const repo = {
  full_name: 'Talvono/AgentDomain',
  id: 1310051881,
  owner: { login: 'Talvono', id: 342912183 },
};
function environment(workflow = 'publish-npm.yml') {
  return {
    GITHUB_REPOSITORY: repo.full_name,
    GITHUB_REPOSITORY_ID: String(repo.id),
    GITHUB_REPOSITORY_OWNER: repo.owner.login,
    GITHUB_REPOSITORY_OWNER_ID: String(repo.owner.id),
    GITHUB_ACTOR: actor.login,
    GITHUB_ACTOR_ID: String(actor.id),
    GITHUB_TRIGGERING_ACTOR: actor.login,
    GITHUB_SHA: sha,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_WORKFLOW_REF: `${repo.full_name}/.github/workflows/${workflow}@refs/heads/main`,
    GITHUB_RUN_ID: '500',
    GITHUB_RUN_ATTEMPT: '1',
  };
}
const ci = {
  id: 100,
  run_attempt: 2,
  workflow_id: 50,
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  name: 'Public CI',
  path: '.github/workflows/public-ci.yml',
  status: 'completed',
  conclusion: 'success',
  actor,
  triggering_actor: actor,
  repository: repo,
  head_repository: repo,
  url: `https://api.github.com/repos/${repo.full_name}/actions/runs/100`,
};
function context(env) {
  return {
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
    eventName: env.GITHUB_EVENT_NAME,
    sourceRun: {
      id: ci.id,
      run_attempt: ci.run_attempt,
      workflow_id: ci.workflow_id,
      head_sha: sha,
    },
  };
}
function run(workflow, id = 200, status = 'completed') {
  return {
    ...ci,
    id,
    run_attempt: 1,
    workflow_id: id + 5,
    event: 'workflow_run',
    status,
    conclusion: status === 'completed' ? 'success' : null,
    path: `.github/workflows/${workflow}`,
    name: PUBLISHERS[workflow]?.name ?? 'Complete public release',
    url: `https://api.github.com/repos/${repo.full_name}/actions/runs/${id}`,
  };
}
function jobs(publisher, workflow) {
  return {
    total_count: 1,
    jobs: [
      {
        id: publisher.id * 10,
        run_id: publisher.id,
        run_attempt: publisher.run_attempt,
        run_url: publisher.url,
        head_sha: sha,
        head_branch: 'main',
        workflow_name: publisher.name,
        name: `Publish ${PUBLISHERS[workflow].ecosystem} ${version} (Public CI ${ci.id}/${ci.run_attempt})`,
        status: 'completed',
        conclusion: 'success',
        steps: [
          {
            name: PUBLISHERS[workflow].step,
            number: 1,
            status: 'completed',
            conclusion: 'success',
          },
        ],
      },
    ],
  };
}
const sourceState = () => ({ sha, parentSha, version, parentVersion: '0.11.0', clean: true });
function fixture(workflow = 'complete-public-release.yml') {
  const env = environment(workflow),
    ctx = context(env);
  const own = run(workflow, 500, 'in_progress');
  const npm = run('publish-npm.yml', 200),
    python = run('publish-python.yml', 201);
  const responses = new Map([
    [`repos/${repo.full_name}/actions/runs/500`, own],
    ['users/0xmdrakib', actor],
    [
      `repos/${repo.full_name}/commits/${parentSha}`,
      { sha: parentSha, commit: { verification: { verified: true } } },
    ],
    [
      `repos/${repo.full_name}/commits/${sha}`,
      { sha, commit: { verification: { verified: true } } },
    ],
    [
      `repos/${repo.full_name}/actions/workflows/public-ci.yml/runs?branch=main&event=push&head_sha=${sha}&per_page=10`,
      { total_count: 1, workflow_runs: [ci] },
    ],
    [`repos/${repo.full_name}/releases?per_page=100`, []],
  ]);
  for (const [file, publisher] of [
    ['publish-npm.yml', npm],
    ['publish-python.yml', python],
  ]) {
    responses.set(
      `repos/${repo.full_name}/actions/workflows/${file}/runs?branch=main&event=workflow_run&head_sha=${sha}&per_page=10`,
      { total_count: 1, workflow_runs: [publisher] },
    );
    responses.set(`repos/${repo.full_name}/actions/runs/${publisher.id}`, publisher);
    responses.set(
      `repos/${repo.full_name}/actions/runs/${publisher.id}/attempts/1/jobs?per_page=100`,
      jobs(publisher, file),
    );
  }
  for (const [key, value] of responses) responses.set(key, structuredClone(value));
  if (Object.hasOwn(PUBLISHERS, workflow))
    responses.set(
      `repos/${repo.full_name}/actions/workflows/${workflow}/runs?branch=main&event=workflow_run&head_sha=${sha}&per_page=10`,
      { total_count: 1, workflow_runs: [structuredClone(own)] },
    );
  const calls = [],
    mutations = [],
    emitted = [];
  let tag = null,
    release = null,
    verified = 0,
    qualifications = 0;
  const api = async (path, options = {}) => {
    calls.push(path);
    if (options.method === 'POST') {
      mutations.push({ path, ...options });
      if (path.endsWith('/git/refs'))
        tag = { ref: options.body.ref, object: { type: 'commit', sha: options.body.sha } };
      else if (path.endsWith('/releases'))
        release = {
          id: 1234,
          ...options.body,
          assets: [],
          html_url: 'https://github.com/Talvono/AgentDomain/releases/tag/npm-v0.11.1',
          url: 'https://api.github.com/repos/Talvono/AgentDomain/releases/1234',
        };
      return { ok: true };
    }
    if (responses.has(path)) return structuredClone(responses.get(path));
    if (path.endsWith(`/git/ref/tags/npm-v${version}`)) return structuredClone(tag);
    if (path.endsWith(`/releases/tags/npm-v${version}`) || path.endsWith('/releases/latest'))
      return structuredClone(release);
    throw new Error(`Unexpected API ${path}`);
  };
  const deps = {
    env,
    event: { action: 'completed', repository: repo, workflow_run: npm },
    context: ctx,
    source: async () => sourceState(),
    api,
    bindSource: (_env, { sourceRun }) => {
      assert.deepEqual(sourceRun, ci);
      return { ...ctx, qualificationWorkflow: workflow };
    },
    qualify: async () => {
      qualifications++;
      return ci.id;
    },
    emit: (value) => emitted.push(value),
    verifyRegistries: async () => {
      verified++;
      return Array.from({ length: 10 }, (_, i) => ({
        name: `package-${i}`,
        filename: `package-${i}.tgz`,
        sha256: 'c'.repeat(64),
      }));
    },
  };
  return {
    deps,
    responses,
    calls,
    mutations,
    emitted,
    npm,
    python,
    api,
    get verified() {
      return verified;
    },
    get qualifications() {
      return qualifications;
    },
    setTag(value) {
      tag = value;
    },
    get release() {
      return release;
    },
  };
}

test('stable coordinated versions reject prereleases, leading zeros, newline injection and regressions', () => {
  for (const bad of [
    '0.11.1-beta.1',
    '01.2.3',
    '1.2',
    '1.2.3\nrelease-needed=true',
    '1.2.3\n',
    '',
    1,
  ])
    assert.throws(() => stableVersion(bad));
  assert.equal(compareVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1);
  assert.equal(compareVersions(version, '0.11.0'), 1);
});
for (const file of Object.keys(PUBLISHERS))
  test(`unchanged ${file} is a cheap remote-free no-op`, async () => {
    const f = fixture(file);
    f.deps.source = async () => ({ ...sourceState(), parentVersion: version });
    const output = await planRelease(f.deps);
    assert.equal(output['release-needed'], 'false');
    assert.equal(output.version, version);
    assert.deepEqual(f.calls, []);
    assert.equal(f.qualifications, 0);
    assert.equal(f.verified, 0);
  });
for (const file of Object.keys(PUBLISHERS))
  test(`changed ${file} requires signed parent, exact own run and full CI`, async () => {
    const f = fixture(file);
    const output = await planRelease(f.deps);
    assert.equal(output['release-needed'], 'true');
    assert.equal(output['ci-run-id'], '100');
    assert.equal(f.qualifications, 1);
    assert.equal(f.mutations.length, 0);
  });
for (const [name, alter] of [
  [
    'dirty checkout',
    (f) => {
      f.deps.source = async () => ({ ...sourceState(), clean: false });
    },
  ],
  [
    'wrong HEAD',
    (f) => {
      f.deps.source = async () => ({ ...sourceState(), sha: parentSha });
    },
  ],
  [
    'version downgrade',
    (f) => {
      f.deps.source = async () => ({ ...sourceState(), parentVersion: '0.12.0' });
    },
  ],
  [
    'unsigned parent',
    (f) => {
      f.responses.get(`repos/${repo.full_name}/commits/${parentSha}`).commit.verification.verified =
        false;
    },
  ],
  [
    'operator numeric ID mismatch',
    (f) => {
      f.responses.get('users/0xmdrakib').id = 99;
    },
  ],
  [
    'own run wrong SHA',
    (f) => {
      f.responses.get(`repos/${repo.full_name}/actions/runs/500`).head_sha = parentSha;
    },
  ],
  [
    'CI run mismatch',
    (f) => {
      f.deps.qualify = async () => 99;
    },
  ],
  [
    'manual context',
    (f) => {
      f.deps.context.eventName = 'workflow_dispatch';
    },
  ],
])
  test(`planner rejects ${name} before any mutation`, async () => {
    const f = fixture('publish-npm.yml');
    alter(f);
    await assert.rejects(planRelease(f.deps));
    assert.equal(f.mutations.length, 0);
  });
test('planner rejects checkout changes during qualification', async () => {
  const f = fixture('publish-npm.yml');
  let reads = 0;
  f.deps.source = async () => ({ ...sourceState(), version: ++reads === 1 ? version : '0.11.2' });
  await assert.rejects(planRelease(f.deps), /CHECKOUT_CHANGED/);
});
for (const file of Object.keys(PUBLISHERS))
  test(`unchanged ${file} completion plans skip all verifier setup and remote work`, async () => {
    const f = fixture();
    f.deps.event.workflow_run = file === 'publish-npm.yml' ? f.npm : f.python;
    f.deps.source = async () => ({ ...sourceState(), parentVersion: version });
    const output = await planCompletion(f.deps);
    assert.equal(output['release-needed'], 'false');
    assert.equal(output.version, version);
    assert.equal(output['source-sha'], sha);
    assert.equal(output['publication-authorized'], undefined);
    assert.deepEqual(f.calls, []);
    assert.equal(f.qualifications, 0);
    assert.equal(f.verified, 0);
    assert.deepEqual(f.mutations, []);
  });
test('changed completion plans only request the full verification path, without release authority', async () => {
  const f = fixture();
  assert.deepEqual(await planCompletion(f.deps), {
    'release-needed': 'true',
    version,
    'source-sha': sha,
  });
  assert.deepEqual(f.calls, []);
  assert.equal(f.verified, 0);
  assert.equal(f.qualifications, 0);
});
test('cheap completion plans reject unauthenticated events, wrong or dirty checkout and version regressions', async () => {
  const event = fixture();
  event.deps.event.workflow_run.actor = { ...actor, id: 99 };
  await assert.rejects(planCompletion(event.deps), /RUN_IDENTITY/);
  for (const change of [
    { sha: parentSha },
    { clean: false },
    { parentSha: 'invalid' },
    { parentVersion: '0.12.0' },
    { version: '0.11.1-beta.1' },
  ]) {
    const f = fixture();
    f.deps.source = async () => ({ ...sourceState(), ...change });
    await assert.rejects(planCompletion(f.deps));
    assert.deepEqual(f.emitted, []);
  }
});
test('cheap completion plans fail closed when the canonical all-eight version check fails', async () => {
  const f = fixture();
  f.deps.source = async () => {
    throw new Error('RELEASE_VERSION_MISMATCH');
  };
  await assert.rejects(planCompletion(f.deps), /RELEASE_VERSION_MISMATCH/);
  assert.deepEqual(f.emitted, []);
  assert.deepEqual(f.calls, []);
});
test('duplicate successful publication is a planner no-op without claiming registry qualification', async () => {
  const f = fixture('publish-npm.yml');
  f.responses.set(
    `repos/${repo.full_name}/actions/workflows/publish-npm.yml/runs?branch=main&event=workflow_run&head_sha=${sha}&per_page=10`,
    { total_count: 2, workflow_runs: [f.npm, run('publish-npm.yml', 500, 'in_progress')] },
  );
  const output = await planRelease(f.deps);
  assert.equal(output['release-needed'], 'false');
  assert.equal(f.verified, 0);
  assert.equal(f.mutations.length, 0);
});
test('rerunning the same successful publisher uses its exact earlier attempt only to suppress mutation', async () => {
  const f = fixture('publish-npm.yml'),
    own = f.responses.get(`repos/${repo.full_name}/actions/runs/500`);
  own.run_attempt = 2;
  f.deps.env.GITHUB_RUN_ATTEMPT = '2';
  f.responses.set(
    `repos/${repo.full_name}/actions/workflows/publish-npm.yml/runs?branch=main&event=workflow_run&head_sha=${sha}&per_page=10`,
    { total_count: 1, workflow_runs: [own] },
  );
  const earlier = run('publish-npm.yml', 500);
  f.responses.set(`repos/${repo.full_name}/actions/runs/500/attempts/1`, earlier);
  f.responses.set(
    `repos/${repo.full_name}/actions/runs/500/attempts/1/jobs?per_page=100`,
    jobs(earlier, 'publish-npm.yml'),
  );
  assert.equal((await planRelease(f.deps))['release-needed'], 'false');
  assert.equal(f.verified, 0);
});
test('planner never treats failed or skipped publication as a completed deduplication', async () => {
  const f = fixture('publish-npm.yml'),
    earlier = { ...f.npm, conclusion: 'failure' };
  f.responses.set(`repos/${repo.full_name}/actions/runs/200`, earlier);
  f.responses.set(
    `repos/${repo.full_name}/actions/workflows/publish-npm.yml/runs?branch=main&event=workflow_run&head_sha=${sha}&per_page=10`,
    { total_count: 2, workflow_runs: [earlier, run('publish-npm.yml', 500, 'in_progress')] },
  );
  await assert.rejects(planRelease(f.deps), /RUN_NOT_SUCCESSFUL/);
  assert.equal(f.mutations.length, 0);
});
function plannerOnly(publisher, file) {
  const publish = jobs(publisher, file).jobs[0];
  publish.conclusion = 'skipped';
  publish.steps = [];
  const plan = {
    ...publish,
    id: publish.id + 1,
    name: 'Plan a reviewed version change',
    conclusion: 'success',
    steps: [
      {
        name: 'Skip unchanged versions before release builds',
        number: 1,
        status: 'completed',
        conclusion: 'success',
      },
    ],
  };
  const validate = { ...publish, id: publish.id + 2, name: 'validate' };
  return { total_count: 3, jobs: [plan, validate, publish] };
}
test('attempt-specific publish jobs accept omitted run_attempt but still reject a present wrong attempt', () => {
  const publisher = run('publish-npm.yml'),
    payload = jobs(publisher, 'publish-npm.yml');
  delete payload.jobs[0].run_attempt;
  assert.equal(
    assertPublishJobs(payload, publisher, 'publish-npm.yml', version, ci),
    payload.jobs[0].id,
  );
  payload.jobs[0].run_attempt = 99;
  assert.throws(
    () => assertPublishJobs(payload, publisher, 'publish-npm.yml', version, ci),
    /PUBLISH_JOB_FAILED/,
  );
});
test('planner-only duplicates accept omitted attempt fields only on their attempt-specific endpoint', async () => {
  const f = fixture(),
    duplicate = run('publish-npm.yml', 202),
    payload = plannerOnly(duplicate, 'publish-npm.yml');
  for (const job of payload.jobs) delete job.run_attempt;
  f.responses.set(
    `repos/${repo.full_name}/actions/workflows/publish-npm.yml/runs?branch=main&event=workflow_run&head_sha=${sha}&per_page=10`,
    { total_count: 2, workflow_runs: [f.npm, duplicate] },
  );
  f.responses.set(`repos/${repo.full_name}/actions/runs/202`, duplicate);
  f.responses.set(`repos/${repo.full_name}/actions/runs/202/attempts/1/jobs?per_page=100`, payload);
  f.deps.event.workflow_run = duplicate;
  assert.equal(await finalizeRelease(f.deps), true);
  assert(f.calls.includes(`repos/${repo.full_name}/actions/runs/202/attempts/1/jobs?per_page=100`));
  payload.jobs[0].run_attempt = 99;
  const mutations = f.mutations.length;
  await assert.rejects(finalizeRelease(f.deps), /DUPLICATE_JOB_BINDING/);
  assert.equal(f.mutations.length, mutations);
});
test('a green planner-only duplicate cannot poison a prior exact successful publication', async () => {
  const f = fixture(),
    duplicate = run('publish-npm.yml', 202);
  f.responses.set(
    `repos/${repo.full_name}/actions/workflows/publish-npm.yml/runs?branch=main&event=workflow_run&head_sha=${sha}&per_page=10`,
    { total_count: 2, workflow_runs: [f.npm, duplicate] },
  );
  f.responses.set(`repos/${repo.full_name}/actions/runs/202`, duplicate);
  f.responses.set(
    `repos/${repo.full_name}/actions/runs/202/attempts/1/jobs?per_page=100`,
    plannerOnly(duplicate, 'publish-npm.yml'),
  );
  f.deps.event.workflow_run = duplicate;
  let verifiedOriginal = false;
  const verify = f.deps.verifyRegistries;
  f.deps.verifyRegistries = async (options) => {
    assert.equal(options.pair['publish-npm.yml'].id, 200);
    verifiedOriginal = true;
    return verify(options);
  };
  assert.equal(await finalizeRelease(f.deps), true);
  assert(verifiedOriginal);
});
test('a planner-only green run with no actual publication cannot finalize a release', async () => {
  const f = fixture();
  f.responses.set(
    `repos/${repo.full_name}/actions/runs/200/attempts/1/jobs?per_page=100`,
    plannerOnly(f.npm, 'publish-npm.yml'),
  );
  await assert.rejects(finalizeRelease(f.deps), /ACTUAL_PUBLICATION_REQUIRED/);
  assert.equal(f.verified, 0);
});
test('same workflow rerun finalizes using verified original publication attempt, not the skipped rerun', async () => {
  const f = fixture(),
    duplicate = { ...f.npm, run_attempt: 2 };
  f.responses.set(
    `repos/${repo.full_name}/actions/workflows/publish-npm.yml/runs?branch=main&event=workflow_run&head_sha=${sha}&per_page=10`,
    { total_count: 1, workflow_runs: [duplicate] },
  );
  f.responses.set(`repos/${repo.full_name}/actions/runs/200`, duplicate);
  f.responses.set(
    `repos/${repo.full_name}/actions/runs/200/attempts/2/jobs?per_page=100`,
    plannerOnly(duplicate, 'publish-npm.yml'),
  );
  f.responses.set(`repos/${repo.full_name}/actions/runs/200/attempts/1`, f.npm);
  f.deps.event.workflow_run = duplicate;
  const verify = f.deps.verifyRegistries;
  f.deps.verifyRegistries = async (options) => {
    assert.equal(options.pair['publish-npm.yml'].run_attempt, 1);
    return verify(options);
  };
  assert.equal(await finalizeRelease(f.deps), true);
});
test('successful finalization verifies both publishers, provenance, signed anchor, immutable tag and Latest readbacks', async () => {
  const f = fixture();
  assert.equal(await finalizeRelease(f.deps), true);
  assert.equal(f.qualifications, 2);
  assert.equal(f.verified, 1);
  assert.deepEqual(
    f.mutations.map((m) => m.path),
    [`repos/${repo.full_name}/git/refs`, `repos/${repo.full_name}/releases`],
  );
  assert.equal(f.release.make_latest, 'true');
  assert.equal(f.release.target_commitish, sha);
  assert.equal(f.emitted[0].completed, 'true');
  const mutations = f.mutations.length;
  assert.equal(await finalizeRelease(f.deps), true);
  assert.equal(f.mutations.length, mutations);
});
test('first completed publisher waits without registry verification or mutations', async () => {
  const f = fixture();
  f.responses.set(
    `repos/${repo.full_name}/actions/workflows/publish-python.yml/runs?branch=main&event=workflow_run&head_sha=${sha}&per_page=10`,
    { total_count: 0, workflow_runs: [] },
  );
  assert.equal(await finalizeRelease(f.deps), false);
  assert.equal(f.verified, 0);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.emitted[0].reason, 'waiting-for-other-publisher');
});
test('an in-progress second publisher waits', async () => {
  const f = fixture();
  f.responses.get(
    `repos/${repo.full_name}/actions/workflows/publish-python.yml/runs?branch=main&event=workflow_run&head_sha=${sha}&per_page=10`,
  ).workflow_runs[0].status = 'in_progress';
  assert.equal(await finalizeRelease(f.deps), false);
  assert.equal(f.verified, 0);
});
for (const [name, modify] of [
  [
    'skipped job',
    (j) => {
      j.conclusion = 'skipped';
    },
  ],
  [
    'skipped publish step in green job',
    (j) => {
      j.steps[0].conclusion = 'skipped';
    },
  ],
  [
    'wrong source version',
    (j) => {
      j.name = j.name.replace(version, '0.11.0');
    },
  ],
  [
    'different CI attempt',
    (j) => {
      j.name = j.name.replace('100/2', '100/1');
    },
  ],
  [
    'different CI run',
    (j) => {
      j.name = j.name.replace('100/2', '101/2');
    },
  ],
  [
    'different publisher attempt',
    (j) => {
      j.run_attempt = 2;
    },
  ],
  [
    'wrong source HEAD',
    (j) => {
      j.head_sha = parentSha;
    },
  ],
  [
    'missing publish step',
    (j) => {
      j.steps = [];
    },
  ],
  [
    'duplicate publish step',
    (j) => {
      j.steps.push({ ...j.steps[0] });
    },
  ],
])
  test(`finalizer refuses ${name}`, async () => {
    const f = fixture();
    modify(
      f.responses.get(`repos/${repo.full_name}/actions/runs/201/attempts/1/jobs?per_page=100`)
        .jobs[0],
    );
    await assert.rejects(finalizeRelease(f.deps));
    assert.equal(f.verified, 0);
    assert.equal(f.mutations.length, 0);
  });
test('every repository and actor identity is numeric and exact', () => {
  const f = fixture();
  for (const edit of [
    (e) => {
      e.workflow_run.actor.id++;
    },
    (e) => {
      e.workflow_run.head_repository.id++;
    },
    (e) => {
      e.workflow_run.event = 'workflow_dispatch';
    },
    (e) => {
      e.workflow_run.path = '.github/workflows/forged.yml';
    },
    (e) => {
      e.workflow_run.conclusion = 'skipped';
    },
  ]) {
    const event = structuredClone(f.deps.event);
    edit(event);
    assert.throws(() => finalizerContext(f.deps.env, event));
  }
});
test('conflicting tags fail with zero mutations and are never moved or deleted', async () => {
  const f = fixture();
  f.setTag({ ref: `refs/tags/npm-v${version}`, object: { type: 'commit', sha: parentSha } });
  await assert.rejects(finalizeRelease(f.deps), /TAG_CONFLICT/);
  assert.equal(f.mutations.length, 0);
});
test('provenance failure stops before tag or release creation', async () => {
  const f = fixture();
  f.deps.verifyRegistries = async () => {
    throw new Error('invalid cryptography');
  };
  await assert.rejects(finalizeRelease(f.deps), /invalid cryptography/);
  assert.equal(f.mutations.length, 0);
});
test('unsigned exact release anchor is never tagged', async () => {
  const f = fixture();
  f.responses.get(`repos/${repo.full_name}/commits/${sha}`).commit.verification.verified = false;
  await assert.rejects(finalizeRelease(f.deps), /ANCHOR_UNSIGNED/);
  assert.equal(f.mutations.length, 0);
});
test('unknown mutation outcomes are never automatically retried', async () => {
  const f = fixture();
  let writes = 0;
  f.deps.api = async (path, options) => {
    if (options?.method === 'POST') {
      writes++;
      throw new Error('unknown write result');
    }
    return f.api(path, options);
  };
  await assert.rejects(finalizeRelease(f.deps), /unknown write result/);
  assert.equal(writes, 1);
});
test('older stable release is never marked Latest', async () => {
  const f = fixture();
  const newer = { id: 999, tag_name: 'npm-v0.12.0', draft: false, prerelease: false };
  f.responses.set(`repos/${repo.full_name}/releases?per_page=100`, [newer]);
  f.responses.set(`repos/${repo.full_name}/releases/latest`, newer);
  await finalizeRelease(f.deps);
  assert.equal(f.release.make_latest, 'false');
});
test('existing releases with conflicting evidence are immutable and refused without another write', async () => {
  const f = fixture();
  await finalizeRelease(f.deps);
  const writes = f.mutations.length;
  f.release.body = 'different release evidence';
  await assert.rejects(finalizeRelease(f.deps), /RELEASE_CONFLICT/);
  assert.equal(f.mutations.length, writes);
});
test('the newest publisher attempt cannot be replaced by an older successful run', async () => {
  const f = fixture(),
    key = `repos/${repo.full_name}/actions/workflows/publish-python.yml/runs?branch=main&event=workflow_run&head_sha=${sha}&per_page=10`;
  const failed = {
    ...f.python,
    id: 202,
    conclusion: 'failure',
    url: `https://api.github.com/repos/${repo.full_name}/actions/runs/202`,
  };
  f.responses.set(key, { total_count: 2, workflow_runs: [f.python, failed] });
  await assert.rejects(finalizeRelease(f.deps), /RUN_NOT_SUCCESSFUL/);
  assert.equal(f.verified, 0);
});
test('unqualified or incomplete registry evidence never reaches tag creation', async () => {
  const f = fixture();
  f.deps.verifyRegistries = async () => [];
  await assert.rejects(finalizeRelease(f.deps), /REGISTRY_EVIDENCE/);
  assert.equal(f.mutations.length, 0);
});
test('0.11.1 notes describe the approved patch and preserve primary product positioning', async () => {
  const f = fixture();
  await finalizeRelease(f.deps);
  for (const text of [
    'AgentDomain is the agent-native identity and communications infrastructure.',
    'Canonical Talvono',
    'Coherent coordinated runtime and bridge',
    'Version-derived immutable artifact guards',
    'Automatic OIDC publication',
  ])
    assert(f.release.body.includes(text));
  for (const text of ['new SDK features', 'email rollout complete', 'autonomous-only'])
    assert(!f.release.body.includes(text));
});
test('bounded release and publisher inventories fail closed instead of silently truncating', async () => {
  const f = fixture();
  f.responses.set(`repos/${repo.full_name}/releases?per_page=100`, Array(100).fill({}));
  await assert.rejects(finalizeRelease(f.deps), /RELEASE_LIST_OVERFLOW/);
  const g = fixture();
  g.responses.get(
    `repos/${repo.full_name}/actions/workflows/publish-npm.yml/runs?branch=main&event=workflow_run&head_sha=${sha}&per_page=10`,
  ).total_count = 11;
  await assert.rejects(finalizeRelease(g.deps), /RUN_LIST_INVALID/);
});
test('official-only bounded HTTP transport rejects redirects, arbitrary hosts and overlarge payloads', async () => {
  const seen = [];
  const t = createTransport({
    token: 'test',
    fetcher: async (url, options) => {
      seen.push({ url, options });
      return new Response('{"ok":true}');
    },
  });
  assert.deepEqual(await t.api('repos/Talvono/AgentDomain'), { ok: true });
  assert.equal(seen[0].options.redirect, 'error');
  assert.equal(seen[0].options.headers.authorization, 'Bearer test');
  await assert.rejects(t.bytes('https://evil.invalid/archive'), /REMOTE_URL/);
  await assert.rejects(
    t.bytes('https://registry.npmjs.org/x', { maxBytes: 1 }),
    /REMOTE_TOO_LARGE/,
  );
  assert.equal(seen[1].options.headers.authorization, undefined);
});
test('HTTP mutations use one request with no retry on failure or unknown outcome', async () => {
  let calls = 0;
  const t = createTransport({
    token: 'test',
    fetcher: async () => {
      calls++;
      return new Response('{}', { status: 500 });
    },
  });
  await assert.rejects(
    t.api('repos/Talvono/AgentDomain/git/refs', { method: 'POST', body: {} }),
    /REMOTE_STATUS/,
  );
  assert.equal(calls, 1);
});
test('native transport has one bounded request budget and only optional 404 means absent', async () => {
  let calls = 0;
  const t = createTransport({
    fetcher: async () => {
      calls++;
      return new Response('{}');
    },
  });
  for (let i = 0; i < AUTOMATION_LIMITS.requests; i++)
    await t.json('https://pypi.org/pypi/example/json');
  await assert.rejects(t.json('https://pypi.org/pypi/example/json'), /REQUEST_BUDGET/);
  assert.equal(calls, AUTOMATION_LIMITS.requests);
  const missing = createTransport({ fetcher: async () => new Response('{}', { status: 404 }) });
  assert.equal(
    await missing.api('repos/Talvono/AgentDomain/releases/tags/npm-v0.11.1', { optional: true }),
    null,
  );
  await assert.rejects(missing.json('https://pypi.org/pypi/example/json'), /REMOTE_STATUS/);
});
test('raw bundle downloads enforce the four MiB native bound before parsing or verification', async () => {
  const t = createTransport({
    fetcher: async () => new Response(Buffer.alloc(AUTOMATION_LIMITS.jsonBytes + 1, 32)),
  });
  await assert.rejects(
    t.json('https://registry.npmjs.org/-/npm/v1/attestations/example'),
    /REMOTE_TOO_LARGE/,
  );
});
test('the native request budget reserves all final mutation readbacks before the first write', async () => {
  const t = createTransport({ fetcher: async () => new Response('{}') });
  for (let i = 0; i < AUTOMATION_LIMITS.requests - 7; i++)
    await t.json('https://pypi.org/pypi/example/json');
  assert.throws(() => t.api.reserve(8), /REQUEST_BUDGET/);
});
test('official registry adapter verifies ten immutable blobs, isolated six-node npm audit and authenticated provenance', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'agentdomain-release-test-'));
  const env = {
    RUNNER_TEMP: temp,
    PUBLIC_RELEASE_NPM_CLI: '/tool/npm-cli.js',
    PUBLIC_RELEASE_VERIFY_PYTHON: '/tool/python',
    GH_TOKEN: 'never-in-verifier',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'never-in-verifier',
  };
  const blob = Buffer.from('fixture artifact bytes'),
    sha256 = createHash('sha256').update(blob).digest('hex');
  const transport = {
    bytes: async () => blob,
    json: async (url) => {
      if (url.includes('/-/npm/v1/attestations/'))
        return { attestations: [{ predicateType: 'https://slsa.dev/provenance/v1', bundle: {} }] };
      if (url.includes('registry.npmjs.org/')) {
        const name = decodeURIComponent(new URL(url).pathname.split('/')[1]),
          slug = name.split('/')[1];
        return {
          name,
          version,
          dist: {
            tarball: `https://registry.npmjs.org/${name}/-/${slug}-${version}.tgz`,
            integrity: `sha512-${createHash('sha512').update(blob).digest('base64')}`,
            signatures: [{}],
            attestations: {
              url: `https://registry.npmjs.org/-/npm/v1/attestations/${slug}`,
              provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
            },
          },
        };
      }
      if (url.includes('/integrity/')) return { version: 1, attestation_bundles: [] };
      const name = new URL(url).pathname.split('/')[2],
        slug = name.replaceAll('-', '_');
      return {
        info: { name, version },
        urls: [`${slug}-${version}.tar.gz`, `${slug}-${version}-py3-none-any.whl`].map(
          (filename) => ({
            filename,
            size: blob.length,
            digests: { sha256 },
            yanked: false,
            url: `https://files.pythonhosted.org/packages/example/${filename}`,
          }),
        ),
      };
    },
  };
  let provenance = 0,
    audits = 0;
  try {
    const evidence = await verifyOfficialRegistries(
      {
        context: context(environment()),
        version,
        pair: {
          'publish-npm.yml': run('publish-npm.yml'),
          'publish-python.yml': run('publish-python.yml', 201),
        },
      },
      {
        transport,
        env,
        verifyProvenance: async (_python, input, childEnv) => {
          provenance++;
          const data = JSON.parse(input);
          assert.equal(data.files.length, 10);
          assert.equal(data.sha, sha);
          for (const row of data.files) assert.deepEqual(readFileSync(row.path), blob);
          assert.equal(childEnv.GH_TOKEN, undefined);
          assert.equal(childEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
        },
        run: async (_command, args, options) => {
          if (args.includes('--version')) return '11.5.1\n';
          audits++;
          assert(args.includes('signatures'));
          assert(args.includes('--ignore-scripts'));
          const lock = JSON.parse(readFileSync(join(options.cwd, 'package-lock.json')));
          assert.equal(Object.keys(lock.packages).length, 7);
          assert.equal(options.env.GH_TOKEN, undefined);
          return '{"invalid":[],"missing":[]}';
        },
      },
    );
    assert.equal(evidence.length, 10);
    assert.equal(provenance, 1);
    assert.equal(audits, 1);
    assert.deepEqual(readdirSync(temp), []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test('provenance wrapper uses official cryptographic verifiers and strict source/run claims, not hand-rolled signatures', () => {
  assert(PROVENANCE_VERIFIER_PY.includes('verifier.verify_dsse'));
  assert(PROVENANCE_VERIFIER_PY.includes('attestation.verify('));
  assert(PROVENANCE_VERIFIER_PY.includes('attestation.certificate_claims'));
  for (const claim of [
    '13: sha',
    "15: data['repositoryId']",
    "17: data['ownerId']",
    '21: invocation',
    "20: 'workflow_run'",
  ])
    assert(PROVENANCE_VERIFIER_PY.includes(claim));
  assert(!PROVENANCE_VERIFIER_PY.includes('createVerify'));
  assert(PROVENANCE_VERIFIER_PY.includes("publisher['environment'] == 'pypi-production'"));
  assert(PROVENANCE_VERIFIER_PY.includes('GitHubPublisher(repository=repo, workflow=workflow)'));
  assert(
    !PROVENANCE_VERIFIER_PY.includes(
      'GitHubPublisher(repository=repo, workflow=workflow, environment=',
    ),
  );
});
test('finalizer checks versions before setup and gates both verifier installation and complete on the cheap result', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/complete-public-release.yml', import.meta.url),
    'utf8',
  );
  const steps = workflow.split(/\n      - /);
  const precheck = steps.findIndex((step) => step.includes('id: completion-plan'));
  const installer = steps.findIndex((step) =>
    step.includes('name: Install isolated hash-pinned official provenance verifiers'),
  );
  const complete = steps.findIndex((step) => step.includes('id: complete\n'));
  assert(precheck >= 0 && precheck < installer && installer < complete);
  assert(steps[precheck].includes('node scripts/public-release-automation.mjs completion-plan'));
  assert(!/pip install|python -m venv|npm pack|curl/.test(steps.slice(1, precheck).join('\n')));
  const gate = "if: steps.completion-plan.outputs.release-needed == 'true'";
  assert(steps[installer].includes(gate));
  assert(steps[complete].includes(gate));
});
test('finalizer workflow has only contents write/actions read, pinned tools, no dispatch, registry OIDC or deploy', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/complete-public-release.yml', import.meta.url),
    'utf8',
  );
  for (const value of [
    'contents: write',
    'actions: read',
    'cancel-in-progress: false',
    'timeout-minutes: 20',
    'persist-credentials: false',
    'fetch-depth: 2',
    '--require-hashes',
    '--retry 0',
  ])
    assert(workflow.includes(value));
  for (const bad of [
    'id-token:',
    'workflow_dispatch:',
    'npm publish',
    'twine upload',
    'gh release delete',
    'wrangler',
  ])
    assert(!workflow.includes(bad));
  assert.equal(NPM_PACKAGES.length + PYTHON_PACKAGES.length, 8);
  assert.equal(AUTOMATION_LIMITS.requests, 80);
});
