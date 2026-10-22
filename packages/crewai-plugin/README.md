# AgentDomain CrewAI

`agentdomain-crewai` is the separately installable Python integration for
AgentDomain's Node.js MCP server. It returns official CrewAI `MCPNativeTool`
objects with strict typed inputs. It uses CrewAI's native `MCPClient` and
`StdioTransport`, not `crewai-tools` or `mcpadapt`.

Version **0.11.2** requires Python **3.12**
and Node.js **20 or later**. The Python package does not bundle or
automatically download Node.js, the MCP server, a model, or wallet credentials.

## Installation

Use a fresh isolated virtual environment, never a shared backend/VPS environment.
Install the matching Python integration and Node MCP server:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install agentdomain-crewai==0.11.2
npm install --save-exact @agentdomain/mcp-server@0.11.2
```

On Windows use `py -3.12 -m venv .venv` and `.venv/Scripts/python.exe`.
CrewAI 1.15.21 and the Python MCP SDK 1.28.1 are exact direct dependencies.
For the fully pinned, hash-verified transitive environment, install
[`requirements.lock`](https://github.com/Talvono/AgentDomain/blob/main/packages/mcp-server/examples/crewai/requirements.lock)
first, then the reviewed AgentDomain wheel with `--no-deps`, and run
`python -m pip check`. The release's lock and wheel must come from the same
reviewed source. Do not silently upgrade the dependency graph.

## Read-Only Flow

```python
from pathlib import Path
from agentdomain_crewai import inspect_and_prepare, readonly_tools

with readonly_tools(Path("node_modules/@agentdomain/mcp-server/dist/index.js")) as tools:
    result = inspect_and_prepare(
        tools,
        {"domain": "your-agent.xyz"},
        expected_owner="0x1111111111111111111111111111111111111111",
        enabled=True,
        builder_code="your_builder_code",
    )
    print(result)
```

`readonly_tools` accepts an optional `node` executable path and yields exactly:

1. `inspect_agent_identity`
2. `inspect_agent_renewal`
3. `prepare_auto_renew_change`

These are real CrewAI `BaseTool` instances. Keep the context open while your
Agent/Crew uses them; set `allow_delegation=False`, `cache=False` and
`memory=False`, and do not enable knowledge or Chroma capabilities. The
deterministic `inspect_and_prepare` flow needs no LLM or model API key.

The installed command and module entry point expose the same flow:

```sh
agentdomain-crewai --server node_modules/@agentdomain/mcp-server/dist/index.js \
  --domain your-agent.xyz \
  --expected-owner 0x1111111111111111111111111111111111111111 \
  --builder-code your_builder_code --setting enable
python -m agentdomain_crewai --help
```

Use `--token-id` instead of `--domain`, or `--setting disable` for a disable plan.
The JSON result contains `identity`, `renewal` and `unsignedPlan`. A missing
identity returns null renewal/plan fields; foreign or inconsistent ownership
and RPC errors stop the flow. Expected-owner matching is not authentication.

No signing, transaction submission, execution tool, or approval argument exists.
Preparing a zero-native-value plan does not approve spending. Actually enabling
auto-renew later authorizes keeper spending of funded vault USDC without a new
signature for every renewal. The minimum fee is not a registrar quote or a
funding guarantee. Disabling does not cancel a pending reservation. Review and
approve any execution in a separate trusted host using the SDK's fresh checks.
Public RPC observations are not consensus proofs or registrar completion.

## Security And Bounds

Only minimal OS process variables enter Node; wallet/API/model keys,
`NODE_OPTIONS`, `ALLOW_WRITES` and ambient AgentDomain settings are excluded.
Write tools are forced off. No `.env` file is loaded. The connector disables
CrewAI telemetry/tracing in the Python process. This is credential minimization,
not an OS sandbox for an untrusted local executable.

Strict input models reject null selectors, extras and coerced booleans before
RPC. Discovery rejects missing, duplicate and incompatible canonical tools.
The pinned official client retains its 30-second connection/discovery/call
deadlines, with **one total attempt** (`max_retries=1`) and tool/result caches
off. Discovery uses one worker thread; each tool call owns and closes its own
MCP session and Node child. There is no new aggregate workflow deadline or
global concurrency guarantee. A closed context rejects new calls.

### Known Dependency Advisories

The required ChromaDB 1.1.1 dependency has four known advisories:
[CVE-2026-45829](https://www.hiddenlayer.com/research/chromatoast-served-pre-auth),
[CVE-2026-45830](https://www.hiddenlayer.com/sai-security-advisory/2026-06-chromadb),
[CVE-2026-45831](https://www.hiddenlayer.com/sai-security-advisory/2026-06-chromadb-3),
[CVE-2026-45833](https://www.hiddenlayer.com/sai-security-advisory/2026-06-chromadb-5).
The reported
[poisoned-collection configuration risk also includes Python clients](https://github.com/chroma-core/chroma/issues/6717).
This is not a blanket claim that the risk exists only in an HTTP server.

The qualified three-tool flow does not call Chroma clients, collections or
embeddings, run a Chroma server, or enable memory, knowledge or caching. Tests
trap those entry points while real Agent/Crew construction and MCP calls run.
That is evidence about this bounded flow, not a patched dependency or a clean
Python CVE audit. Enabling other framework capabilities requires separate
review. Do not suppress advisories or override CrewAI's dependency constraints.
These Python dependencies are not installed by npm or deployed to AgentDomain's
backend/VPS runtime. Dependencies retain their own licenses; this package's
Apache-2.0 license does not replace them.

## Build And Verify

From a reviewed source checkout, a PEP 517 build creates a source distribution
and builds a wheel from it:

```sh
python -m build packages/crewai-plugin
```

Hatchling 1.27.0 is the pinned build backend. Both artifacts use explicit file
allowlists; no environment, tests, Node binary or vendored dependency is shipped.
Install the wheel into a fresh environment with the reviewed hash lock, then
run the installed-package and real-MCP tests documented in
[`the thin example`](https://github.com/Talvono/AgentDomain/blob/main/packages/mcp-server/examples/crewai/README.md).

Primary references: [CrewAI native MCP](https://docs.crewai.com/en/mcp/dsl-integration),
[pinned native client](https://github.com/crewAIInc/crewAI/blob/1.15.21/lib/crewai/src/crewai/mcp/client.py),
[Python packaging](https://packaging.python.org/en/latest/tutorials/packaging-projects/).
