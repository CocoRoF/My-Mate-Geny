"""Report the failing prerequisite before entering the MCP transport."""

import os
import re
import shutil
from pathlib import Path

from app.services import managed_node


class ConnectionIssue(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def launch_environment(spec):
    from mcp.client.stdio import get_default_environment

    return {**managed_node.environment(get_default_environment()), **spec["env"]}


def preflight(spec):
    if spec["transport"] != "stdio":
        return
    cwd = spec["cwd"]
    if cwd and not Path(cwd).is_dir():
        raise ConnectionIssue(
            "working_directory_missing", "The working directory does not exist in this MCP runtime."
        )
    if cwd and not os.access(cwd, os.R_OK | os.X_OK):
        raise ConnectionIssue(
            "working_directory_denied", "The MCP runtime cannot access the working directory."
        )
    command = spec["command"]
    resolved = shutil.which(command, path=launch_environment(spec).get("PATH"))
    if not resolved:
        if Path(command).is_file():
            raise ConnectionIssue(
                "executable_denied", "The configured file is not executable by this MCP runtime."
            )
        code = (
            "docker_missing"
            if Path(command).name.lower() in ("docker", "docker.exe")
            else "executable_missing"
        )
        raise ConnectionIssue(
            code, "The configured executable is not installed or is not on this MCP runtime's PATH."
        )
    if Path(resolved).name.lower() in ("docker", "docker.exe"):
        names = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}$")
        for i, arg in enumerate(spec["args"]):
            if (
                i
                and spec["args"][i - 1] in ("-e", "--env")
                and not names.fullmatch(arg.split("=", 1)[0])
            ):
                raise ConnectionIssue(
                    "invalid_docker_environment",
                    "A Docker environment argument has no valid variable name. Use the catalog's named credential fields.",
                )
