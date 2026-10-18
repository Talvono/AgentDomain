"""Paid-model-free tests of official CrewAI tools against real Node MCP + SDK."""

from contextlib import contextmanager, ExitStack, redirect_stdout
import asyncio
import importlib.abc
import importlib.metadata
import json
from io import StringIO
import os
from pathlib import Path
import sys
import sysconfig
import tomllib
import unittest
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parents[1]
VERSION = tomllib.loads((PACKAGE.parent / "crewai-plugin/pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
sys.path.insert(0, str(PACKAGE / "examples" / "crewai"))

from crewai.tools import BaseTool  # noqa: E402
from crewai import Agent, Crew, Task  # noqa: E402
from crewai.llms.base_llm import BaseLLM  # noqa: E402
from crewai.mcp import MCPClient  # noqa: E402
from crewai.tools.mcp_native_tool import MCPNativeTool  # noqa: E402
from crewai.tools.tool_failure import ToolFailure  # noqa: E402
from pydantic import ValidationError  # noqa: E402
import agentdomain_crewai  # noqa: E402
from readonly_flow import (  # noqa: E402
    AutoRenewArguments,
    IdentityArguments,
    READ_ONLY_TOOLS,
    WorkflowError,
    call_json,
    child_environment,
    constrain_tools,
    inspect_and_prepare,
    main,
    native_tools,
    readonly_tools,
    server_parameters,
)


@contextmanager
def chroma_tripwires():
    import chromadb
    from chromadb.api.client import Client
    from chromadb.api.async_client import AsyncClient
    from chromadb.api.models.Collection import Collection
    from chromadb.api.models.CollectionCommon import CollectionCommon
    from chromadb.api import collection_configuration
    from chromadb.config import System

    hits = []
    watched = []

    def trap(name):
        def reject(*_args, **_kwargs):
            hits.append(name)
            raise AssertionError(f"Recipe accessed forbidden Chroma operation: {name}")

        return reject

    class NoChromaServer(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname == "chromadb.server" or fullname.startswith("chromadb.server."):
                trap(fullname)()
            return None

    with ExitStack() as stack:
        targets = [
            (
                chromadb,
                [
                    "Client",
                    "PersistentClient",
                    "EphemeralClient",
                    "HttpClient",
                    "AsyncHttpClient",
                    "CloudClient",
                    "AdminClient",
                ],
            ),
            (
                Client,
                [
                    "__init__",
                    "create_collection",
                    "get_collection",
                    "get_or_create_collection",
                    "delete_collection",
                    "list_collections",
                ],
            ),
            (
                AsyncClient,
                [
                    "__init__",
                    "create_collection",
                    "get_collection",
                    "get_or_create_collection",
                    "delete_collection",
                    "list_collections",
                ],
            ),
            (CollectionCommon, ["__init__", "_embed", "_embed_record_set"]),
            (Collection, ["add", "get", "query", "upsert", "update", "delete"]),
            (
                collection_configuration,
                [
                    "load_create_collection_configuration_from_json",
                    "load_update_collection_configuration_from_json",
                    "load_collection_configuration_from_json",
                ],
            ),
            (System, ["start"]),
        ]
        for target, names in targets:
            for name in names:
                assert hasattr(target, name), f"Chroma tripwire target drifted: {name}"
                label = f"{target.__name__}.{name}"
                watched.append(label)
                stack.enter_context(patch.object(target, name, side_effect=trap(label)))
        finder = NoChromaServer()
        sys.meta_path.insert(0, finder)
        stack.callback(sys.meta_path.remove, finder)
        yield hits, watched


OWNER = "0x1111111111111111111111111111111111111111"
NODE = os.environ["CREWAI_TEST_NODE"]
ENTRY = PACKAGE / "test" / "crewai-fixture.mjs"
POISON = {
    "AGENT_PRIVATE_KEY": "synthetic-do-not-inherit",
    "AGENTDOMAIN_API_KEY": "synthetic-do-not-inherit",
    "AGENTDOMAIN_API_URL": "https://never-contact.example.invalid",
    "AGENTDOMAIN_ENABLE_WRITE_TOOLS": "true",
    "ALLOW_WRITES": "true",
    "NODE_OPTIONS": "--require=does-not-exist",
    "OPENAI_API_KEY": "synthetic-do-not-inherit",
    "ANTHROPIC_API_KEY": "synthetic-do-not-inherit",
    "GOOGLE_API_KEY": "synthetic-do-not-inherit",
}


class NoModelCalls(BaseLLM):
    def call(
        self,
        messages,
        tools=None,
        callbacks=None,
        available_functions=None,
        from_task=None,
        from_agent=None,
        response_model=None,
    ):
        raise AssertionError("Constructing the example Crew must not call a paid model")


@contextmanager
def fixture(mode="found"):
    with patch.dict(os.environ, POISON):
        params = server_parameters(ENTRY, NODE)
        params.args.append(mode)
        with native_tools(params) as tools:
            yield tools


def flow(tools, **overrides):
    arguments = {
        "expected_owner": OWNER,
        "enabled": True,
        "builder_code": "crewai_example",
    }
    arguments.update(overrides)
    return inspect_and_prepare(tools, {"domain": "reader.xyz"}, **arguments)


class ArgumentsTests(unittest.TestCase):
    def test_connector_is_installed_wheel_and_example_is_only_a_bridge(self):
        self.assertEqual(importlib.metadata.version("agentdomain-crewai"), VERSION)
        self.assertEqual(agentdomain_crewai.__version__, VERSION)
        assert agentdomain_crewai.__file__ is not None
        installed_path = Path(agentdomain_crewai.__file__).resolve()
        self.assertTrue(
            installed_path.is_relative_to(Path(sysconfig.get_path("purelib")).resolve())
        )
        self.assertIs(readonly_tools, agentdomain_crewai.readonly_tools)
        self.assertIs(inspect_and_prepare, agentdomain_crewai.inspect_and_prepare)

    def test_chroma_tripwires_really_reject_client_and_embedding_access(self):
        import chromadb
        from chromadb.api.models.CollectionCommon import CollectionCommon

        with chroma_tripwires() as (hits, watched):
            with self.assertRaises(AssertionError):
                chromadb.Client()
            with self.assertRaises(AssertionError):
                getattr(CollectionCommon, "_embed")(None, [])
            self.assertEqual(len(hits), 2)
            self.assertGreaterEqual(len(watched), 30)

    def test_fresh_environment_has_no_removed_adapter_or_pdf_dependencies(self):
        for name in (
            "crewai-tools",
            "mcpadapt",
            "pymupdf",
            "python-docx",
            "lxml",
            "pytube",
            "youtube-transcript-api",
            "beautifulsoup4",
            "soupsieve",
            "defusedxml",
            "tiktoken",
        ):
            with (
                self.subTest(name=name),
                self.assertRaises(importlib.metadata.PackageNotFoundError),
            ):
                importlib.metadata.version(name)
        self.assertEqual(importlib.metadata.version("crewai"), "1.15.21")
        self.assertEqual(importlib.metadata.version("mcp"), "1.28.1")

    def test_minimal_environment_and_no_ambient_flags(self):
        result = child_environment({**POISON, "PATH": "bin", "SystemRoot": "windows"})
        self.assertEqual(
            result,
            {
                "PATH": "bin",
                "SystemRoot": "windows",
                "AGENTDOMAIN_ENABLE_WRITE_TOOLS": "false",
            },
        )

    def test_optional_arguments_omitted_not_null(self):
        self.assertEqual(
            IdentityArguments(domain="reader.xyz").model_dump(),
            {"domain": "reader.xyz"},
        )
        self.assertEqual(IdentityArguments(tokenId="7").model_dump(), {"tokenId": "7"})
        for value in (
            {},
            {"domain": "x", "tokenId": "7"},
            {"tokenId": 7},
            {"domain": "x", "expectedOwner": None},
            {"domain": "x", "approved": True},
        ):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                IdentityArguments.model_validate(value)

    def test_no_model_boolean_approval_or_coercion(self):
        args = {
            "tokenId": "7",
            "expectedOwner": OWNER,
            "enabled": True,
            "builderCode": "crewai_example",
        }
        for value in (
            {**args, "approved": True},
            {**args, "enabled": "true"},
            {**args, "enabled": 1},
        ):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                AutoRenewArguments.model_validate(value)

    def test_missing_duplicate_or_unexpected_tool_fails_closed(self):
        with self.assertRaises(WorkflowError):
            constrain_tools([])


class NativeConnectorTests(unittest.TestCase):
    def setUp(self):
        context = chroma_tripwires()
        hits, watched = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)

        def verify():
            self.assertEqual(hits, [], "The qualified recipe must never access Chroma")
            print(
                "CREWAI_CHROMA "
                + json.dumps(
                    {"test": self.id(), "watched": len(watched), "hits": len(hits)}
                ),
                flush=True,
            )

        self.addCleanup(verify)

    def test_real_official_connector_and_sdk_unsigned_flow(self):
        with patch.dict(os.environ, POISON), readonly_tools(ENTRY, NODE) as tools:
            self.assertEqual(set(tools), set(READ_ONLY_TOOLS))
            self.assertTrue(all(isinstance(tool, BaseTool) for tool in tools.values()))
            self.assertTrue(all(type(tool) is MCPNativeTool for tool in tools.values()))
            ordered = list(tools.values())
            for invalid in (ordered[:2], ordered + [ordered[0]], [ordered[0]] * 3):
                with self.assertRaises(WorkflowError):
                    constrain_tools(invalid)
            reviewer = Agent(
                role="Renewal reviewer",
                goal="Inspect without signing",
                backstory="Read-only integration fixture",
                tools=ordered,
                llm=NoModelCalls(model="fixture-no-model"),
                allow_delegation=False,
                cache=False,
                verbose=False,
            )
            crew = Crew(
                agents=[reviewer],
                tasks=[
                    Task(
                        description="Inspect an identity",
                        expected_output="Observation",
                        agent=reviewer,
                    )
                ],
                cache=False,
                memory=False,
                verbose=False,
            )
            agent_tools = crew.agents[0].tools
            self.assertIs(crew.memory, False)
            self.assertIsNone(crew._memory)
            self.assertFalse(crew.knowledge_sources)
            self.assertFalse(reviewer.knowledge_sources)
            self.assertIs(crew.cache, False)
            assert agent_tools is not None
            self.assertEqual([tool.name for tool in agent_tools], list(READ_ONLY_TOOLS))
            result = flow(tools)
            self.assertEqual(result["identity"]["identity"]["domain"], "reader.xyz")
            renewal = result["renewal"]
            self.assertEqual(renewal["vault"]["availableAtomicUsdc"], "50000000")
            self.assertEqual(renewal["vault"]["minimumFeeAtomicUsdc"], "5000000")
            self.assertEqual(
                renewal["renewalExecution"], "keeper_registrar_confirmation_required"
            )
            self.assertFalse(renewal["checks"]["withinRenewalWindow"])
            plan = result["unsignedPlan"]
            self.assertEqual(plan["kind"], "set_auto_renew")
            self.assertEqual(plan["tokenId"], "7")
            self.assertEqual(plan["transaction"]["value"], "0")
            self.assertTrue(plan["transaction"]["data"].startswith("0x"))
            self.assertFalse(plan["noChange"])
            self.assertEqual(json.loads(json.dumps(plan)), plan)
            print("CREWAI_PLAN " + json.dumps(plan), flush=True)
            # Optional strings must work through BaseTool.run(), not a patched client.
            self.assertEqual(
                call_json(tools["inspect_agent_identity"], {"tokenId": "7"})["status"],
                "found",
            )
            for args in (
                {"domain": "reader.xyz", "tokenId": "7"},
                {"tokenId": "7", "approved": True},
            ):
                with self.assertRaises(ValueError):
                    tools["inspect_agent_identity"].run(**args)

    def test_wrong_expected_owner_stops_before_plan(self):
        with fixture() as tools, self.assertRaises(WorkflowError):
            flow(tools, expected_owner="0x2222222222222222222222222222222222222222")

    def test_rpc_unavailable_is_not_readiness(self):
        with fixture("rpc-error") as tools, self.assertRaises(WorkflowError):
            flow(tools)

    def test_native_error_retains_mcp_failure_and_does_not_retry(self):
        with fixture("rpc-error") as tools:
            result = tools["inspect_agent_identity"].run(tokenId="7")
            self.assertIsInstance(result, ToolFailure)

    def test_tools_cannot_be_called_after_context_close(self):
        with fixture() as tools:
            tool = tools["inspect_agent_identity"]
        with self.assertRaisesRegex(RuntimeError, "context is closed"):
            tool.run(tokenId="7")

    def test_cli_is_json_only_and_preserves_unsigned_workflow(self):
        output = StringIO()
        argv = [
            "readonly_flow.py",
            "--server",
            str(ENTRY),
            "--node",
            NODE,
            "--token-id",
            "7",
            "--expected-owner",
            OWNER,
            "--builder-code",
            "crewai_example",
            "--setting",
            "enable",
        ]
        with (
            patch.object(sys, "argv", argv),
            redirect_stdout(output),
            patch.dict(os.environ, POISON),
        ):
            self.assertEqual(main(), 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result["unsignedPlan"]["transaction"]["value"], "0")

    def test_discovery_missing_duplicate_and_schema_drift_fail_closed(self):
        for mode in ("missing-tool", "duplicate-tool", "invalid-schema"):
            with self.subTest(mode=mode), self.assertRaises(WorkflowError):
                with fixture(mode):
                    self.fail("Unqualified tool discovery was accepted")

    def test_official_retry_counter_is_one_attempt_not_one_retry(self):
        params = server_parameters(ENTRY, NODE)
        from crewai.mcp.transports.stdio import StdioTransport

        client = MCPClient(
            StdioTransport(command=params.command, args=params.args), max_retries=1
        )
        attempts = 0

        async def fail():
            nonlocal attempts
            attempts += 1
            raise OSError("synthetic transport failure")

        with self.assertRaises(ConnectionError):
            asyncio.run(client._retry_operation(fail))
        self.assertEqual(attempts, 1)

    def test_missing_identity_preserved_without_plan(self):
        with fixture() as tools:
            result = inspect_and_prepare(
                tools,
                {"tokenId": "8"},
                expected_owner=OWNER,
                enabled=True,
                builder_code="crewai_example",
            )
            self.assertEqual(result["identity"]["status"], "not_found")
            self.assertIsNone(result["renewal"])
            self.assertIsNone(result["unsignedPlan"])

    def test_insufficient_funds_not_promoted_to_actual_quote_or_execution(self):
        with fixture("underfunded") as tools:
            result = flow(tools)
            self.assertFalse(result["renewal"]["checks"]["availableCoversMinimum"])
            self.assertEqual(result["renewal"]["vault"]["availableAtomicUsdc"], "0")
            self.assertEqual(result["unsignedPlan"]["transaction"]["value"], "0")

    def test_no_change_stays_no_change(self):
        with fixture("no-change") as tools:
            self.assertTrue(flow(tools)["unsignedPlan"]["noChange"])

    def test_disable_does_not_cancel_a_pending_reservation(self):
        with fixture("pending") as tools:
            result = flow(tools, enabled=False)
            self.assertEqual(
                result["renewal"]["vault"]["reservedAtomicUsdc"], "5000000"
            )
            self.assertIsNotNone(
                result["unsignedPlan"]["observation"]["vault"]["pendingRenewal"]
            )
            self.assertTrue(result["unsignedPlan"]["warnings"])
            self.assertFalse(result["unsignedPlan"]["enabled"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
