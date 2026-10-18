"""Native Python AutoGen MCP integration. No wallet or transaction execution."""

from __future__ import annotations

import contextlib
import json
import os
from importlib.metadata import version
from pathlib import Path
from typing import Any, Mapping

from autogen_core import CancellationToken
from autogen_core.tools import TextResultContent, ToolResult, ToolSchema
from autogen_ext.tools.mcp import McpWorkbench, StdioServerParams
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictStr,
    ValidationError,
    model_validator,
)

MCP_NPM_VERSION = version("agentdomain-autogen")
TOOL_NAMES = frozenset(
    ("inspect_agent_identity", "inspect_agent_renewal", "prepare_auto_renew_change")
)
READ_TIMEOUT_SECONDS = 30
MAX_ARGUMENT_BYTES = 16_384
MAX_RESULT_BYTES = 1_048_576

# MCP Python 1.30 inherits only this OS environment subset. We explicitly replace
# PATH and never forward application, wallet, provider, proxy or write settings.
SYSTEM_ENV_KEYS = frozenset(
    (
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
        "USERNAME",
        "USERPROFILE",
        "HOME",
        "LOGNAME",
        "SHELL",
        "TERM",
        "USER",
    )
)


def require_versions() -> None:
    for package, expected in (
        ("autogen-core", "0.7.5"),
        ("autogen-agentchat", "0.7.5"),
        ("autogen-ext", "0.7.5"),
        ("mcp", "1.30.0"),
    ):
        if version(package) != expected:
            raise RuntimeError(
                f"Install the package's pinned requirements: {package}=={expected}"
            )


def minimal_child_environment(
    node: Path, source: Mapping[str, str] | None = None
) -> dict[str, str]:
    ambient = os.environ if source is None else source
    result = {
        key: ambient[key]
        for key in SYSTEM_ENV_KEYS
        if key in ambient and not ambient[key].startswith("()")
    }
    paths = [str(node.parent)]
    if os.name == "nt" and ambient.get("SYSTEMROOT"):
        paths.append(str(Path(ambient["SYSTEMROOT"]) / "System32"))
    elif os.name != "nt":
        paths.extend(("/usr/bin", "/bin"))
    result["PATH"] = os.pathsep.join(paths)
    return result


