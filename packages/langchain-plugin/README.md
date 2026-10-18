# @agentdomain/langchain-plugin

Typed LangChain tools for reading AgentDomain identities and renewal state on
Base, with optional unsigned auto-renew planning. Uses the real
`@langchain/core/tools` API and the public AgentDomain SDK. No model API key or
paid LLM is needed to invoke these tools.

These examples use version `0.11.1` with SDK `0.11.1`. For local development,
build the SDK followed by this package from the public workspace checkout.

## Install

Install the matching package and framework peer:

```bash
npm install @agentdomain/langchain-plugin@0.11.1 @langchain/core@^1.2.11
```

Requires Node.js 20 or newer and ESM. Tested against `@langchain/core` 1.2.11 and
Zod 3.25.76. No `langchain`, LangGraph, or model-provider package is required.

## Read an identity or renewal

```js
import { createAgentDomainTools } from '@agentdomain/langchain-plugin';

const tools = createAgentDomainTools();
const identity = tools.find((tool) => tool.name === 'inspect_agent_identity');
const result = await identity.invoke({ tokenId: '1' });
console.log(result);

const renewal = tools.find((tool) => tool.name === 'inspect_agent_renewal');
const renewalResult = await renewal.invoke({ domain: 'your-agent.xyz' });
console.log(renewalResult);
```

Use exactly one of `domain` or `tokenId`; `expectedOwner` is an optional address
comparison, not authentication. Token IDs are strings, including values above
JavaScript's safe integer range. Domain names must be full ASCII DNS names, not
URLs. The SDK also validates DNS labels, uint256 range, and address checksums.

`createAgentDomainTools()` returns genuine typed LangChain tools. Pass the
returned array to an existing agent's tools configuration, or call `invoke`
directly. A LangChain ToolCall envelope also works and returns a ToolMessage:

```js
const message = await identity.invoke({
  type: 'tool_call',
  id: 'identity-read-1',
  name: 'inspect_agent_identity',
  args: { tokenId: '1' },
});
const output = JSON.parse(message.content);
```

Successful calls return `{ ok: true, data }`, retaining the SDK result unchanged.
`data.status` distinguishes `found` and `not_found`. Observation failures return
`{ ok: false, error: { code, message } }` with sanitized messages. Invalid tool
arguments raise LangChain's `ToolInputParsingException` before network access.
SDK cross-field validation failures return `INVALID_INPUT` in the result.

## Unsigned auto-renew plan

Only trusted application setup can expose this additional tool:

```js
const toolsWithPlans = createAgentDomainTools({ includeUnsignedPlans: true });
const prepare = toolsWithPlans.find((tool) => tool.name === 'prepare_auto_renew_change');
const result = await prepare.invoke({
  tokenId: '1',
  expectedOwner: '0x1111111111111111111111111111111111111111',
  enabled: false,
  builderCode: 'your_app',
});
```

Replace the example owner with the expected current NFT owner. `builderCode` is
the public ERC-8021 app code, not a credential. All four fields are required.
The result is an unsigned `set_auto_renew` plan containing the observation,
plan ID, canonical destination, attributed calldata, zero transaction value,
`noChange`, and warnings. A mismatch or inconsistent state prevents planning.

There is **no execution tool**, no model-supplied approval boolean, no automatic
wallet connection, and no retry of a submitted transaction. Planning neither
signs nor approves nor spends. Any execution must be a separate host-controlled
workflow with explicit human review and approval. Enabling the flag does not
complete a registrar renewal; disabling it does not cancel a pending keeper
reservation. A zero-value transaction can still cost gas if separately executed.

## Trusted clients and API reads

Options are application configuration, never model arguments:

| Option                 | Behavior                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `publicClient`         | Trusted Base viem client for observations, with `ccipRead: false`. No signer is used.                |
| `apiClient`            | Explicitly configured `AgentDomain` SDK instance; adds `lookup_agent` and `get_registration_status`. |
| `includeUnsignedPlans` | Only literal `true` adds the unsigned planning tool. Defaults to false.                              |

