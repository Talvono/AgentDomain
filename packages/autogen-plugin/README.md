# AgentDomain AutoGen

A native Python package built on Microsoft's official AutoGen `McpWorkbench`.
It connects to the separately installed AgentDomain Node.js MCP server over
stdio. The package owns the guarded implementation; the older MCP example files
are compatibility imports and launchers, not a second implementation.

## Installation

Version **0.11.1** uses the separately installed
`@agentdomain/mcp-server@0.11.1` bridge.
The runtime never installs npm packages or silently falls back to another version.

Install both packages:

```bash
python -m pip install agentdomain-autogen==0.11.1
npm install --ignore-scripts --no-audit --no-fund @agentdomain/mcp-server@0.11.1
```

Python 3.10+ is required; qualification uses Python 3.12. The package pins official
`autogen-agentchat`, `autogen-core` and `autogen-ext[mcp]` at 0.7.5, Python
`mcp` at 1.30.0, and Pydantic at 2.13.5. These are Microsoft AutoGen packages,
not the similarly named AG2 distribution.

## Use The Installed Connector

```python
import asyncio
from pathlib import Path

from agentdomain_autogen import (
    AgentDomainWorkbench,
    inspect_and_prepare,
    server_parameters,
)


async def inspect():
    params = server_parameters(
        Path("/absolute/path/to/node"),
        installed_package=Path("/trusted/node_modules/@agentdomain/mcp-server"),
    )
    async with AgentDomainWorkbench(params) as tools:
        report = await inspect_and_prepare(tools, {"domain": "your-domain.xyz"})
        print(report)


asyncio.run(inspect())
```

Both paths must be configured by the trusted application owner, never by a model
or tool response. Use `node.exe` on Windows. For development only, replace
`installed_package` with `source_checkout=Path("/reviewed/built/AgentDomain")`.
That explicit mode requires the existing built MCP entrypoint; it never runs a
TypeScript loader or fetches an alternate executable.

The console command and `python -m agentdomain_autogen` accept the same arguments:

```bash
agentdomain-autogen --node /absolute/path/to/node \
  --installed-package /trusted/node_modules/@agentdomain/mcp-server \
  --domain your-domain.xyz
```

Use a domain XOR decimal token ID. An optional `--expected-owner 0x...` compares
an address; it is not authentication. `--prepare-enable` or `--prepare-disable`
also requires an expected owner and `--builder-code`, and returns an unsigned
setting plan for separate owner review. It does not execute that plan.

The importable `inspect_and_prepare` function accepts `enabled=True/False` and
`builder_code="your_registered_code"` for that same optional preparation step.

## Policy And Trust Boundary

Only these MCP tools are discoverable and callable:

- `inspect_agent_identity`
- `inspect_agent_renewal`
- `prepare_auto_renew_change`

The workbench validates closed argument schemas before calling the actual MCP
server. Arbitrary RPC/chain/registry/command/key/approval fields and execution
tools are rejected. Arguments are limited to 16 KiB, parsed JSON results to
1 MiB, and stdio reads to 30 seconds. The trusted package manifest is limited
to 64 KiB. Token IDs must be positive uint256 decimal strings, domains at most
253 characters, and builder codes 1-32 lowercase letters, digits or underscores.

The child receives an OS-variable allowlist and a minimal PATH. Wallet keys,
AgentDomain API keys, write flags, model/provider configuration, cloud/proxy
credentials and `NODE_OPTIONS` are not forwarded. Python MCP's inherited OS
variables are accounted for by the pinned client version. This is not an OS
sandbox: the configured executable and installed dependencies must be trusted.

An expected-owner match, model statement or approval boolean cannot authorize
a transaction. Minimum fees are not registrar quotes. Setting preparation does
not fund a vault, spend, sign, approve, broadcast or complete a domain renewal.
A separate trusted wallet host owns actual human approval and SDK execution.
Enabling there may allow later authorized renewal spending from funded balances;
disabling does not cancel an existing reservation.

RPC observations are not consensus proofs, DNS verification or confirmation of
linked names/metadata. Errors are not converted into successful observations.
Use the workbench as an async context manager. Component serialization is refused
because restoring the upstream base provider would drop the guard.

## Optional Real AssistantAgent

`create_assistant(model, workbench)` constructs the real AutoGen AssistantAgent,
with this guarded workbench, at most three tool iterations and no MCP sampling
model. Supply and close your own trusted model client. No provider extra or model
key is required for deterministic inspection.

`agentdomain-autogen-assistant` is an optional CLI. It reads a trusted AutoGen
component JSON from `AUTOGEN_MODEL_CONFIG` (at most 16 KiB); configure the actual
provider extra separately. Loading component JSON can import code, so never take
it from a model, website or MCP output. The package does not save that config or
forward provider keys to Node. Model calls can incur provider charges.

## Build And Qualify Without Publishing

From the public checkout, use an isolated Python venv/cache under ignored
`.qa/`, not a source directory or a global install:

```bash
python -m pip install build==1.3.0
python -m build --outdir .qa/autogen-package/dist packages/autogen-plugin
python -m pip install \
  -r packages/mcp-server/examples/autogen/framework-requirements.txt \
  -c packages/mcp-server/examples/autogen/constraints.txt
python -m pip install --force-reinstall --no-deps --no-index \
  .qa/autogen-package/dist/agentdomain_autogen-0.11.1-py3-none-any.whl
python -m pip check
python -B packages/autogen-plugin/test/verify_artifacts.py .qa/autogen-package/dist
```

The PEP 517 build creates a wheel from the sdist as well as the sdist itself.
Both have an explicit source/license allowlist. No tests, caches, credentials,
Node installation or private code belong in either archive.
The framework-only CI input deliberately excludes this unpublished package.
Never use the consumer's self-requirement to bootstrap a first-release build.

Build the public MCP/SDK through the repository's reviewed workflow, then run:

```bash
AGENTDOMAIN_AUTOGEN_PYTHON=/absolute/path/to/venv/bin/python \
  node --test packages/mcp-server/test/autogen.integration.test.mjs
```

On PowerShell, set `$env:AGENTDOMAIN_AUTOGEN_PYTHON` to the isolated venv's
`Scripts/python.exe`. The native suite verifies that the connector imports from
an installed distribution, uses actual AutoGen and the Node MCP/SDK against
labelled synthetic RPC fixtures, exercises the real replay-model AssistantAgent,
and checks MCP child shutdown. It makes no paid LLM or live wallet calls.

Packaging follows [PyPA's PEP 517 project guide](https://packaging.python.org/en/latest/tutorials/packaging-projects/)
and [Hatchling's explicit file selection](https://hatch.pypa.io/latest/config/build/#explicit-selection).
The source is Apache-2.0; included LICENSE and NOTICE preserve the public
repository's copyright and trademark terms.
