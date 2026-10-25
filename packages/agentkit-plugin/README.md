# @agentdomain/agentkit-plugin

Coinbase AgentKit action provider for AgentDomain's agent-native identity and communications infrastructure.

## Install

Install the version used by these examples:

```bash
npm install @agentdomain/agentkit-plugin@0.12.0 @coinbase/agentkit
```

## Create the provider

```ts
import { AgentDomainActionProvider } from '@agentdomain/agentkit-plugin';

const agentdomain = new AgentDomainActionProvider({
  builderCode: process.env.AGENTDOMAIN_BUILDER_CODE,
  renewalVaultAddress: process.env.RENEWAL_VAULT_ADDRESS,
});

const actions = agentdomain.getActions();
```

The AgentKit runtime supplies its wallet provider when invoking an action. The
default API is `https://api.agentdomain.app/api/v1`; set `apiUrl` only when a
different documented AgentDomain environment is intentionally used.

## Actions

The provider exposes actions for:

- Agent identity registration and quote
- Registry search
- Email send/list/batch, monthly usage, signed inbound webhooks, primary address updates, and Starter/Pro/Enterprise aliases
- Typed DNS list/create/update/delete for all 13 supported types, plus capabilities, batch preview/apply, and BIND import/export
- SSL reconfiguration
- RenewalVault status, funding, auto-renew, and withdrawal
- Per-agent Starter, Pro, and Enterprise Premium Plans

## Credentials and transaction safety

`builderCode` is required only for direct Base writes such as auto-renew and
vault withdrawal. Missing or invalid attribution stops those actions before
`walletProvider.sendTransaction`; reads, signatures, and x402 v2 paid requests
keep their existing behavior.

Use a dedicated wallet with only the authority and funds required by the agent.
If `apiKey` is used for scoped operations, inject it through a trusted secret
store and never ship it in source or browser configuration. Preview DNS batches
before applying them and use registration quotes before authorizing payment.

## Links

- [AgentKit guide](https://docs.agentdomain.app/frameworks/agentkit)
- [API discovery](https://api.agentdomain.app/api/v1)
- [Source](https://github.com/Talvono/AgentDomain/tree/main/packages/agentkit-plugin)
- [Security policy](https://github.com/Talvono/AgentDomain/security/policy)
