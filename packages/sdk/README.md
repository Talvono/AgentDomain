# @agentdomain/sdk

AgentDomain is the agent-native identity and communications infrastructure.

This TypeScript SDK makes identity and communication programmable for developers integrating
directly, people guiding agents, and permissioned autonomous workflows. Domains, DNS, SSL, email,
Basename, ENS, x402 USDC checkout, AgentID NFT, renewal controls, and per-agent Premium Plans
support that foundation.

The production API base is `https://api.agentdomain.app/api/v1`. A direct `GET` request returns the
machine-readable service discovery document; human documentation is available at
`https://docs.agentdomain.app`.

The SDK resolves a relative `apiUrl` against the browser location at construction,
before any signing or payment. Outside a browser, configure an absolute URL.
API bases must use HTTPS; explicitly configured HTTP `localhost`, `127.0.0.1`, and
`[::1]` endpoints are allowed for local development. Embedded credentials, query
strings, and fragments are rejected before requests begin.

These examples use SDK **0.11.1**. An explicit public-source build is also
documented below for local development.

```bash
npm install @agentdomain/sdk@0.11.1 viem@2.56.3
```

## Quick start

Public discovery and quotes do not require credentials:

```ts
import { AgentDomain } from '@agentdomain/sdk';

const ad = new AgentDomain();

const availability = await ad.checkAvailability('research-agent', {
  tld: 'xyz',
});

const quote = await ad.quote({
  preferredName: 'research-agent',
  tld: 'xyz',
  registerBasename: false,
  registerEns: false,
  emailUsername: 'agent',
  premiumPlan: 'included',
});
```

Pass a viem `walletClient` only for wallet-authorized or paid operations. Pass an
agent-scoped API key only to a trusted server or agent runtime; never expose it
in browser-delivered configuration.

## Identity inspection (0.11.1)

These examples pin SDK **0.11.1**. The standalone identity
and renewal workflows were introduced in 0.10.0, not recreated by this packaging
release. To build from a reviewed source checkout:

```bash
pnpm --filter @agentdomain/shared build
pnpm --filter @agentdomain/sdk build
```

```ts
import { inspectAgentIdentity } from '@agentdomain/sdk';

const observation = await inspectAgentIdentity({
  domain: 'testdomain001.xyz',
  // Optional: compare the NFT owner with an address you already trust.
  expectedOwner: '0xdE57dd241eA13A5EE749b940897538CF4ff4C25D',
});
console.log(JSON.stringify(observation, null, 2));
```

Alternatively supply `tokenId` as a positive uint256 decimal string, not a JS
number. Supply exactly one domain or token ID. No wallet, signature, transaction,
platform API key, or backend API request is used. All contract calls target the
canonical AgentDomain ERC-721 registry on Base mainnet at one RPC-reported safe
block. Every read uses that block's hash with EIP-1898 `requireCanonical: true`,
including the explicit Multicall3 aggregation. A provider that cannot honor the
hash selector fails closed; the SDK never falls back to a block number or latest.
The SDK also rechecks the block header and chain before returning a result.

`status: 'found'` establishes that a record was read, not that it is active or
endorsed. Check `lifecycle`, `consistent` and, when supplied,
`checks.expectedOwnerMatches` separately. A wallet mismatch does not change the
internal `consistent` flag. Missing records are distinct from RPC failures;
errors use `IdentityInspectionError` with `INVALID_INPUT`, `WRONG_CHAIN`,
`UNSAFE_SNAPSHOT` or `UNAVAILABLE`. No failed inspection is retried automatically.

This is a fixed-block RPC observation, **not a consensus/SPV proof, DNS-control
verification, KYC check, or agent-behavior guarantee**. Basename/ENS labels and
metadata URIs are recorded claims. Their ownership, resolution, content and
availability are not checked or fetched. JSON exports retain the observation's
block number, hash and timestamp; they are not signed certificates.

The default rate-limited public Base RPC uses an 8-second timeout per request,
zero transport retries. Four consistency reads are grouped using viem's explicit
Multicall3 action with a 4,096-byte batch bound and the same canonical block hash.
There is no polling. Production callers should pass a trusted viem
`publicClient` as the second argument; its transport policy remains their
responsibility. It must be created with `ccipRead: false`; clients with CCIP read
enabled or unspecified are rejected before requests begin. The default client
also disables CCIP read, preventing RPC-provided offchain URLs and callbacks.
All reads still require chain ID 8453 and the same safe block.

