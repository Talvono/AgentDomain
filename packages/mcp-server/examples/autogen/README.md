# AutoGen + AgentDomain

These files are thin imports and CLI launchers for the native Python package
`agentdomain-autogen` (import `agentdomain_autogen`). The guarded workbench,
argument validation, environment policy, AssistantAgent and command-line logic
are maintained only in that package. AgentDomain still uses its separate Node.js
MCP bridge over stdio.

## Install

These examples use `agentdomain-autogen==0.11.1` on PyPI and
`@agentdomain/mcp-server@0.11.1` on npm.

Install the Python requirements in an isolated venv
and the exact Node MCP bridge in a trusted directory:

```bash
python -m pip install -r requirements.txt -c constraints.txt
npm install --ignore-scripts --no-audit --no-fund @agentdomain/mcp-server@0.11.1
```

For release staging from the public checkout, install the reviewed local wheel
before running these examples or native tests:

```bash
python -m build --outdir .qa/autogen-package/dist packages/autogen-plugin
python -m pip install \
  -r packages/mcp-server/examples/autogen/framework-requirements.txt \
  -c packages/mcp-server/examples/autogen/constraints.txt
python -m pip install --force-reinstall --no-deps --no-index \
  .qa/autogen-package/dist/agentdomain_autogen-0.11.1-py3-none-any.whl
python -m pip check
```

Keep all venvs and caches under the ignored `.qa/` directory when developing in
the public repository. There is no editable/source import fallback: tests must
exercise the installed distribution.
CI uses `framework-requirements.txt`, not the self-package consumer requirement,
so the first release never needs to fetch itself from PyPI before it exists.

## Use

Prefer the package directly:

```python
from pathlib import Path
from agentdomain_autogen import AgentDomainWorkbench, inspect_and_prepare, server_parameters

params = server_parameters(
    Path("/absolute/path/to/node"),
    installed_package=Path("/trusted/node_modules/@agentdomain/mcp-server"),
)

async def inspect():
    async with AgentDomainWorkbench(params) as tools:
        return await inspect_and_prepare(tools, {"domain": "your-domain.xyz"})
```

The installed `agentdomain-autogen` command or `python -m agentdomain_autogen`
runs deterministic inspection without an LLM. The compatibility command
`python inspect_renewal.py` accepts the same options:

```bash
agentdomain-autogen --node /absolute/path/to/node \
  --installed-package /trusted/node_modules/@agentdomain/mcp-server \
  --domain your-domain.xyz
```

An explicit development alternative is `--source-checkout /reviewed/built/AgentDomain`.
Build the public shared/SDK/MCP packages through the repository's reviewed
workflow first. Never accept either trusted path or launch configuration from
an LLM, tool output or untrusted website.

The workflow exposes `inspect_agent_identity`, `inspect_agent_renewal` and
`prepare_auto_renew_change`. For a proposal, supply `--token-id`,
`--expected-owner`, `--builder-code` and either `--prepare-enable` or
`--prepare-disable`. The output is an unsigned setting plan for separate human
review. It does not sign, fund, approve, execute or complete a registrar renewal.
A minimum fee is not a registrar quote; a model's approval is not wallet authority.

For a real optional AssistantAgent, import `create_assistant(model, workbench)`.
The `assistant_example.py` compatibility launcher delegates to the package's
optional CLI, which accepts trusted owner model configuration through
`AUTOGEN_MODEL_CONFIG`. Configure your own provider extra separately. Model
calls may cost money; provider keys/config are never persisted or sent to Node.
The deterministic examples and fixture tests need no model key.

See the [canonical package guide](https://github.com/Talvono/AgentDomain/tree/main/packages/autogen-plugin)
for exact bounds, pinned framework versions, owner-approval and environment
boundaries, packaging and usage. The legacy `agentdomain_workbench.py` module
only re-exports those package APIs; it has no separate guard implementation.

## Native Checks

Use the interpreter where the reviewed wheel is installed:

```bash
AGENTDOMAIN_AUTOGEN_PYTHON=/absolute/path/to/venv/bin/python \
  node --test packages/mcp-server/test/autogen.integration.test.mjs
```

PowerShell:

```powershell
$env:AGENTDOMAIN_AUTOGEN_PYTHON = 'C:/absolute/path/to/venv/Scripts/python.exe'
node --test packages/mcp-server/test/autogen.integration.test.mjs
```

The suite verifies the installed package origin, actual AutoGen/AssistantAgent
and MCP/SDK execution through labelled synthetic RPC fixtures, strict inputs,
minimal child environment and shutdown of all fixture-owned MCP processes.
Without the selected Python interpreter the optional test is explicitly skipped.
These are not paid LLM calls, live wallet transactions or customer observations.