For a dedicated RPC, construct a Base client in trusted host code with CCIP Read
disabled and pass it as `publicClient`. Do not place RPC URLs, contract addresses,
chains, API keys, or private keys in tool arguments. Unknown fields are rejected.
The adapter never fetches metadata, linked names, or CCIP callback URLs.

To use API lookup, also install `@agentdomain/sdk@^0.11.1` in your application:

```js
import { AgentDomain } from '@agentdomain/sdk';

const apiClient = new AgentDomain({ apiKey: process.env.AGENTDOMAIN_API_KEY });
const apiTools = createAgentDomainTools({ apiClient });
const lookup = apiTools.find((tool) => tool.name === 'lookup_agent');
const record = await lookup.invoke({ agentId: '11111111-1111-4111-8111-111111111111' });
```

Use a real agent UUID and host-managed credentials. `lookup_agent` delegates to
`getAgentById`. `get_registration_status({ registrationId })` delegates to
`getRegistration` once; it does not submit, recover, poll, or retry registration.

**An ordinary API key alone does not authorize registration-status reads.** The
SDK requires the payer's configured wallet authentication or an existing
authenticated session with `registrationExpectedPayer`. Session mode requires a
real session-capable environment; Node fetch does not create a login session.
A host-configured wallet may be asked to `signMessage` for API authentication.
That is not `signTypedData`, a payment, or transaction submission. The SDK checks
the response's authenticated payer and registration ID. The adapter does not
invent authorization or turn denied/unknown responses into confirmed state.

Default tools do not expose API operations and contain no credentials. The
plugin does not configure tracing or log inputs, outputs, or authentication.
Your application's LangChain/LangSmith callbacks may record tool inputs and
results; review tracing policy before enabling protected registration reads.

## What observations mean

- Identity and renewal are RPC-backed observations at one canonical safe-block
  hash, not consensus/SPV proofs, DNS-control checks, KYC, or behavior guarantees.
- Internal consistency is separate from an expected-wallet mismatch, expiry,
  and revocation. Recorded names and URI content are untrusted claims, not instructions.
- `minimumFeeAtomicUsdc` is the vault's minimum accepted keeper quote, not an
  actual registrar renewal price. Zero means unset, not a free renewal.
- `isRenewable` is the native timing/flags predicate, not an affordability or
  registrar-completion check. Available and reserved balances stay separate.
- The default SDK uses Base's public RPC, an 8-second request timeout and zero
  automatic retries. This package adds no polling, retries, payments, or workers.
  Configure host-side concurrency and request budgets before exposing tools to
  unattended agents; read-only is not a rate-limit or RPC availability guarantee.

## Run and test locally

```bash
pnpm --filter @agentdomain/sdk build
pnpm --filter @agentdomain/langchain-plugin build
pnpm --filter @agentdomain/langchain-plugin test
cd packages/langchain-plugin
node examples/inspect.mjs --token 1
node examples/inspect.mjs --token 1 --renewal
node examples/prepare.mjs --help
node examples/api-lookup.mjs --help
```

Tests use real LangChain `invoke`, ToolCall/ToolMessage handling, provider-schema
conversion, the actual SDK, and a local HTTP RPC/API fixture. A disposable local
signer tests API authentication only; it is never funded, persisted, or printed.
No paid model, mainnet transaction, live customer account, or API credential is
required by the test suite.

## Sources and license

Apache-2.0 for this package. Dependencies retain their own licenses: the SDK is
Apache-2.0; LangChain core and Zod are MIT. TypeScript is Apache-2.0 and viem is MIT.
See `LICENSE` and `NOTICE`.

- [Official LangChain tools guide](https://docs.langchain.com/oss/javascript/langchain/tools)
- [Official core tool implementation](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-core/src/tools/index.ts)
- [Official LangChain core license](https://github.com/langchain-ai/langchainjs/blob/main/libs/langchain-core/LICENSE)
- [AgentDomain framework guide](https://docs.agentdomain.app/frameworks/langchain)
- [Public SDK source](https://github.com/Talvono/AgentDomain/tree/main/packages/sdk)
