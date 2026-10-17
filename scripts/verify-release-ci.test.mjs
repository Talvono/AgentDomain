import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises';
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
} from './verify-release-ci.mjs';
import { assertReleaseContext, RELEASE_POLICY } from './public-release-identity.mjs';

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
  assertReleaseContext(context, true);
  assert.throws(() => assertReleaseContext(future, true));
  assert.throws(() => assertReleaseContext({ ...future, ownerId: '113634586' }));
  assert.throws(() => assertReleaseContext({ ...future, actor: 'Talvono', actorId: '342912183' }));
  assert.equal(RELEASE_POLICY.activeOwner, '0xmdrakib');
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

test('only a trusted source-policy flip activates Talvono and excludes the former owner', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agentdomain-policy-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyFile(
    new URL('./public-release-identity.mjs', import.meta.url),
    join(directory, 'public-release-identity.mjs'),
  );
  await writeFile(
    join(directory, 'public-release-policy.json'),
    JSON.stringify({ ...RELEASE_POLICY, activeOwner: 'Talvono' }),
  );
  const flipped = await import(pathToFileURL(join(directory, 'public-release-identity.mjs')).href);
  const future = {
    ...context,
    repository: 'Talvono/AgentDomain',
    owner: 'Talvono',
    ownerId: '342912183',
    workflowRef: 'Talvono/AgentDomain/.github/workflows/publish-npm.yml@refs/heads/main',
  };
  flipped.assertReleaseContext(future, true);
  assert.throws(() => flipped.assertReleaseContext(context, true));
  assert.throws(() => assertReleaseContext(future, true));
});

test('CLI rejects malformed and oversized bodies without logging their contents', () => {
  const filename = fileURLToPath(new URL('./verify-release-ci.mjs', import.meta.url));
  for (const input of ['private-body-marker', 'x'.repeat(RELEASE_CI_LIMITS.maxBytes + 1)]) {
    const result = spawnSync(process.execPath, [filename], { input, encoding: 'utf8' });
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
    const environment = {
      ...process.env,
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
    };
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
      `publication-authorized=${owner === '0xmdrakib'}\n`,
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
  assert.ok(commands.some((command) => command.includes('siwe-auth.browser.mjs')));
  assert.ok(commands.some((command) => command.includes('footer-routes.smoke.mjs')));
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
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(workflow.jobs.validate.permissions, { contents: 'read', actions: 'read' });
    assert.equal(workflow.jobs.validate.environment, undefined);
    const publish = workflow.jobs.publish;
    assert.equal(publish.needs, 'validate');
    const github = {
      ref: 'refs/heads/main',
      repository_id: '1310051881',
      repository: '0xmdrakib/AgentDomain',
      repository_owner_id: '113634586',
      actor: '0xmdrakib',
      actor_id: '113634586',
      triggering_actor: '0xmdrakib',
    };
    const evaluate = (job, source, authorized = 'true') =>
      Function(
        'github',
        'needs',
        `return (${job.if.replaceAll('outputs.publication-authorized', "outputs['publication-authorized']")})`,
      )(source, { validate: { outputs: { 'publication-authorized': authorized } } });
    for (const job of [workflow.jobs.validate, publish]) {
      assert.equal(evaluate(job, github), true);
      assert.equal(
        evaluate(job, {
          ...github,
          repository: 'Talvono/AgentDomain',
          repository_owner_id: '342912183',
        }),
        true,
      );
      for (const patch of [
        { ref: 'refs/heads/feature' },
        { repository_id: '42' },
        { repository: 'someone/AgentDomain' },
        { repository_owner_id: '42' },
        { actor_id: '42' },
        { actor: 'Talvono' },
        { triggering_actor: 'someone' },
        { repository: 'Talvono/AgentDomain' },
      ])
        assert.equal(evaluate(job, { ...github, ...patch }), false);
    }
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
    assert.deepEqual(publish.permissions, { contents: 'read', 'id-token': 'write' });
  }
});

test('public CrewAI install uses a pinned verified tool and fresh hash-checked wheels', async () => {
  const job = workflows['public-ci.yml'].jobs.verify;
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], 'false');
  const setup = job.steps.find(
    (step) => step.name === 'Set up checksum-pinned uv for locked CrewAI dependencies',
  );
  assert.deepEqual(setup.env, {
    UV_VERSION: '0.11.33',
    UV_LINUX_X64_SHA256: 'aa9fca823c03289fb6e3460b3dc864f3ea895cafaf9b99247701a67b17d1b018',
  });
  assert.equal(setup.shell, 'bash');
  const fullQualification =
    "steps.public-scope.outputs.scope != 'docs' && steps.public-scope.outputs.scope != 'frontend'";
  assert.equal(setup.if, fullQualification);
  assert.equal(setup['continue-on-error'], undefined);
  for (const command of [
    'set -euo pipefail',
    "--proto '=https' --tlsv1.2",
    '--connect-timeout 10 --max-time 60 --retry 0',
    'https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz',
    'sha256sum --check --status',
    '--strip-components=1 uv-x86_64-unknown-linux-gnu/uv',
  ]) {
    assert.ok(setup.run.includes(command), command);
  }
  assert.ok(setup.run.indexOf('sha256sum --check --status') < setup.run.indexOf('tar -xzf'));
  assert.doesNotMatch(setup.run, /\|\s*(?:sh|bash)\b|\|\|/);
  const crewai = job.steps.find(
    (step) => step.name === 'Qualify the official CrewAI connector without model or wallet access',
  );
  assert.ok(job.steps.indexOf(setup) < job.steps.indexOf(crewai));
  assert.equal(crewai.if, fullQualification);
  assert.equal(crewai['continue-on-error'], undefined);
  for (const command of [
    'python -m venv "$RUNNER_TEMP/agentdomain-crewai"',
    'uv --no-config --no-cache --no-python-downloads pip install --python "$RUNNER_TEMP/agentdomain-crewai/bin/python" --require-hashes --no-build -r packages/mcp-server/examples/crewai/requirements.lock',
    '-m pip install --no-deps --no-index --force-reinstall "$RUNNER_TEMP/python-release/dist/agentdomain_crewai-0.11.0-py3-none-any.whl"',
    '-m pip check',
    'importlib.util.find_spec("agentdomain_crewai")',
    'packages/mcp-server/test/crewai-package.py',
    'packages/mcp-server/test/crewai-integration.mjs',
  ]) {
    assert.ok(crewai.run.includes(command), command);
  }
  assert.doesNotMatch(crewai.run, /--no-verify|--no-deps.*requirements\.lock|\|\|/);
  const lock = await readFile(
    new URL('../packages/mcp-server/examples/crewai/requirements.lock', import.meta.url),
    'utf8',
  );
  assert.match(lock, /^uv==0\.11\.33 \\/m);
});