## Renewal workflow (0.11.1)

| Export                                                    | Purpose                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `inspectAgentRenewal(input, options?)`                    | Read identity and canonical RenewalVault state at the same safe-block hash. |
| `prepareAutoRenewChange(input, options?)`                 | Check owner/state and return an unsigned, attributed `setAutoRenew` plan.   |
| `executeAutoRenewChange(plan, options)`                   | Require host human approval, revalidate and request one wallet submission.  |
| `confirmAutoRenewChange(plan, transactionHash, options?)` | Read the actual transaction, canonical receipt and current safe flag once.  |

Inspection accepts the same domain/token input as identity inspection and needs
no wallet or API credential. The returned `availableAtomicUsdc`,
`reservedAtomicUsdc` and `minimumFeeAtomicUsdc` are decimal strings, not JS numbers.
Pending reservations, timing, flags and consistency are reported separately.
`minimumFeeAtomicUsdc` is a minimum accepted keeper quote, **not a registrar
price**; zero means unset. `isRenewable` checks native timing/flags, not funding or
registrar completion. Both inspections support a trusted `publicClient` with
`ccipRead: false`; the client and transport are host configuration, not tool inputs.

For a setting change, supply a string `tokenId`, current `expectedOwner`, boolean
`enabled` and public `builderCode`. This helper illustrates the separate host
approval boundary without loading keys or supplying an automatic approval:

```ts
import {
  prepareAutoRenewChange,
  executeAutoRenewChange,
  confirmAutoRenewChange,
  type AutoRenewChangeInput,
  type ExecuteAutoRenewChangeOptions,
} from '@agentdomain/sdk';

async function reviewAutoRenewSetting(
  input: AutoRenewChangeInput,
  walletClient: ExecuteAutoRenewChangeOptions['walletClient'],
  reviewInOwnerUI: ExecuteAutoRenewChangeOptions['approve'],
) {
  const plan = await prepareAutoRenewChange(input);
  const attempt = await executeAutoRenewChange(plan, {
    walletClient,
    approve: reviewInOwnerUI,
  });
  if (attempt.status !== 'submitted') return { plan, attempt };
  const confirmation = await confirmAutoRenewChange(plan, attempt.transactionHash);
  return { plan, attempt, confirmation };
}
```

`reviewInOwnerUI` must display the fresh complete plan and warnings, resolving
`true` only after explicit human approval. Never replace it with an LLM boolean
or unconditional approval. The SDK rechecks canonical ownership and vault state
after approval and reconstructs transaction fields; caller JSON is not execution
authority. No-change results require no signing. Keep the plan and any returned
hash for later read-only confirmation.

`no_change` means a fresh read already matched the desired flag. Reusing that
plan object performs fresh checks and asks for new approval if a change is now
needed. `submitted`, `rejected` and `submission_unknown` outcomes stay cached for
that object in this process; this is not persistent idempotency. An unknown
submission does not prove failure and must not trigger a new plan/signature or
automatic resend. Confirmation may be `pending`, `unverified` or `reverted`;
`confirmed` means a matching flag transaction **after the plan's recorded block**
and matching safe readback, not cryptographic proof of a particular approval or
completion of a domain renewal.

