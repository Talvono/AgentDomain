# @agentdomain/mcp-server

[Model Context Protocol](https://modelcontextprotocol.io) server for AgentDomain.

It lets MCP-compatible clients discover and manage agent identities through the
[AgentDomain API](https://api.agentdomain.app/api/v1), with separate public Base
RPC tools for identity and renewal inspection.

The server requires Node.js 20 or newer and communicates over standard input
and output. It does not open a public listener.

## Versions

These examples use MCP and SDK **0.12.0**. Inspection and unsigned planning
were introduced in 0.10.0; version 0.11.0 also coordinates the standalone Python
integrations. For local development, build from the reviewed checkout's root:

```bash
pnpm --filter @agentdomain/shared build
pnpm --filter @agentdomain/sdk build
pnpm --filter @agentdomain/mcp-server build
node packages/mcp-server/dist/index.js
```

## Run

Run the pinned MCP server:

```bash
npx -y @agentdomain/mcp-server@0.12.0
```

For a persistent installation:

```bash
npm install -g @agentdomain/mcp-server@0.12.0
agentdomain-mcp
```

## Default tools

The server starts in read-only mode. It advertises tools that inspect public or
authorized account state, or prepare a transaction without executing it:

- `inspect_agent_identity`: custom AgentDomain registry ownership, lifecycle and
  consistency at a canonical Base safe-block hash; no platform API credential.
- `inspect_agent_renewal`: identity and RenewalVault state at the same hash,
  including available/reserved USDC, pending reservations, timing and flags.
- `prepare_auto_renew_change`: validate owner/state and produce an unsigned,
  attributed setting plan. It never signs, broadcasts or spends.
- `check_domain_availability` and `quote_registration`
- `lookup_agent`, `get_agent`, and `search_agents`
- `list_agent_email` and `get_agent_email_usage`
- `get_dns_capabilities`, `list_dns_records`, and `export_dns_zone`
- `get_renewal_status` and `get_service_plan`

An API key may authorize additional reads, but merely supplying one never enables
mutation tools.

## Inspect and prepare, without execution

The two inspection tools accept exactly one `domain` or positive decimal-string
`tokenId`, plus optional `expectedOwner`. A comparison is not authentication.
Missing identities, failed RPC reads and inconsistent records remain distinct;
these are RPC observations, not consensus, DNS-control, KYC or linked-name proofs.
Metadata and CCIP callback URLs are not fetched.

For example, call `inspect_agent_renewal` with `{"tokenId":"1"}`. To prepare a
setting change, call `prepare_auto_renew_change` with:

```json
{
  "tokenId": "1",
  "expectedOwner": "0x1111111111111111111111111111111111111111",
  "enabled": false,
  "builderCode": "your_app"
}
```

Replace the example token/owner with the intended identity. Do not send RPC
URLs, contract overrides, chains, credentials or an `approved` boolean as tool
arguments. `enabled` is a requested setting, not permission to execute. The
JSON-safe plan includes observations, ID, warnings, `noChange`, and zero-value
transaction fields. Forward it to a separate trusted owner UI, not a model's
signer. These new tools do not expose `executeAutoRenewChange`; existing opt-in
write tools such as `enable_auto_renew` remain separate.

The minimum vault fee is not a registrar quote. If an owner later approves and
executes an enable plan, authorized renewal operators may use funded balances
without a new signature for each renewal. Disabling stops new reservations but
does not cancel an existing one, which can still complete and charge. A setting
change is not a completed domain renewal. See the
[renewal guide](https://docs.agentdomain.app/guides/renewal/).

## Framework examples

- [CrewAI native Python MCP](examples/crewai/README.md): read-only inspection and
  unsigned planning using official core-native APIs. Read its
  [scoped security note](examples/crewai/README.md#security-note); functional
  tests are not a clean dependency audit.
- [Microsoft AutoGen Python McpWorkbench](examples/autogen/README.md): allowlisted
  inspection/planning with separate owner review.
- [LangChain TypeScript tools](https://docs.agentdomain.app/frameworks/langchain/):
  separate `@agentdomain/langchain-plugin`; its examples target 0.12.0. Use its
  matching reviewed source build for local development.

Python dependencies are installed separately; npm supplies the Node MCP server,
not the frameworks. The deterministic flows need no paid model and send no live
wallet transaction. Use trusted fixed executable paths and keep the stdio child
environment free of unrelated credentials. The exact CrewAI recipe uses no
Chroma client, collections, embeddings, server or memory. Known Chroma advisories
also concern Python-client use of poisoned collection configuration, not just
servers; consult the linked security note before extending the recipe. No
general dependency-safety claim is made.

## Read-only configuration

Start without a signing credential for discovery, lookup, search, and other
read-only operations. For example:

```json
{
  "mcpServers": {
    "agentdomain": {
      "command": "npx",
      "args": ["-y", "@agentdomain/mcp-server@0.12.0"],
      "env": {
        "AGENTDOMAIN_API_URL": "https://api.agentdomain.app/api/v1"
      }
    }
  }
}
```

This remains read-only even if the MCP process receives an ambient API key or
wallet credential.

## Enabling write tools

Write tools are omitted from discovery and blocked at dispatch unless
`AGENTDOMAIN_ENABLE_WRITE_TOOLS` is set to the exact value `true`. Unset or exact
`false` keeps read-only mode. Empty, mixed-case, numeric, whitespace-padded, or
otherwise malformed values stop startup rather than guessing intent.

The opt-in exposes registration, email sending/configuration, email deletion,
DNS mutations, SSL reconfiguration, renewal funding/withdrawal/automation, plan
purchases/scheduling, and registry-visibility changes. Configure the nonsecret
opt-in in the MCP process environment, then inject only the narrowly scoped API
or signing credential required by the selected operation through a trusted
secret-aware launcher. Do not place either credential in MCP client JSON.

## Input framing

The stdio transport limits accumulated, unprocessed input to 10 MiB
(10,485,760 bytes), including JSON framing. Oversized input clears the buffer
and closes the transport without dispatching the incomplete request. The client
must reconnect after an overflow and must not blindly replay a write whose
outcome is unknown. This transport bound is separate from API payload limits;
larger payloads are not automatically supported by splitting a single JSON line.

## Signing credentials

Supply `AGENT_PRIVATE_KEY` only when an enabled operation requires a wallet
signature. Inject it through a trusted external secret store or secret-aware
launcher; never paste it into client JSON, source code, shell history, logs, or a
repository. Use a dedicated wallet with only the authority and funds required
for the intended operation.

Owner-authorized renewal changes require the AgentID NFT owner wallet. Paid plan
purchases likewise require an authorized wallet with sufficient USDC. An
agent-scoped API key can call its permitted endpoints but cannot sign wallet
transactions.

`AGENTDOMAIN_BUILDER_CODE` is the public ERC-8021 application identifier used to
attribute supported Base transactions. It accepts 1-32 lowercase letters,
numbers, or underscores and is needed only by tools that explicitly require it.

## Pricing options

Registration pricing includes the live domain price and the AgentDomain platform
fee. Email setup, SSL certification, DNS orchestration, and AgentID NFT
orchestration are included unless the API response states otherwise.

Optional settings include:

- `registerBasename: false` to skip Basename
- `registerEns: false` to skip ENS
- `emailUsername` to customize the primary inbox local part
- `premiumPlan: "included" | "starter" | "pro" | "enterprise"` to select a plan

Use `quote_registration` before signing a payment. Treat the returned quote,
limits, expiry, and renewal amount as authoritative for that request.

## License

Published package releases are licensed under Apache-2.0.

## Links

- [MCP guide](https://docs.agentdomain.app/sdk/mcp)
- [API discovery](https://api.agentdomain.app/api/v1)
- [Source](https://github.com/Talvono/AgentDomain/tree/main/packages/mcp-server)
- [Security policy](https://github.com/Talvono/AgentDomain/security/policy)
