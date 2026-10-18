# AgentDomain With Native CrewAI

This thin example imports the separately installable **`agentdomain-crewai`**
Python package. The package uses CrewAI's official native `MCPClient`,
`StdioTransport` and `MCPNativeTool`, backed by the official Python MCP SDK,
to call the separately installed Node.js AgentDomain MCP server. It does not
install `crewai-tools` or `mcpadapt`. The implementation is maintained only in
`packages/crewai-plugin/src/agentdomain_crewai`, not duplicated in this example.

The deterministic example needs **no LLM, model API key, platform API key or
wallet private key**. Its exact tool allowlist is:

1. `inspect_agent_identity`: inspect the custom AgentDomain ERC-721 on Base.
2. `inspect_agent_renewal`: inspect identity and vault state at one safe block hash.
3. `prepare_auto_renew_change`: produce an unsigned zero-value `setAutoRenew` plan.

There is no execution tool or approval parameter. `enabled` requests a setting;
it is not permission to sign. An expected-owner comparison is not authentication.

## Install

Use Python **3.12** and Node.js **20 or later**. The Python lock pins CrewAI
**1.15.21**, MCP **1.28.1**, and transitive dependencies with artifact hashes.
Create a **fresh isolated environment**; installing over the older adapter's
environment would leave its removed dependencies installed. Do not install this
recipe into a backend/VPS or a shared application environment.

From this directory on macOS/Linux:

```sh
python3.12 -m venv .venv-native
.venv-native/bin/python -m pip install --require-hashes -r requirements.lock
```

On Windows PowerShell:

```powershell
py -3.12 -m venv .venv-native
.venv-native/Scripts/python.exe -m pip install --require-hashes -r requirements.lock
```

Install `agentdomain-crewai==0.11.1`
in that environment as well. To retain the exact hash-locked runtime graph:

```sh
.venv-native/bin/python -m pip install --no-deps agentdomain-crewai==0.11.1
.venv-native/bin/python -m pip check
```

For source development, build `packages/crewai-plugin` with `python -m build` from
the repository root, then replace the distribution name above with the absolute
path to `agentdomain_crewai-0.11.1-py3-none-any.whl`. Use the corresponding Windows
Python path on Windows. The built wheel is required; the example does not
silently import an uninstalled source tree.

The SDK, MCP and Python package versions used here are **0.11.1**.
For source validation, build the reviewed public
checkout from its root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agentdomain/shared build
pnpm --filter @agentdomain/sdk build
pnpm --filter @agentdomain/mcp-server build
```

Consumers can instead install the pinned npm server
in their own project:

```sh
npm install --save-exact @agentdomain/mcp-server@0.11.1
```

Point `--server` to that installation's
`node_modules/@agentdomain/mcp-server/dist/index.js`, or to
`packages/mcp-server/dist/index.js` in the reviewed source checkout. The example
does not download or execute a package through `npx`. Only run a local executable
and server entry you trust. Paths containing spaces must be quoted.

## Inspect And Prepare

From this directory, replacing the domain and owner with the intended identity:

```sh
.venv-native/bin/python readonly_flow.py \
  --server ../../dist/index.js \
  --domain your-agent.xyz \
  --expected-owner 0x1111111111111111111111111111111111111111 \
  --builder-code your_builder_code \
  --setting enable
