"""Read-only native CrewAI -> stdio MCP -> AgentDomain SDK integration."""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Iterator, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import copy_context
from importlib.metadata import version
import json
import os
from pathlib import Path
import shutil
import sys
from typing import Any

# This read-only connector does not need framework tracing or telemetry.
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["CREWAI_TELEMETRY_DISABLED"] = "true"
os.environ["CREWAI_TRACING_ENABLED"] = "false"

from crewai.tools import BaseTool
from crewai.mcp import MCPClient
from crewai.mcp.transports.stdio import StdioTransport
from crewai.tools.mcp_native_tool import MCPNativeTool
from crewai.tools.tool_failure import ToolFailure
from crewai.events.utils.console_formatter import (
    set_suppress_console_output,
    should_suppress_console_output,
)
from mcp import StdioServerParameters
from pydantic import BaseModel, ConfigDict, model_serializer, model_validator


READ_ONLY_TOOLS = (
    "inspect_agent_identity",
    "inspect_agent_renewal",
    "prepare_auto_renew_change",
)

# OS process plumbing only. Never copy os.environ into the Node child.
PROCESS_ENV_NAMES = frozenset(
    {
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERNAME",
        "USERPROFILE",
        "HOME",
        "LOGNAME",
        "SHELL",
        "TERM",
        "USER",
    }
)


class WorkflowError(RuntimeError):
    """An observation failed or cannot safely support an unsigned plan."""


