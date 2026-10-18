"""Real AutoGen + real Node MCP/AgentDomain SDK; every RPC observation is synthetic."""
# The standalone test script must add its trusted example directory before imports.
# ruff: noqa: E402

from __future__ import annotations

import inspect
import json
import os
import sys
import tomllib
import unittest
from importlib.metadata import version
from pathlib import Path
from unittest.mock import patch

EXAMPLE = Path(__file__).resolve().parents[1]
ROOT = Path(__file__).resolve().parents[5]
VERSION = tomllib.loads((ROOT / "packages/autogen-plugin/pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
sys.path.insert(0, str(EXAMPLE))

from agentdomain_workbench import (
    SYSTEM_ENV_KEYS,
    TOOL_NAMES,
    AgentDomainWorkbench,
    IdentityInput,
    PrepareInput,
    inspect_and_prepare,
    minimal_child_environment,
    result_json,
    server_parameters,
)
from assistant_example import create_assistant
from autogen_core import FunctionCall
from autogen_core.models import CreateResult, RequestUsage
from autogen_ext.models.replay import ReplayChatCompletionClient
from autogen_ext.tools.mcp import McpWorkbench

OWNER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
NODE = Path(os.environ["AGENTDOMAIN_AUTOGEN_NODE"]).resolve()
MCP_VERSION = json.loads((ROOT / "packages/mcp-server/package.json").read_text())[
    "version"
]


def workbench(mode: str = "found") -> AgentDomainWorkbench:
    params = server_parameters(NODE, source_checkout=ROOT)
    params = params.model_copy(
        update={
            "args": [
                "--import",
                (ROOT / "packages/mcp-server/test/autogen-rpc.mjs").as_uri(),
                *params.args,
            ],
            "env": {**params.env, "AUTOGEN_FIXTURE_MODE": mode},
        }
    )
    return AgentDomainWorkbench(params)


class InputAndEnvironmentTests(unittest.TestCase):
    def test_connector_is_loaded_from_the_installed_distribution_not_checkout(self):
        self.assertEqual(version("agentdomain-autogen"), VERSION)
        implementation = Path(inspect.getfile(AgentDomainWorkbench)).resolve()
        self.assertTrue(implementation.is_relative_to(Path(sys.prefix).resolve()))
        self.assertNotIn("packages/autogen-plugin/src", implementation.as_posix())
        self.assertEqual(
            AgentDomainWorkbench.__module__, "agentdomain_autogen.workbench"
        )

    def test_minimal_environment_is_allowlisted_not_a_copy_of_ambient_secrets(self):
        ambient = {
            key: "synthetic-do-not-forward"
            for key in (
                "AGENT_PRIVATE_KEY",
                "AGENTDOMAIN_API_KEY",
                "AGENTDOMAIN_ENABLE_WRITE_TOOLS",
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "AUTOGEN_MODEL_CONFIG",
                "NODE_OPTIONS",
                "NPM_TOKEN",
                "AWS_SECRET_ACCESS_KEY",
                "GOOGLE_APPLICATION_CREDENTIALS",
                "HTTPS_PROXY",
            )
        }
        ambient.update(
            PATH="untrusted-search-path", SYSTEMROOT=os.environ.get("SYSTEMROOT", "")
        )
        env = minimal_child_environment(NODE, ambient)
        self.assertTrue(set(env).issubset(SYSTEM_ENV_KEYS))
        self.assertFalse(set(env) & (set(ambient) - SYSTEM_ENV_KEYS))
        self.assertNotIn("untrusted-search-path", env["PATH"])

    def test_closed_inputs_reject_injected_config_and_boolean_approval(
        self,
    ):
        for value in (
            {},
            {"domain": "reader.xyz", "tokenId": "7"},
            {"tokenId": 7},
            {"tokenId": "07"},
            {"domain": "https://reader.xyz"},
            {"tokenId": "7", "rpcUrl": "https://invalid.test"},
            {"tokenId": "7", "privateKey": "forbidden"},
        ):
            with self.assertRaises(ValueError):
                IdentityInput.model_validate(value)
        valid = dict(
            tokenId="7",
            expectedOwner=OWNER,
            enabled=True,
            builderCode="synthetic_autogen",
        )
        self.assertEqual(PrepareInput.model_validate(valid).enabled, True)
        for delta in (
            {"enabled": "true"},
            {"enabled": 1},
            {"approved": True},
            {"builderCode": "UPPER"},
        ):
            with self.assertRaises(ValueError):
                PrepareInput.model_validate({**valid, **delta})

    def test_launcher_requires_trusted_built_package_and_no_model_command(self):
        params = server_parameters(NODE, source_checkout=ROOT)
        self.assertEqual(params.command, str(NODE))
        self.assertEqual(
            params.args, [str((ROOT / "packages/mcp-server/dist/index.js").resolve())]
        )
        self.assertNotIn("AGENT_PRIVATE_KEY", params.env)
        self.assertNotIn("AGENTDOMAIN_ENABLE_WRITE_TOOLS", params.env)
        with self.assertRaises(ValueError):
            server_parameters(NODE)
        with self.assertRaises(ValueError):
            server_parameters(NODE, installed_package=ROOT, source_checkout=ROOT)

    def test_component_serialization_cannot_restore_an_unfiltered_base_workbench(self):
        tools = AgentDomainWorkbench(server_parameters(NODE, source_checkout=ROOT))
        with self.assertRaises(TypeError):
            tools.dump_component()


class RealWorkbenchTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_workbench_calls_identity_without_ambient_keys(
        self,
    ):
        with patch.dict(
            os.environ,
            {
                "AGENT_PRIVATE_KEY": "not-a-real-key",
                "AGENTDOMAIN_API_KEY": "synthetic",
                "AGENTDOMAIN_ENABLE_WRITE_TOOLS": "true",
                "OPENAI_API_KEY": "synthetic",
            },
        ):
            async with workbench() as tools:
                self.assertIsInstance(tools, McpWorkbench)
                names = {tool["name"] for tool in await tools.list_tools()}
                self.assertEqual(
                    tools.initialize_result.serverInfo.name, "agentdomain-mcp"
                )
                self.assertEqual(
                    tools.initialize_result.serverInfo.version, MCP_VERSION
                )
                self.assertIn("inspect_agent_identity", names)
                self.assertTrue(names.issubset(TOOL_NAMES))
                result = result_json(
                    await tools.call_tool(
                        "inspect_agent_identity",
                        {"tokenId": "7", "expectedOwner": OWNER},
                    )
                )
                self.assertEqual(result["status"], "found")
                self.assertEqual(result["block"]["tag"], "safe")
                self.assertEqual(result["block"]["hash"], "0x" + "ab" * 32)
                self.assertEqual(result["checks"]["expectedOwnerMatches"], True)

    async def test_mutating_and_configuration_tools_are_denied_before_server_call(self):
        async with workbench() as tools:
            for name in (
                "enable_auto_renew",
                "fund_renewal_vault",
                "register_agent",
                "execute_auto_renew_change",
                "run_shell",
            ):
                result = await tools.call_tool(name, {"approved": True})
                self.assertTrue(result.is_error)
                self.assertIn("READ_ONLY_TOOL_DENIED", result.to_text())
            invalid = await tools.call_tool(
                "inspect_agent_identity",
                {"tokenId": "7", "rpcUrl": "https://foreign.invalid"},
            )
            self.assertTrue(invalid.is_error)
            self.assertIn("INVALID_INPUT", invalid.to_text())

    async def test_missing_identity_and_rpc_failure_are_not_fabricated_success(self):
        async with workbench("not-found") as tools:
            result = result_json(
                await tools.call_tool(
                    "inspect_agent_identity", {"domain": "reader.xyz"}
                )
            )
            self.assertEqual(result["status"], "not_found")
        async with workbench("rpc-error") as tools:
            result = await tools.call_tool("inspect_agent_identity", {"tokenId": "7"})
            self.assertTrue(result.is_error)
            with self.assertRaises(RuntimeError):
                result_json(result)

    async def test_real_assistant_agent_replay_uses_real_mcp_tools_without_paid_llm(
        self,
    ):
        requests = [
            ("inspect_agent_identity", {"tokenId": "7", "expectedOwner": OWNER}),
            ("inspect_agent_renewal", {"tokenId": "7", "expectedOwner": OWNER}),
            (
                "prepare_auto_renew_change",
                {
                    "tokenId": "7",
                    "expectedOwner": OWNER,
                    "enabled": True,
                    "builderCode": "synthetic_autogen",
                },
            ),
        ]
        model = ReplayChatCompletionClient(
            [
                CreateResult(
                    finish_reason="function_calls",
                    content=[
                        FunctionCall(
                            id=f"synthetic-call-{index}",
                            name=name,
                            arguments=json.dumps(arguments),
                        )
                    ],
                    usage=RequestUsage(prompt_tokens=0, completion_tokens=0),
                    cached=False,
                )
                for index, (name, arguments) in enumerate(requests)
            ]
        )
        try:
            async with workbench() as tools:
                agent = create_assistant(model, tools)
                result = await agent.run(
                    task=(
                        "Inspect synthetic token 7 and prepare only an unsigned "
                        "setting proposal for separate owner review."
                    )
                )
                executions = [
                    message
                    for message in result.messages
                    if message.type == "ToolCallExecutionEvent"
                ]
                self.assertEqual(len(executions), 3)
                self.assertEqual(
                    [event.content[0].name for event in executions],
                    [name for name, _ in requests],
                )
                self.assertTrue(
                    all(not event.content[0].is_error for event in executions)
                )
                plan = json.loads(result.messages[-1].content)
                self.assertEqual(plan["kind"], "set_auto_renew")
                self.assertEqual(plan["transaction"]["value"], "0")
        finally:
            await model.close()

    async def test_full_readonly_renewal_workflow_prepares_only_unsigned_owner_review(
        self,
    ):
        async with workbench() as tools:
            report = await inspect_and_prepare(
                tools,
                {"domain": "reader.xyz", "expectedOwner": OWNER},
                enabled=True,
                builder_code="synthetic_autogen",
            )
            self.assertEqual(report["mode"], "read_only")
            self.assertEqual(report["identity"]["status"], "found")
            self.assertIn("renewal", report)
            self.assertEqual(
                report["renewal"]["vault"]["minimumFeeAtomicUsdc"], "7000000"
            )
            self.assertEqual(
                report["renewal"]["renewalExecution"],
                "keeper_registrar_confirmation_required",
            )
            self.assertEqual(report["ownerReview"]["required"], True)
            plan = report["ownerReview"]["plan"]
            self.assertEqual(plan["kind"], "set_auto_renew")
            self.assertEqual(plan["transaction"]["value"], "0")
            self.assertEqual(plan["expectedOwner"].lower(), OWNER)
            self.assertEqual(plan["builderCode"], "synthetic_autogen")
            self.assertFalse(any(report["effects"].values()))

    async def test_expected_owner_mismatch_cannot_produce_a_prepared_change(self):
        async with workbench() as tools:
            with self.assertRaises(RuntimeError):
                await inspect_and_prepare(
                    tools,
                    {
                        "tokenId": "7",
                        "expectedOwner": "0x1111111111111111111111111111111111111111",
                    },
                    enabled=True,
                    builder_code="synthetic_autogen",
                )


if __name__ == "__main__":
    print(
        "AutoGen integration checks: SYNTHETIC RPC observations, "
        "no paid LLM or live transaction."
    )
    unittest.main(verbosity=2)