def server_parameters(
    node: Path,
    *,
    installed_package: Path | None = None,
    source_checkout: Path | None = None,
) -> StdioServerParams:
    """Only owner-supplied trusted paths, never model/tool-result launch config."""
    require_versions()
    node = node.expanduser().resolve(strict=True)
    if not node.is_file() or node.name.lower() not in ("node", "node.exe"):
        raise ValueError("--node must identify a trusted Node executable")
    if (installed_package is None) == (source_checkout is None):
        raise ValueError(
            "Select exactly one installed package or public source checkout"
        )
    package = (
        (
            installed_package
            if installed_package is not None
            else source_checkout / "packages" / "mcp-server"
        )
        .expanduser()
        .resolve(strict=True)
    )
    manifest_path = package / "package.json"
    if manifest_path.stat().st_size > 65_536:
        raise ValueError("Unexpected MCP package manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("name") != "@agentdomain/mcp-server":
        raise ValueError("Not the AgentDomain MCP package")
    if installed_package is not None and manifest.get("version") != MCP_NPM_VERSION:
        raise ValueError(f"Expected @agentdomain/mcp-server@{MCP_NPM_VERSION}")
    entry = (package / "dist" / "index.js").resolve(strict=True)
    if not entry.is_file() or not entry.is_relative_to(package):
        raise ValueError(
            "Build the reviewed MCP source first; no source-loader fallback"
        )
    return StdioServerParams(
        command=str(node),
        args=[str(entry)],
        cwd=str(package),
        env=minimal_child_environment(node),
        read_timeout_seconds=READ_TIMEOUT_SECONDS,
    )


class IdentityInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    domain: StrictStr | None = Field(default=None, min_length=1, max_length=253)
    tokenId: StrictStr | None = Field(default=None, pattern=r"^[1-9][0-9]{0,77}$")
    expectedOwner: StrictStr | None = Field(
        default=None, pattern=r"^0x[a-fA-F0-9]{40}$"
    )

    @model_validator(mode="after")
    def exactly_one_subject(self) -> "IdentityInput":
        if (self.domain is None) == (self.tokenId is None):
            raise ValueError("Supply domain XOR decimal tokenId")
        if self.tokenId is not None and int(self.tokenId) >= 2**256:
            raise ValueError("tokenId exceeds uint256")
        if self.domain is not None and (
            self.domain != self.domain.strip()
            or any(char in self.domain for char in "/:@?#\\")
        ):
            raise ValueError("A domain is not a URL")
        return self


class PrepareInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    tokenId: StrictStr = Field(pattern=r"^[1-9][0-9]{0,77}$")
    expectedOwner: StrictStr = Field(pattern=r"^0x[a-fA-F0-9]{40}$")
    enabled: StrictBool
    builderCode: StrictStr = Field(pattern=r"^[a-z0-9_]{1,32}$")

    @model_validator(mode="after")
    def valid_token(self) -> "PrepareInput":
        if int(self.tokenId) >= 2**256:
            raise ValueError("tokenId exceeds uint256")
        return self


def error_result(name: str, code: str) -> ToolResult:
    return ToolResult(
        name=name,
        is_error=True,
        result=[TextResultContent(content=json.dumps({"error": {"code": code}}))],
    )


class AgentDomainWorkbench(McpWorkbench):
    """Real McpWorkbench with an enforced read/prepare-only tool allowlist."""

    def _to_config(self):
        # The inherited provider name points to the unfiltered McpWorkbench.
        # Refuse serialization rather than silently lose the policy on reload.
        raise TypeError(
            "Construct AgentDomainWorkbench explicitly; "
            "do not serialize it as the base MCP component"
        )

    async def start(self) -> None:
        try:
            await super().start()
        except BaseException:
            with contextlib.suppress(Exception):
                await super().stop()
            raise

    async def list_tools(self) -> list[ToolSchema]:
        return [
            tool for tool in await super().list_tools() if tool["name"] in TOOL_NAMES
        ]

    async def call_tool(
        self,
        name: str,
        arguments: Mapping[str, Any] | None = None,
        cancellation_token: CancellationToken | None = None,
        call_id: str | None = None,
    ) -> ToolResult:
        if name not in TOOL_NAMES:
            return error_result(name, "READ_ONLY_TOOL_DENIED")
        try:
            raw = dict(arguments or {})
            if (
                len(json.dumps(raw, allow_nan=False).encode("utf-8"))
                > MAX_ARGUMENT_BYTES
            ):
                return error_result(name, "INPUT_TOO_LARGE")
            schema = (
                PrepareInput if name == "prepare_auto_renew_change" else IdentityInput
            )
            parsed = schema.model_validate(raw).model_dump(exclude_none=True)
        except (ValidationError, ValueError, TypeError):
            return error_result(name, "INVALID_INPUT")
        # Annotations and model instructions are not authorization controls.
        return await super().call_tool(name, parsed, cancellation_token, call_id)


def result_json(result: ToolResult) -> dict[str, Any]:
    if result.is_error:
        raise RuntimeError(
            f"{result.name} failed; no successful observation or plan was produced"
        )
    if len(result.result) != 1 or not isinstance(result.result[0], TextResultContent):
        raise RuntimeError("Expected one JSON text tool result")
    text = result.result[0].content
    if len(text.encode("utf-8")) > MAX_RESULT_BYTES:
        raise RuntimeError("Tool result exceeded the package's output bound")
    value = json.loads(text)
    if not isinstance(value, dict):
        raise RuntimeError("Expected a JSON object from the trusted MCP package")
    return value


async def inspect_and_prepare(
    workbench: AgentDomainWorkbench,
    subject: Mapping[str, Any],
    *,
    enabled: bool | None = None,
    builder_code: str | None = None,
) -> dict[str, Any]:
    request = IdentityInput.model_validate(dict(subject)).model_dump(exclude_none=True)
    if enabled is not None and (
        type(enabled) is not bool
        or not builder_code
        or not request.get("expectedOwner")
    ):
        raise ValueError(
            "Preparation requires explicit enabled, expectedOwner and builderCode"
        )
    required = {"inspect_agent_identity", "inspect_agent_renewal"}
    if enabled is not None:
        required.add("prepare_auto_renew_change")
    available = {tool["name"] for tool in await workbench.list_tools()}
    if not required.issubset(available):
        raise RuntimeError(
            f"Required tools are missing. Install MCP {MCP_NPM_VERSION} after publication "
            "or build the reviewed public source."
        )
    identity = result_json(await workbench.call_tool("inspect_agent_identity", request))
    report: dict[str, Any] = {
        "mode": "read_only",
        "identity": identity,
        "ownerReview": None,
    }
    if identity.get("status") != "found":
        return report
    renewal_subject = {"tokenId": identity["tokenId"]}
    if "expectedOwner" in request:
        renewal_subject["expectedOwner"] = request["expectedOwner"]
    report["renewal"] = result_json(
        await workbench.call_tool("inspect_agent_renewal", renewal_subject)
    )
    if enabled is not None:
        if (
            identity.get("consistent") is not True
            or identity.get("checks", {}).get("expectedOwnerMatches") is not True
        ):
            raise RuntimeError("Identity/expected owner mismatch; no change prepared")
        proposed = {
            "tokenId": identity["tokenId"],
            "expectedOwner": request["expectedOwner"],
            "enabled": enabled,
            "builderCode": builder_code,
        }
        plan = result_json(
            await workbench.call_tool("prepare_auto_renew_change", proposed)
        )
        if (
            plan.get("kind") != "set_auto_renew"
            or plan.get("chainId") != 8453
            or plan.get("transaction", {}).get("value") != "0"
            or plan.get("tokenId") != proposed["tokenId"]
            or str(plan.get("expectedOwner", "")).lower()
            != proposed["expectedOwner"].lower()
            or type(plan.get("enabled")) is not bool
            or plan["enabled"] != enabled
            or plan.get("builderCode") != builder_code
        ):
            raise RuntimeError("Unexpected unsigned renewal-setting plan")
        report["ownerReview"] = {
            "required": True,
            "plan": plan,
            "nextStep": (
                "Review separately in a trusted owner-wallet host. "
                "This connector cannot sign or execute."
            ),
        }
    report["effects"] = {
        "signed": False,
        "broadcast": False,
        "fundsMoved": False,
        "registrarRenewalConfirmed": False,
    }
    return report
