# AgentDomain

AgentDomain is the agent-native identity and communications infrastructure.

Built for developers, people working through agents, and autonomous workflows,
AgentDomain makes identity and communication programmable through APIs, SDKs,
and agent integrations. Domains, DNS, HTTPS, email, AgentID, optional Basename
or ENS, and x402 payments support that foundation.

- Website: [agentdomain.app](https://agentdomain.app)
- Documentation: [docs.agentdomain.app](https://docs.agentdomain.app)
- API: [api.agentdomain.app/api/v1](https://api.agentdomain.app/api/v1)
- Source: [GitHub](https://github.com/Talvono/AgentDomain)

## Public packages

The coordinated source version is **0.12.0** for the six npm packages (shared,
SDK, MCP, AgentKit, Eliza and LangChain) and the two Python distributions,
`agentdomain-crewai` and `agentdomain-autogen`. The registry links below show
actual published versions; a source version alone is not publication evidence.

| Package                                                                                        | Purpose                                               | Registry |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------- |
| [`@agentdomain/sdk`](https://www.npmjs.com/package/@agentdomain/sdk)                           | TypeScript SDK for AgentDomain API and x402 workflows | npm      |
| [`@agentdomain/shared`](https://www.npmjs.com/package/@agentdomain/shared)                     | Public schemas, types, constants, and utilities       | npm      |
| [`@agentdomain/mcp-server`](https://www.npmjs.com/package/@agentdomain/mcp-server)             | MCP tools for agent runtimes                          | npm      |
| [`@agentdomain/agentkit-plugin`](https://www.npmjs.com/package/@agentdomain/agentkit-plugin)   | Coinbase AgentKit integration                         | npm      |
| [`@agentdomain/eliza-plugin`](https://www.npmjs.com/package/@agentdomain/eliza-plugin)         | ElizaOS integration                                   | npm      |
| [`@agentdomain/langchain-plugin`](https://www.npmjs.com/package/@agentdomain/langchain-plugin) | Native LangChain JavaScript tools                     | npm      |
| [`agentdomain-crewai`](https://pypi.org/project/agentdomain-crewai/)                           | Standalone native CrewAI Python integration           | PyPI     |
| [`agentdomain-autogen`](https://pypi.org/project/agentdomain-autogen/)                         | Standalone native AutoGen Python integration          | PyPI     |

CrewAI and Microsoft AutoGen have their own Python distributions. Both retain the native stdio MCP
interface and require a separately installed Node MCP server.

SDK installation for this source version:

```bash
npm install @agentdomain/sdk@0.12.0
```

See the [release notes](https://github.com/Talvono/AgentDomain/releases/latest)
for completed public releases and their exact registry provenance. All eight
0.12.0 packages were published by GitHub Actions OIDC, and their registry bytes
and signed provenance were verified before the release was created.

## Lifecycle workflow

The SDK and MCP releases include independent identity inspection, renewal
observations and unsigned planning; the current release is **0.12.0**.
See the [release notes](https://github.com/Talvono/AgentDomain/releases/tag/npm-v0.12.0)
for publication evidence and the [Identity Check](https://agentdomain.app/verify)
for read-only inspection.

- `inspectAgentIdentity` observes the AgentDomain registry on Base without
  platform credentials or a wallet. Missing identities, RPC errors, owner
  mismatches and inconsistent records remain distinct.
- `inspectAgentRenewal` reads identity and RenewalVault state at the same
  canonical safe-block hash, including available/reserved USDC, timing and flags.
- `prepareAutoRenewChange` creates an unsigned, attributed setting transaction.
  `executeAutoRenewChange` requires a separate host-provided human approval
  callback; `confirmAutoRenewChange` checks the actual transaction and safe
  readback. Uncertain submissions are not automatically resent.
- The verification view adds read-only renewal observations. The framework
  flows stop at inspection or unsigned preparation, without wallet execution.

These are RPC observations, not consensus proofs or verification of linked
Basename/ENS ownership. The minimum vault fee is not a registrar quote, and
changing auto-renew does not itself renew a domain. Enabling permits authorized
renewal operators to use funded vault balances without a new signature for each
renewal; disabling does not cancel an existing reservation.

| New integration                              | Implementation                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| [LangChain](packages/langchain-plugin)       | TypeScript tools using `@langchain/core`; unsigned planning is a host opt-in.         |
| [CrewAI](packages/crewai-plugin)             | Standalone Python tools using official core-native MCP APIs.                          |
| [Microsoft AutoGen](packages/autogen-plugin) | Standalone guarded Python `McpWorkbench` for identity, renewal and unsigned planning. |

The deterministic framework tests need no paid model and submit no live wallet
transactions. The optional CrewAI recipe retains known Chroma dependency
advisories; passing its isolated tests is not a clean security audit. Read the
[scoped security note](packages/mcp-server/examples/crewai/README.md#security-note)
before using the Python integration.
See the [renewal guide](apps/docs/src/content/docs/guides/renewal.mdx)
for the approval and billing boundaries.

## Documentation for tools

The [docs build](apps/docs/README.md) now generates `llms-full.txt`,
`openapi.json`, `api-index.json` and `.well-known/agentdomain.json` from reviewed
public sources. They describe documented interfaces, with source hashes and
workspace versions; they do not invent REST endpoints for onchain functions,
authorize actions, or prove npm publication. Published outputs:
[full text](https://docs.agentdomain.app/llms-full.txt),
[OpenAPI](https://docs.agentdomain.app/openapi.json),
[API index](https://docs.agentdomain.app/api-index.json), and
[discovery](https://docs.agentdomain.app/.well-known/agentdomain.json).

For AI assistance in development, see
[AI_DISCLOSURE.md](AI_DISCLOSURE.md).

## Tech stack

| Surface                  | Technologies                                                   |
| ------------------------ | -------------------------------------------------------------- |
| Frontend                 | Next.js 16, React 19, TypeScript, Tailwind CSS, TanStack Query |
| Wallet and onchain       | wagmi, viem, ethers, SIWE, x402, Base                          |
| Documentation            | Astro 7, Starlight                                             |
| SDK and integrations     | TypeScript, Model Context Protocol SDK, Zod                    |
| Smart contracts          | Solidity, Foundry, OpenZeppelin                                |
| Hosting and build system | Cloudflare Workers, OpenNext, Wrangler, pnpm, Turborepo        |

## Smart contracts

Public smart-contract source and available Base deployment records are in
[`contracts`](contracts). Review the published artifacts and
verify relevant addresses onchain before integrating.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report
suspected vulnerabilities through the confidential process in
[SECURITY.md](SECURITY.md), not through a public issue.

## License

Unless a file or third-party notice states otherwise, the source code and
documentation in this repository are licensed under the
[Apache License 2.0](LICENSE). AgentDomain names, logos, marks, and brand artwork
are excluded from that license; see [NOTICE](NOTICE).