```

On Windows use `.venv-native/Scripts/python.exe`; enter the command on one line or use
PowerShell's line continuation syntax. `--token-id 7` can replace `--domain`.
`--setting disable` prepares only a disable-setting plan. `--node` can select
an explicit Node executable.

The JSON output contains `identity`, `renewal` and `unsignedPlan`. A missing
identity produces null renewal/plan fields; RPC failure or inconsistent/foreign
ownership stops the flow. The plan retains its ID, fresh observation,
transaction destination/calldata, zero value, `noChange` and warnings.

`minimumFeeAtomicUsdc` is the vault's **minimum accepted keeper quote**, not an
actual registrar quote or a guarantee that the balance covers renewal. Reserved
funds are separate from available funds. `isRenewable` is the vault timing/flags
predicate, not proof of funding. Setting auto-renew does not renew a domain;
disabling it does not cancel an existing keeper reservation. No registrar
completion or expiry extension is confirmed here.

Preparing this plan does not authorize anything. **Signing and confirming an
enable-setting transaction later authorizes keepers to spend funded vault USDC
on future renewals without a separate signature for each renewal.** That charge
can exceed the minimum fee. A pending reservation can still complete and charge
after auto-renew is disabled. A transaction's zero native-ETH `value` is not a
promise of zero future USDC cost.

Each inspection binds its internal reads to one safe block hash. The three calls
are separate observations, not one atomic snapshot. Public RPC observations are
not SPV/consensus proofs, DNS ownership, KYC or verification of linked names.

Review any plan in a separate trusted host. Only the SDK's trusted-host
execute/confirm workflow, with explicit human approval and fresh checks, can
submit and confirm a setting change. Never turn an LLM-generated `approved: true`
or this example's output into permission to sign. No keys are accepted or saved
by this example.

## Use The Tools In A Crew

The returned objects are official native `MCPNativeTool` instances, subclassing
CrewAI `BaseTool`. Keep the tool context open through `kickoff()` and provide
your own configured model. Each invocation owns and closes a separate MCP client:

```python
from pathlib import Path
from agentdomain_crewai import readonly_tools
from crewai import Agent, Crew, Process, Task

# your_llm is supplied by your application. No model credentials enter Node.
with readonly_tools(Path("/trusted/path/to/mcp-server/dist/index.js")) as tools:
    reviewer = Agent(
        role="AgentDomain renewal reviewer",
        goal="Report identity and renewal observations, then an unsigned setting plan",
        backstory="You inspect public chain state and cannot sign or execute transactions.",
        tools=list(tools.values()),
        llm=your_llm,
        allow_delegation=False,
        cache=False,
        verbose=False,
    )
    task = Task(
        description=(
            "Inspect {domain} against expected owner {owner}. Inspect renewal for "
            "the returned token. If consistent, prepare the requested {enabled} "
            "auto-renew setting with builder code {builder_code}. Report all "
            "uncertainty, reservations and warnings. Never claim execution, "
            "approval, registrar completion, or that minimum fee is a quote."
            "Explain that actually enabling later authorizes future keeper USDC "
            "spending without per-renewal signatures, and disabling does not "
            "cancel a pending reservation."
        ),
        expected_output="Observations and an unsigned plan for a human to review, or a clear failure.",
        agent=reviewer,
    )
    crew = Crew(agents=[reviewer], tasks=[task], process=Process.sequential,
                cache=False, memory=False, verbose=False)
    # Supply domain/owner/enabled/builder_code from your application's user input.
    result = crew.kickoff(inputs=user_inputs)
