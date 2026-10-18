"""Typed, read-only AgentDomain tools backed by CrewAI's native MCP client."""

from importlib.metadata import version

from .connector import (
    READ_ONLY_TOOLS,
    AutoRenewArguments,
    IdentityArguments,
    WorkflowError,
    call_json,
    child_environment,
    constrain_tools,
    inspect_and_prepare,
    main,
    native_tools,
    readonly_tools,
    require_owned_identity,
    server_parameters,
)

__version__ = version("agentdomain-crewai")

__all__ = [
    "READ_ONLY_TOOLS",
    "AutoRenewArguments",
    "IdentityArguments",
    "WorkflowError",
    "call_json",
    "child_environment",
    "constrain_tools",
    "inspect_and_prepare",
    "main",
    "native_tools",
    "readonly_tools",
    "require_owned_identity",
    "server_parameters",
]