Enabling permits authorized renewal operators to use this token's funded vault
balance without a new signature for each renewal; the actual quote may exceed
the minimum. Disabling prevents new reservations, but an existing one can still
complete and charge. The setting transaction has zero native value but can cost
network gas. See the [renewal guide](https://docs.agentdomain.app/guides/renewal/)
for the full result/error contracts and billing boundaries.

## Authentication model

- Public availability, quote, and registry search methods need no credential.
- Owner operations use a wallet signature through the supplied `walletClient`.
- Agent-scoped operations can use a narrowly scoped `apiKey`.
- x402 purchases require an authorized Base wallet with sufficient USDC.
- Direct Base writes also require the public `builderCode` attribution value.

The SDK does not persist credentials. Applications remain responsible for
keeping wallet and API-key material out of source, logs, client bundles, and
untrusted process environments.

`builderCode` is the public ERC-8021 app identifier assigned to your application;
it is not a wallet secret. It is required when the SDK creates a direct Base
transaction, including `setAutoRenew` and the transaction returned by
`withdrawFromVault`. Missing or invalid attribution fails before wallet
submission. Read requests and offchain signatures are unaffected. x402 v2 paid
requests continue to use the resource server's standard `builder-code`
extension rather than a direct-transaction suffix.

The SDK handles x402 v2 payment challenges for registration and Premium Plan
purchases when a `walletClient` is provided. RenewalVault funding uses a
delegated EIP-3009 authorization followed by the server's vault workflow; it is
not converted into an x402 paid resource. Email setup, SSL certification, DNS
orchestration, and AgentID NFT mint/orchestration are included in the annual
platform fee; Basename and ENS remain optional paid add-ons.

## Request-bound payment signing

SDK 0.9.1 fixes the duplicate payment-signature prompt for request-bound x402
checkout. It creates one EIP-3009 payment signature using the issued request
binding. Wallet authentication for status or other owner operations is separate
and may still require a signature.

Before signing, the helper validates exact Base-mainnet USDC requirements, a
nonzero recipient, the USDC EIP-712 domain, a positive uint256 amount, a valid
authorization timeout, and the request binding. When `extra.quoteExpiresAt` is
present, it must be an unexpired ISO timestamp and bounds the authorization's
expiry. These checks validate the challenge, not an earlier display quote or an
application-specific spending budget.

The initial registration `402` includes an opaque string at
`accepts[0].extra.registrationQuote` and an ISO `quoteExpiresAt` in the same `extra`
object. The payment payload echoes the full selected requirement as `accepted`,
including all `extra` fields unchanged. Do not decode or reconstruct the sealed
quote, drop metadata, or reprice the challenged request.

After a paid request is submitted, SDK 0.11.1 throws the exported
`RegistrationPaymentRejectedError` only for an HTTP `4xx` response other than
`408` that satisfies the public `registrationPaymentRejectionSchema`, including
`paymentSubmission: { status: 'rejected', settlementAttempted: false }`. The schema
is reusable from `@agentdomain/shared` 0.11.1. An error status or message alone does
not establish rejection before settlement.

The error exposes `code: 'REGISTRATION_PAYMENT_REJECTED'`, `serverCode`, `message`,
`handle`, and `settlementAttempted: false`. Inspect the diagnostics and retain the
handle; this only confirms that settlement was not attempted for this rejected
submission. It does not establish payment success or resolve an earlier ambiguous
attempt. HTTP `408`, `5xx`, network failures, timeouts, lost responses, and
unconfirmed conflicts remain `RegistrationPendingError` recovery cases, even if a
`408` or `5xx` body includes a rejection marker. Neither error authorizes an
automatic resend, repricing, or replacement payment signature. See the
[registration API](https://docs.agentdomain.app/api-reference/register/).

## Asynchronous registration

New in 0.9.0: submission, status, waiting, and recovery methods distinguish payment
acceptance from completed registration. SDK 0.8.x and earlier may treat HTTP `202`
as a `RegistrationResult`; their return type is not evidence that registration
finished. Use SDK 0.11.1 or integrate the documented HTTP status contract directly.

```ts
import {
  AgentDomain,
  RegistrationPaymentRejectedError,
  RegistrationPendingError,
} from '@agentdomain/sdk';

const ad = new AgentDomain({ walletClient });
const controller = new AbortController();
try {
  const identity = await ad.register(
    { preferredName: 'research-agent', tld: 'xyz' },
    { timeoutMs: 600_000, signal: controller.signal },
  );
  console.log(identity.agentId);
} catch (error) {
  if (error instanceof RegistrationPaymentRejectedError) {
    console.log(error.code, error.serverCode, error.message, error.handle);
    // Settlement was not attempted for this submission. Do not automatically resend.
  } else if (error instanceof RegistrationPendingError) {
    // Keep this non-secret handle. Timeout or abort does not cancel the purchase.
    console.log(error.reason, error.handle);
  } else {
    throw error;
  }
}
```

`submitRegistration(args, options)` sends `Prefer: respond-async` and returns either
the minimum `RegistrationAccepted` response on `202` or the original
`RegistrationResult` on `200`. `register()` calls it once, then waits on status GETs
after `202`. `waitForRegistration(acceptedOrIdOrHandle, options)` resumes waiting
without submitting any purchase. Completion returns the server-projected
`progress.result`; missing results produce `completion_result_unavailable`, never
invented NFT IDs, transaction hashes, or metadata fields. Legacy public `200` fields
remain compatible and may still report unfinished provisioning. The SDK validates
required fields and the requested domain, then returns the schema-projected result;
unknown root or nested fields are not echoed to callers.

`getRegistration(id)` and `getRegistrations({ limit, offset })` require the **payer**
wallet, not a different designated NFT owner. They never send an agent API key or
payment header as authorization. Lists default to 20 entries and accept at most 50.
With a wallet client, they omit cookies and use `X-Agent-Signature`
and reuse its in-memory signature for up to four minutes, then sign afresh. Rejected
signing and authorization failures stop waiting instead of prompting repeatedly.
Every status/list/recovery read sends `expectedPayer` from the signer, a recovery
handle, or an explicit option. It is an identity consistency check, not authentication.
The SDK rejects a missing or mismatched `X-Authenticated-Wallet` response header
before reading the response body, preventing a different session wallet from being used.
For an already signed-in browser, use `registrationAuth: 'session'` and supply
`registrationExpectedPayer` in the constructor or `expectedPayer` per request when
there is no wallet client. Session requests include cookies and do not request a
read signature. Session-only reads without a known payer fail before fetching.
Sign in and read status on the same API
host. A server-side SIWE integration must provide a cookie-preserving fetch runtime;
Node fetch does not acquire a browser session automatically.

Waiting defaults to ten minutes after acceptance; individual requests and submission
default to sixty seconds. Both support `AbortSignal` and `timeoutMs`. Status polling
honors `pollAfterSeconds` and transient-read `Retry-After` with a five-second minimum. `action_required` and
`awaiting_payment` stop the waiter with `RegistrationPendingError`; `failed` and
`refunded` produce `RegistrationFailedError` containing the server progress. A wait
timeout, abort, or read outage is not a failed-registration assertion.
An HTTP `202` response containing a minimal `action_required` handle immediately
produces `RegistrationPendingError` with that reason; read its status instead of paying again.

On a lost POST response, the SDK raises `RegistrationPendingError` and never retries
the POST or signs a new payment automatically. A known payment identifier is only a
reference, never status authorization. Use `getRegistration()` when an ID is known.
For an unknown ID, `recoverRegistration(error.handle)` performs authenticated list
reads and requires exactly one match for the exact domain and inclusive submission
time interval. Known-ID recovery enforces the same domain, time, and authenticated-payer
binding; knowing an ID does not bypass handle validation. When only an ID is available,
use a payer-authenticated `getRegistration()` read instead of inventing a recovery window.
Discovery scans at most ten pages of 50 entries (500 total) and refuses multiple matches,
incomplete searches, and no-match results. Clock skew can prevent a time match; do not
interpret no match as proof that no payment occurred. Inspect the payer's list or
contact support instead of starting another checkout.

`completed` in the status contract means the identity and all selected services are
ready, not merely that payment succeeded or an agent ID exists. DNS, HTTPS, email, and
selected names can take additional time. Estimates may be `null`; there is no instant
completion guarantee.

## Upgrading from 0.8.x

Existing `register(args)` calls remain valid, but HTTP `202` now starts authenticated
waiting instead of returning an acceptance body as a completed result. Use
`submitRegistration()` for acceptance without waiting for asynchronous provisioning,
and handle the structured errors described above. Legacy HTTP `200` results are validated and
schema-projected, so callers must not rely on unknown response fields.

The connected signer must match the registration payer (`args.wallet`); use
`ownerAddress` for a different designated NFT owner. Registration does not authorize
with an agent API key. Custom API adapters must support the documented payer-scoped
status contract, including `X-Authenticated-Wallet`. API URL validation applies at
construction, including to clients used only for discovery.

Align/deduplicate viem to the reviewed 2.56.3 version across the SDK and your client
code. An independently pinned 2.55.8 `PublicClient` lacks the required
`watchBlockHeaders` member and can fail TypeScript assignment. This release does not
promise arbitrary mixed-version viem compatibility. Package imports remain ESM-only.

The x402 packages remain aligned at 2.25.0. `createX402PaymentHeaders()` does not
impose the upstream default $1 spending cap. Unbound payments retain the existing
upstream asset-selection behavior; request-bound payments use the Base USDC checks
described above. Neither path independently verifies an earlier display quote or
introduces an application spending budget. Callers must authorize the payment terms.

## Autonomous Premium Plan actions

An agent can buy or upgrade its Premium Plan autonomously only when its runtime has an owner or delegated wallet signer on Base with enough USDC. An agent-scoped API key is enough for scoped operations like email/DNS, but it cannot sign x402 paid purchases.

```ts
const identity = await ad.register({
  preferredName: 'research-agent',
  tld: 'xyz',
  years: 1,
  premiumPlan: 'pro',
});

await ad.purchaseServicePlan({
  agentId: identity.agentId,
  plan: 'enterprise',
});
```

## Agent-scoped API keys

API keys are scoped to one agent identity and count against that agent's Premium Plan limit. Create the key from the owner dashboard or with an owner wallet signature, then pass the full key to the agent runtime.

```ts
const owner = new AgentDomain({ walletClient });
const key = await owner.createApiKey(agentId, 'Production key');

const agent = new AgentDomain({
  apiKey: key.fullKey,
});

await agent.sendEmail(agentId, {
  to: 'admin@example.com',
  fromAddress: 'agent@research-agent.xyz',
  subject: 'Status',
  text: 'Agent online.',
});
```

The full key is returned only once. A scoped key can manage only its own agent ID.

## Professional DNS management

The SDK supports every currently available DNS record type: `A`, `AAAA`,
`ALIAS`, `CAA`, `CNAME`, `HTTPS`, `MX`, `NS`, `PTR`, `SRV`, `SVCB`, `TLSA`, and
`TXT`. Structured record data is preferred; legacy `value` and `priority`
payloads remain compatible.

```ts
const capabilities = await agent.getDnsCapabilities(agentId);
const records = [
  {
    type: 'SRV',
    name: '_https._tcp.api',
    ttl: 300,
    data: { priority: 10, weight: 5, port: 443, target: 'edge.example.com' },
  },
];

const preview = await agent.previewDnsBatch(agentId, records);
await agent.applyDnsBatch(agentId, records, preview.baseRevision);
const zoneFile = await agent.exportDnsZone(agentId);
```

Batch and BIND imports must be previewed first. Apply calls require the
`baseRevision` from that preview, preventing stale changes from overwriting a
newer zone. System-managed SSL, email, verification, and routing records remain
read-only and are preserved during replace operations.

## Monthly usage, batch send, and inbound webhooks

All plans combine sent recipients and accepted inbound messages into one monthly
quota. Send up to 100 message objects in one batch request, inspect current
usage, and configure a signed inbound webhook:

```ts
await agent.sendEmailBatch(agentId, {
  messages: [{ to: 'ops@example.com', subject: 'Status', text: 'Agent online.' }],
});

const usage = await agent.getEmailUsage(agentId);
const webhook = await agent.setEmailWebhook(agentId, {
  url: 'https://example.com/webhooks/agentdomain',
  payloadMode: 'metadata',
  enabled: true,
});
```

## Email addresses

Every agent gets one editable primary email address. Starter agents can create 5
aliases, Pro agents 10, and Enterprise agents 20.

```ts
const requestId = crypto.randomUUID(); // Persist for this operation, including retries.
const result = await ad.createEmailAlias(agentId, 'billing', { idempotencyKey: requestId });
if ('change' in result) {
  console.log(result.change.requestId, result.change.phase);
} else {
  console.log(result.address.emailAddress);
}
```

Address mutations can be asynchronous. `updatePrimaryEmail`, `createEmailAlias`, and
`deleteEmailAlias` return either the completed legacy result or `{ change }` with a request UUID,
target and phase. Only `completed` confirms the change; `native_applied` and `projected` do not.
Refresh with `ad.listEmail(agentId, { sync: true })` and inspect `addressChange` and `mailStatus`.
An `unchecked` status is not verified readiness. Resolve a pending, uncertain or rejected request
before issuing another change, and refresh active addresses before using a new sender.

All three methods accept optional `{ idempotencyKey }` as their third argument. Reuse the same UUID
for an explicit retry of identical content after a lost response. The SDK does not retry these
mutations automatically. A `cancelled` request is not a completed address change.

## Links

- [TypeScript SDK guide](https://docs.agentdomain.app/sdk/typescript)
- [API reference](https://docs.agentdomain.app/api-reference/overview)
- [Source](https://github.com/Talvono/AgentDomain/tree/main/packages/sdk)
- [Security policy](https://github.com/Talvono/AgentDomain/security/policy)