```

The optional model call can cost money and send public observations to the
selected model provider. It is not part of the paid-model-free test. This example
disables framework telemetry/tracing and never loads a `.env` file. OS process
plumbing is allowlisted; wallet/API/model keys, `ALLOW_WRITES`, `NODE_OPTIONS` and
ambient AgentDomain settings are not forwarded. Write tools are forced off.
This is credential minimization, not an OS sandbox against a malicious binary.

Explicit `BaseTool.args_schema` models enforce the canonical selector union,
omit absent strings, and reject extra/approval/coerced-boolean arguments before
RPC. Discovery rejects missing, duplicated or incompatible canonical tools.
The official client is configured with `max_retries=1`, which in this pinned
version means **one total attempt**, and no tool-list/result caching. Native
30-second connection/discovery/call deadlines remain; SDK reads retain their own
bounds. A closed context rejects further calls. Framework console output is
suppressed only within this context, preserving machine-readable CLI JSON.

## Security Note

Python dependencies are separate from npm's runtime dependencies and audit.
The lock still includes mandatory ChromaDB 1.1.1 with four known advisories:
[CVE-2026-45829](https://www.hiddenlayer.com/research/chromatoast-served-pre-auth),
[CVE-2026-45830](https://www.hiddenlayer.com/sai-security-advisory/2026-06-chromadb),
[CVE-2026-45831](https://www.hiddenlayer.com/sai-security-advisory/2026-06-chromadb-3),
[CVE-2026-45833](https://www.hiddenlayer.com/sai-security-advisory/2026-06-chromadb-5).
There is also a reported [poisoned-collection configuration risk in the Python client](https://github.com/chroma-core/chroma/issues/6717);
this is not a blanket claim that risk exists only in an HTTP server.

The qualified recipe does not call Chroma clients, collections or embeddings,
run a Chroma server, or enable memory/knowledge/caching. Tests trap those entrypoints
while the native Agent/Crew and full MCP flow run. This bounds the tested recipe,
not the installed library's safety: the Python vulnerability audit is **not clean**.
Enabling memory, remote collections or arbitrary framework capabilities is outside
this scope and needs a separate security review. Do not suppress these advisories
or bypass declared dependency constraints to force an upgrade.

## Test Without Paid Services

After building the reviewed SDK/MCP, run from `packages/mcp-server`:

```sh
node test/crewai-integration.mjs
```

From the public repository root, the installed-wheel/artifact verifier is:

```sh
packages/crewai-plugin/.venv-consumer/bin/python -B packages/mcp-server/test/crewai-package.py --dist packages/crewai-plugin/dist -v
```

Replace that Python path with your fresh environment's executable (on Windows,
use its `Scripts/python.exe`). Install the exact local wheel from the supplied
`--dist` directory first. The verifier checks artifact allowlists, license and
dependency metadata, RECORD hashes, installed package bytes and non-editable
provenance, and both CLI entry points outside the source checkout. The native
suite also verifies that the thin example calls the installed package.

It uses this example's `.venv-native` by default. `AGENTDOMAIN_CREWAI_PYTHON` may point
to another environment installed from this lock plus the built Python wheel. Missing dependencies fail the
suite with installation instructions; it never silently skips or installs them.

The suite starts the actual official Python connector, real Node MCP server and
real SDK. A process-local JSON-RPC fixture replaces network responses with
synthetic ABI-encoded chain data. It rejects unexpected RPC operations and
checks that each MCP child exits, and fails if a Chroma entrypoint is used.
No model, wallet, chain write, platform API,
cloud service, customer identity or paid service is contacted.

Regenerate dependencies deliberately with the lock's recorded uv version, then rerun integration:

```sh
uv pip compile requirements.in --python-version 3.12 --universal --generate-hashes --output-file requirements.lock
```

Development checks, from the public repository root (the pinned tools are not
runtime dependencies):

```sh
uvx --from ruff==0.15.6 ruff check packages/crewai-plugin/src/agentdomain_crewai packages/mcp-server/examples/crewai/readonly_flow.py packages/mcp-server/test/crewai-integration.py packages/mcp-server/test/crewai-package.py
uvx --from ruff==0.15.6 ruff format --check packages/crewai-plugin/src/agentdomain_crewai packages/mcp-server/examples/crewai/readonly_flow.py packages/mcp-server/test/crewai-integration.py packages/mcp-server/test/crewai-package.py
uvx --from pyright==1.1.407 pyright --project packages/mcp-server/examples/crewai/pyrightconfig.json
```

Official references: [CrewAI native MCP integration](https://docs.crewai.com/en/mcp/dsl-integration),
[pinned native client source](https://github.com/crewAIInc/crewAI/blob/1.15.21/lib/crewai/src/crewai/mcp/client.py),
[Python MCP SDK](https://github.com/modelcontextprotocol/python-sdk/tree/v1.28.1).
