# Contributing to AgentDomain

Thank you for improving AgentDomain's public developer experience.

## Repository validation prerequisites

Repository contributors need **Python 3.11 or newer**, available as the `python`
command. The pre-install public-boundary check uses the standard-library `ast`
and `tomllib` modules; `pnpm ci:public` runs that check too. CI pins Python 3.12.
Confirm `python --version` before running repository installation or validation.

This is a repository QA prerequisite, not a Python runtime dependency for
consumers of the npm packages. The standalone Python integrations have their
own documented Python version and dependency requirements.

Run `pnpm ci:public` for public source validation. The hosted Linux workflow uses
`pnpm ci:public --cloudflare` to also build the Worker and dry-run both Cloudflare
environments. This combined command reuses the docs checks and build completed
within that invocation, validates their generated output, and does not skip the
Worker build. Standalone `pnpm ci:cloudflare` always runs the full docs check;
there is no persisted validation receipt or environment-based skip flag.

## Pull requests

Open pull requests in the [public GitHub repository](https://github.com/Talvono/AgentDomain/pulls).
Keep each pull request focused and explain the public behavior it changes. Add
or update tests and documentation when a public contract changes.

Before opening a pull request:

1. Run the public-boundary check and relevant tests.
2. Confirm no credentials, private keys, customer data, populated environment
   files, or generated artifacts are included.
3. Confirm new dependencies are necessary, license-compatible, and represented
   in the lockfile.
4. Confirm browser-visible settings contain public values only.
5. Confirm documentation links and examples work as written.

Never put a secret in browser-delivered configuration or client-side code. Keep
environment files untracked and committed examples value-free.

## Dependency advisories

`pnpm audit --prod --audit-level high` must pass. Fix an advisory by upgrading
or overriding to the first patched version. An audit exception
(`pnpm.auditConfig.ignoreGhsas`) is allowed only when no patched release exists
for a locked major version. It must name one advisory and have a test that fails
once the exception is no longer needed.

The only current exception is `GHSA-mrhx-c7xc-m3w5`, a memory-exhaustion issue
in zod array validation, patched in 4.6.6. Every workspace package uses zod 4.6.7.
WalletConnect's Reown wallet code is overridden to zod 4.6.7, since it uses only
zod-4-compatible APIs. The exception covers zod 3 inside Coinbase's x402
packages, whose latest release (2.28.0) still requires zod ^3.24.2 and uses APIs
removed in zod 4. Here zod validates x402 payment payloads, not untrusted bulk
input. The AgentKit plugin imports `zod/v3` from the patched package because
AgentKit consumes zod 3 schemas. Remove the exception once x402 moves to zod 4.

## Public release completion

Every authorized package version release includes the public tag and GitHub
release. These are release deliverables, not optional follow-up work.

Package releases start automatically after successful full Public CI for a
reviewed version change on `Talvono/AgentDomain` main. Keep the six publishable
npm package versions and both Python project versions aligned; the private root
workspace version is unrelated. Update their current installation examples and
compatibility metadata in the same pull request. An unchanged package version
does not start release builds or republish immutable registry versions.

The existing npm and Python publisher workflows use their dedicated production
environments and OIDC, not account tokens or manual dispatch. Both bind to the
exact successful main-push CI run, signed source, current main and checked
artifacts. The completion workflow verifies both publication lanes and registry
provenance before creating the matching immutable tag and GitHub release.
The signed certificate binds source, workflow and run identity. PyPI environment
selection is additionally checked against registry publisher metadata and the
signed workflow configuration; it is not a certificate environment claim.
Registry processing is handled by a bounded read-only readiness phase before
verifier installation. It polls only versions still returning 404, never
re-uploads packages or reruns repository checks. Visible metadata is a scheduling
hint, not provenance: full artifact and signature verification still follows.
Failed or uncertain publication stops without an automatic retry; reconcile
the actual registry state before an explicitly reviewed recovery. Never move
an existing tag or re-upload a published version as recovery.

1. Validate the reviewed public source with `pnpm ci:public`, secret scanning,
   package checks and the successful release workflow for the exact source SHA.
   For a coordinated release, check each publishable package version rather than
   the private workspace manifest's version.
2. Choose the release anchor before tagging. Require GitHub's
   `verification.verified: true` on the signed tag or its target commit. Preserve
   meaningful feature history with a signing-capable release or merge process.
   GitHub's Rebase and Merge creates replacement commits without signature
   verification; do not assume that a green merge result means a signed anchor.
3. Publish through the approved registry workflow and independently verify each
   package's version, archive checksum and available provenance. Record actual
   publication source SHAs and workflow runs, including any separately approved
   bootstrap exception. Do not imply that a later release tag was the publication
   source when it was not; verify package-tree equivalence where needed.
4. Create the matching public `npm-v<version>` tag for the coordinated release
   and a non-draft GitHub release with changelog, package/install links, source
   and verification evidence, and known limitations. Mark only the newest stable
   release Latest; identify prereleases as prereleases.
5. Read back the remote tag target and its GitHub signature status, the published
   release and Latest designation, and the actual npm/PyPI versions. A missing
   signature, tag, release or package remains an explicit incomplete step.

GitHub's **Verified** badge authenticates a Git signature. It is separate from
tests, a security review and registry artifact provenance. See GitHub's
[commit signature verification documentation](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification).

Do not silently move/delete published tags, rewrite public history, backdate
commits or republish immutable package versions to repair a missing badge. A
published-tag/history change or new account/security grant needs explicit owner
approval. Never commit signing keys or tokens, or bypass a verification gate when
the required signer is unavailable; report the exact unfinished prerequisite.

## Security reports

Do not disclose vulnerabilities in an issue or pull request. Follow
[SECURITY.md](SECURITY.md) for confidential reporting.
