# @agentdomain/shared

Public TypeScript contracts shared by AgentDomain clients and integrations.

## Install

Install the version used by these examples:

```bash
npm install @agentdomain/shared@0.11.1
```

## Usage

```ts
import {
  AGENTDOMAIN_API_BASE_URL,
  SERVICE_PLAN_CATALOG,
  registrationParamsSchema,
} from '@agentdomain/shared';

const registration = registrationParamsSchema.parse(input);
```

Use focused subpath exports when an application needs a smaller public surface:

```ts
import { AGENTDOMAIN_API_BASE_URL } from '@agentdomain/shared/constants';
import { registrationParamsSchema } from '@agentdomain/shared/schemas';
import type { RegistrationParams } from '@agentdomain/shared/types';
```

The package includes:

- Public API request and response types
- Runtime Zod schemas for public inputs
- DNS, service-plan, network, and API constants
- Stable utility functions used by the public SDK and integrations

The canonical API base is `https://api.agentdomain.app/api/v1`.

## Compatibility

This package is ESM-only and ships TypeScript declarations with every export.
Treat runtime schemas as the validation boundary; do not cast untrusted input
directly to exported TypeScript types.

## Links

- [Documentation](https://docs.agentdomain.app/sdk/typescript)
- [Source](https://github.com/Talvono/AgentDomain/tree/main/packages/shared)
- [Security policy](https://github.com/Talvono/AgentDomain/security/policy)
