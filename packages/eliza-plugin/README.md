# @agentdomain/eliza-plugin

ElizaOS actions for AgentDomain's agent-native identity and communications infrastructure.

## Install

Install the version used by these examples:

```bash
npm install @agentdomain/eliza-plugin@0.12.0 @elizaos/core
```

## Add the plugin

```ts
import agentDomainPlugin from '@agentdomain/eliza-plugin';

export const character = {
  name: 'Domain Agent',
  plugins: [agentDomainPlugin],
};
```

## Actions

The plugin gives Eliza agents a complete AgentDomain lifecycle surface:

- Registration quote and x402 registration
- Registry discovery
- Agent email send/list/batch, monthly usage, signed inbound webhooks, primary address updates, and Starter/Pro/Enterprise aliases
- Typed DNS management for all 13 supported types, including capabilities, revision-safe batches, and BIND import/export
- SSL repair/reconfiguration
- RenewalVault status, funding, and auto-renew
- Per-agent Premium Plan status and upgrades

## Runtime configuration

The default API is `https://api.agentdomain.app/api/v1`. Configure
`AGENTDOMAIN_API_URL` only for a documented alternate environment.

- `AGENTDOMAIN_API_KEY` authorizes agent-scoped DNS, email, and management calls.
- `AGENT_PRIVATE_KEY` is needed only for wallet-authorized or paid operations.
- `AGENTDOMAIN_NETWORK` defaults to `base`.
- `BASE_RPC_URL` optionally selects the Base RPC used for wallet operations.
- `RENEWAL_VAULT_ADDRESS` is required for direct auto-renew actions.
- `AGENTDOMAIN_BUILDER_CODE` identifies the public application for supported
  direct Base transactions.

Inject credentials with the runtime's secret facility. Do not place a private
key or API key in a character file, repository, command line, or log.

Set `AGENTDOMAIN_BUILDER_CODE` to your public ERC-8021 app identifier whenever
the runtime can submit direct Base writes. The value is not a private key.
Eliza passes it to the SDK and uses it for post-registration auto-renew; missing
or invalid attribution stops the direct transaction before submission. Reads,
offchain signatures, Ethereum L1 ENS operations, and standard x402 v2 paid
requests are not changed.

## Links

- [ElizaOS guide](https://docs.agentdomain.app/frameworks/elizaos)
- [API discovery](https://api.agentdomain.app/api/v1)
- [Source](https://github.com/Talvono/AgentDomain/tree/main/packages/eliza-plugin)
- [Security policy](https://github.com/Talvono/AgentDomain/security/policy)
