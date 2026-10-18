import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';

export const RELEASE_CI_LIMITS = Object.freeze({ maxBytes: 1_048_576, timeoutMs: 10_000 });
const publisherWorkflows = ['publish-npm.yml', 'publish-python.yml'];
const finalizerWorkflow = 'complete-public-release.yml';
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const invalid = () => {
  throw new Error('RELEASE_CONTEXT_INVALID');
};

// Only a reviewed source change may activate the transferred publication identity.
const policy = JSON.parse(readFileSync(new URL('./public-release-policy.json', import.meta.url)));
if (!Object.hasOwn(policy.owners, policy.activeOwner)) throw new Error('RELEASE_POLICY_INVALID');
export const RELEASE_POLICY = Object.freeze({
  ...policy,
  owners: Object.freeze(policy.owners),
  operator: Object.freeze(policy.operator),
});

function environmentContext(environment) {
  return {
    repository: environment.GITHUB_REPOSITORY,
    repositoryId: environment.GITHUB_REPOSITORY_ID,
    owner: environment.GITHUB_REPOSITORY_OWNER,
    ownerId: environment.GITHUB_REPOSITORY_OWNER_ID,
    actor: environment.GITHUB_ACTOR,
    actorId: environment.GITHUB_ACTOR_ID,
    triggeringActor: environment.GITHUB_TRIGGERING_ACTOR,
    workflowRef: environment.GITHUB_WORKFLOW_REF,
    ref: environment.GITHUB_REF,
    sha: environment.GITHUB_SHA,
    eventName: environment.GITHUB_EVENT_NAME,
  };
}

function readReleaseEvent(path) {
  let descriptor;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > RELEASE_CI_LIMITS.maxBytes)
      invalid();
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      invalid();
    const bytes = Buffer.alloc(RELEASE_CI_LIMITS.maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    if (
      length > RELEASE_CI_LIMITS.maxBytes ||
      length !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      invalid();
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } catch {
    invalid();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertAutomaticSource(context) {
  if (context.owner !== 'Talvono' || context.ownerId !== RELEASE_POLICY.owners.Talvono) invalid();
}

function assertAutomaticRepository(repository, context) {
  if (
    repository?.full_name !== context.repository ||
    String(repository.id) !== RELEASE_POLICY.repositoryId ||
    repository.owner?.login !== context.owner ||
    String(repository.owner?.id) !== context.ownerId
  )
    invalid();
}

function publicCiBinding(context, run) {
  assertAutomaticSource(context);
  if (
    !positive(run?.id) ||
    !positive(run.run_attempt) ||
    !positive(run.workflow_id) ||
    run.name !== 'Public CI' ||
    run.path !== '.github/workflows/public-ci.yml' ||
    run.url !== `https://api.github.com/repos/${context.repository}/actions/runs/${run.id}` ||
    run.head_sha !== context.sha ||
    run.head_branch !== 'main' ||
    run.event !== 'push' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    ![run.actor, run.triggering_actor].every(
      (actor) =>
        actor?.login === RELEASE_POLICY.operator.login &&
        String(actor.id) === RELEASE_POLICY.operator.id &&
        actor.type === 'User',
    )
  )
    invalid();
  assertAutomaticRepository(run.repository, context);
  assertAutomaticRepository(run.head_repository, context);
  return Object.freeze({
    id: run.id,
    run_attempt: run.run_attempt,
    workflow_id: run.workflow_id,
    head_sha: run.head_sha,
  });
}

// Pure pre-checkout event guard. Checkout HEAD and fresh API qualification are separate checks.
export function assertAutomaticReleaseEvent(context, event) {
  if (context.qualificationWorkflow !== undefined) invalid();
  assertReleaseContext({ ...context, eventName: undefined, sourceRun: undefined });
  if (context.eventName !== 'workflow_run' || event?.action !== 'completed') invalid();
  assertAutomaticRepository(event.repository, context);
  return publicCiBinding(context, event.workflow_run);
}

export function releaseContext(environment) {
  const context = environmentContext(environment);
  // Keep non-Actions unit-test callers compatible; real publisher events are automatic only.
  if (context.eventName === undefined && environment.GITHUB_ACTIONS !== 'true') return context;
  if (context.eventName !== 'workflow_run') invalid();
  const sourceRun = assertAutomaticReleaseEvent(
    context,
    readReleaseEvent(environment.GITHUB_EVENT_PATH),
  );
  const bound = Object.freeze({ ...context, sourceRun });
  assertReleaseContext(bound);
  return bound;
}

// The finalizer authenticates its publisher event before passing a full REST Public CI run here.
export function releaseSourceContext(environment, { workflow, sourceRun } = {}) {
  const context = environmentContext(environment);
  if (context.eventName !== 'workflow_run' || workflow !== finalizerWorkflow) invalid();
  const bound = Object.freeze({
    ...context,
    qualificationWorkflow: workflow,
    sourceRun: publicCiBinding(context, sourceRun),
  });
  assertReleaseContext(bound);
  return bound;
}

export function assertReleaseCheckout(context, checkoutSha) {
  assertReleaseContext(context);
  if (checkoutSha !== context.sha) invalid();
}

export function assertSourceIdentity(context) {
  if (
    !Object.hasOwn(RELEASE_POLICY.owners, context.owner ?? '') ||
    context.repository !== `${context.owner}/${RELEASE_POLICY.repository}` ||
    context.repositoryId !== RELEASE_POLICY.repositoryId ||
    context.ownerId !== RELEASE_POLICY.owners[context.owner]
  )
    throw new Error('RELEASE_CONTEXT_INVALID');
}

export function assertReleaseContext(context, publication = false, workflow) {
  assertSourceIdentity(context);
  const requested = workflow ?? (!publication && context.qualificationWorkflow);
  const workflows = requested ? [requested] : publisherWorkflows;
  if (
    workflows.some(
      (file) =>
        !publisherWorkflows.includes(file) &&
        !(!publication && file === finalizerWorkflow && context.qualificationWorkflow === file),
    ) ||
    context.ref !== 'refs/heads/main' ||
    !/^[0-9a-f]{40}$/.test(context.sha ?? '') ||
    context.actor !== RELEASE_POLICY.operator.login ||
    context.actorId !== RELEASE_POLICY.operator.id ||
    context.triggeringActor !== RELEASE_POLICY.operator.login ||
    !workflows.some(
      (file) =>
        context.workflowRef === `${context.repository}/.github/workflows/${file}@refs/heads/main`,
    ) ||
    (publication && context.owner !== RELEASE_POLICY.activeOwner) ||
    (context.eventName !== undefined && context.eventName !== 'workflow_run')
  )
    throw new Error('RELEASE_CONTEXT_INVALID');
  if (
    context.eventName === 'workflow_run' ||
    context.sourceRun !== undefined ||
    context.qualificationWorkflow !== undefined
  ) {
    if (context.eventName !== 'workflow_run') invalid();
    assertAutomaticSource(context);
    if (
      !positive(context.sourceRun?.id) ||
      !positive(context.sourceRun.run_attempt) ||
      !positive(context.sourceRun.workflow_id) ||
      context.sourceRun.head_sha !== context.sha
    )
      invalid();
  }
}