class IdentityArguments(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        json_schema_extra={
            "oneOf": [{"required": ["domain"]}, {"required": ["tokenId"]}]
        },
    )

    domain: str | None = None
    tokenId: str | None = None
    expectedOwner: str | None = None

    @model_validator(mode="before")
    @classmethod
    def exact_selector(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            raise ValueError("Identity input must be an object")
        if ("domain" in value) == ("tokenId" in value):
            raise ValueError("Supply exactly one domain or decimal tokenId")
        if any(item is None for item in value.values()):
            raise ValueError("Omit optional fields instead of supplying null")
        return value

    @model_serializer(mode="wrap")
    def omit_absent_fields(self, handler: Any) -> dict[str, Any]:
        # CrewAI 1.15.21 otherwise serializes absent optional MCP strings as null.
        return {key: value for key, value in handler(self).items() if value is not None}


class AutoRenewArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    tokenId: str
    expectedOwner: str
    enabled: bool
    builderCode: str


def child_environment(source: Mapping[str, str] | None = None) -> dict[str, str]:
    source = os.environ if source is None else source
    result = {
        key: value for key, value in source.items() if key.upper() in PROCESS_ENV_NAMES
    }
    result["AGENTDOMAIN_ENABLE_WRITE_TOOLS"] = "false"
    return result


def server_parameters(entry: Path, node: str = "node") -> StdioServerParameters:
    entry = entry.expanduser().resolve(strict=True)
    if not entry.is_file() or entry.suffix not in {".js", ".mjs"}:
        raise ValueError("Point --server to the trusted installed MCP JavaScript entry")
    executable = shutil.which(node)
    if executable is None:
        raise ValueError("Node.js was not found; provide its executable with --node")
    return StdioServerParameters(
        command=str(Path(executable).resolve(strict=True)),
        args=[str(entry)],
        env=child_environment(),
    )


def constrain_tools(tools: Sequence[BaseTool]) -> dict[str, BaseTool]:
    names = [tool.name for tool in tools]
    if len(names) != len(READ_ONLY_TOOLS) or set(names) != set(READ_ONLY_TOOLS):
        raise WorkflowError(
            "MCP tool contract mismatch. Use the reviewed @agentdomain/mcp-server "
            f"{version('agentdomain-crewai')} build with all three canonical read-only tools."
        )
    by_name = {tool.name: tool for tool in tools}
    selected = {name: by_name[name] for name in READ_ONLY_TOOLS}
    for name, tool in selected.items():
        # Public BaseTool schema hook; the official MCP transport/call stays intact.
        tool.args_schema = (
            AutoRenewArguments
            if name == "prepare_auto_renew_change"
            else IdentityArguments
        )
        tool.cache_function = lambda _arguments, _result: False
    return selected


@contextmanager
def native_tools(parameters: StdioServerParameters) -> Iterator[dict[str, BaseTool]]:
    active = True
    previous_console_suppression = should_suppress_console_output()
    set_suppress_console_output(True)

    def client_factory() -> MCPClient:
        if not active:
            raise WorkflowError("The read-only tool context is closed")
        return MCPClient(
            transport=StdioTransport(
                command=parameters.command,
                args=list(parameters.args),
                env=child_environment(parameters.env or {}),
            ),
            # The native client's range(max_retries) counts total attempts.
            max_retries=1,
            cache_tools_list=False,
        )

    async def discover() -> list[dict[str, Any]]:
        async with client_factory() as client:
            return await client.list_tools(use_cache=False)

    try:
        # Discovery enters/exits the native transport on one loop, even in an async host.
        with ThreadPoolExecutor(max_workers=1) as executor:
            definitions = executor.submit(
                copy_context().run, asyncio.run, discover()
            ).result()
        tools: list[BaseTool] = []
        for definition in definitions:
            name = definition.get("original_name")
            if name not in READ_ONLY_TOOLS:
                continue
            schema = definition.get("inputSchema", {})
            expected = (
                {
                    "tokenId": "string",
                    "expectedOwner": "string",
                    "enabled": "boolean",
                    "builderCode": "string",
                }
                if name == "prepare_auto_renew_change"
                else {
                    "domain": "string",
                    "tokenId": "string",
                    "expectedOwner": "string",
                }
            )
            properties = (
                schema.get("properties", {}) if isinstance(schema, dict) else {}
            )
            if (
                definition.get("name") != name
                or not isinstance(schema, dict)
                or schema.get("type") != "object"
                or schema.get("additionalProperties") is not False
                or not isinstance(properties, dict)
                or set(properties) != set(expected)
                or any(
                    not isinstance(properties[key], dict)
                    or properties[key].get("type") != kind
                    for key, kind in expected.items()
                )
                or (
                    name == "prepare_auto_renew_change"
                    and set(schema.get("required", [])) != set(expected)
                )
            ):
                raise WorkflowError(
                    "MCP server returned an incompatible read-only tool schema"
                )
            native = MCPNativeTool(
                client_factory=client_factory,
                tool_name=name,
                original_tool_name=name,
                server_name="agentdomain",
                tool_schema={
                    "description": definition.get("description", ""),
                    "args_schema": AutoRenewArguments
                    if name == "prepare_auto_renew_change"
                    else IdentityArguments,
                },
            )
            native.name = name
            tools.append(native)
        yield constrain_tools(tools)
    finally:
        # Native tools own and disconnect a fresh client for each invocation.
        active = False
        set_suppress_console_output(previous_console_suppression)


@contextmanager
def readonly_tools(entry: Path, node: str = "node") -> Iterator[dict[str, BaseTool]]:
    with native_tools(server_parameters(entry, node)) as tools:
        yield tools


def call_json(tool: BaseTool, arguments: dict[str, Any]) -> dict[str, Any]:
    raw = tool.run(**arguments)
    if isinstance(raw, ToolFailure):
        raise WorkflowError(f"{tool.name} failed; no plan or approval was produced")
    try:
        result = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as error:
        raise WorkflowError(f"{tool.name} did not return a JSON observation") from error
    if not isinstance(result, dict) or "error" in result:
        raise WorkflowError(f"{tool.name} failed; no plan or approval was produced")
    return result


def require_owned_identity(identity: dict[str, Any], expected_owner: str) -> None:
    details = identity.get("identity", {})
    checks = identity.get("checks", {})
    if (
        identity.get("status") != "found"
        or identity.get("chainId") != 8453
        or identity.get("consistent") is not True
        or not isinstance(checks, dict)
        or checks.get("expectedOwnerMatches") is not True
        or not isinstance(details, dict)
        or str(details.get("owner", "")).lower() != expected_owner.lower()
        or str(identity.get("nftOwner", "")).lower() != expected_owner.lower()
    ):
        raise WorkflowError(
            "Identity ownership is missing, inconsistent or does not match"
        )


def inspect_and_prepare(
    tools: Mapping[str, BaseTool],
    identity_input: dict[str, Any],
    *,
    expected_owner: str,
    enabled: bool,
    builder_code: str,
) -> dict[str, Any]:
    if (
        "expectedOwner" in identity_input
        and identity_input["expectedOwner"] != expected_owner
    ):
        raise WorkflowError("Conflicting expected owners were supplied")
    selector = IdentityArguments.model_validate(
        {**identity_input, "expectedOwner": expected_owner}
    ).model_dump()
    identity = call_json(tools["inspect_agent_identity"], selector)
    if identity.get("status") == "not_found":
        return {"identity": identity, "renewal": None, "unsignedPlan": None}
    require_owned_identity(identity, expected_owner)
    token_id = identity.get("tokenId")
    if not isinstance(token_id, str):
        raise WorkflowError("The identity did not contain a decimal tokenId")

    renewal = call_json(
        tools["inspect_agent_renewal"],
        {"tokenId": token_id, "expectedOwner": expected_owner},
    )
    if renewal.get("status") != "found" or renewal.get("consistent") is not True:
        raise WorkflowError("Renewal observations are unavailable or inconsistent")
    require_owned_identity(renewal.get("identity", {}), expected_owner)
    if renewal["identity"].get("tokenId") != token_id:
        raise WorkflowError("Renewal identity changed during observation")

    request = AutoRenewArguments.model_validate(
        {
            "tokenId": token_id,
            "expectedOwner": expected_owner,
            "enabled": enabled,
            "builderCode": builder_code,
        }
    ).model_dump()
    plan = call_json(tools["prepare_auto_renew_change"], request)
    transaction = plan.get("transaction", {})
    observation = plan.get("observation", {})
    if (
        plan.get("kind") != "set_auto_renew"
        or plan.get("chainId") != 8453
        or plan.get("tokenId") != token_id
        or str(plan.get("expectedOwner", "")).lower() != expected_owner.lower()
        or plan.get("enabled") is not enabled
        or plan.get("builderCode") != builder_code
        or not isinstance(plan.get("id"), str)
        or not isinstance(plan.get("noChange"), bool)
        or not isinstance(transaction, dict)
        or transaction.get("value") != "0"
        or not isinstance(transaction.get("data"), str)
        or not isinstance(observation, dict)
        or observation.get("consistent") is not True
        or transaction.get("to") != observation.get("vaultAddress")
    ):
        raise WorkflowError(
            "Unsigned plan does not match the requested setting and scope"
        )
    require_owned_identity(observation.get("identity", {}), expected_owner)
    if observation["identity"].get("tokenId") != token_id:
        raise WorkflowError("Plan identity changed during observation")
    return {"identity": identity, "renewal": renewal, "unsignedPlan": plan}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--server",
        required=True,
        type=Path,
        help="Trusted installed @agentdomain/mcp-server/dist/index.js",
    )
    parser.add_argument("--node", default="node")
    selector = parser.add_mutually_exclusive_group(required=True)
    selector.add_argument("--domain")
    selector.add_argument("--token-id")
    parser.add_argument("--expected-owner", required=True)
    parser.add_argument("--builder-code", required=True)
    parser.add_argument("--setting", choices=("enable", "disable"), required=True)
    args = parser.parse_args()
    identity_input = (
        {"domain": args.domain}
        if args.domain is not None
        else {"tokenId": args.token_id}
    )
    try:
        with readonly_tools(args.server, args.node) as tools:
            result = inspect_and_prepare(
                tools,
                identity_input,
                expected_owner=args.expected_owner,
                enabled=args.setting == "enable",
                builder_code=args.builder_code,
            )
        print(json.dumps(result, indent=2))
        return 0
    except WorkflowError as error:
        print(f"{error}. No transaction was signed, approved or sent.", file=sys.stderr)
        return 1
    except Exception:
        # Upstream exceptions can include local process paths or environment input.
        print(
            "Inspection failed. No transaction was signed, approved or sent.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
