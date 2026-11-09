"""Glob and Grep: finding files by name and by content.

ripgrep does it when it is installed (fast, respects .gitignore); otherwise a Python search over the files git knows
about (or every file outside .git / node_modules), with the same options and the same output.
"""

from __future__ import annotations

import asyncio
import fnmatch
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from app.harness.tools.base import Tool, ToolContext, ToolOutput, obj, to_thread, truncate_middle

MAX_OUTPUT = 30_000
GLOB_LIMIT = 100
_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", ".mypy_cache", ".pytest_cache", ".tox"}
_TYPES = {
    "py": ("*.py", "*.pyi"), "js": ("*.js", "*.mjs", "*.cjs", "*.jsx"), "ts": ("*.ts", "*.tsx", "*.mts", "*.cts"),
    "go": ("*.go",), "rust": ("*.rs",), "java": ("*.java",), "c": ("*.c", "*.h"), "cpp": ("*.cpp", "*.cc", "*.hpp", "*.h"),
    "md": ("*.md", "*.markdown"), "json": ("*.json",), "yaml": ("*.yaml", "*.yml"), "html": ("*.html", "*.htm"),
    "css": ("*.css", "*.scss"), "sh": ("*.sh", "*.bash"), "rb": ("*.rb",), "php": ("*.php",), "swift": ("*.swift",),
    "kotlin": ("*.kt", "*.kts"), "sql": ("*.sql",), "toml": ("*.toml",), "xml": ("*.xml",),
}


def _rg() -> str | None:
    return shutil.which("rg")


def _mtime(p: str) -> float:
    try:
        return os.stat(p).st_mtime
    except OSError:
        return 0.0


def _files(base: str) -> list[str]:
    """Every file under ``base`` that isn't ignored."""
    if os.path.isfile(base):
        return [base]
    try:
        out = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=base, capture_output=True,
                             timeout=30, check=True).stdout
        names = [n for n in out.decode("utf-8", errors="replace").split("\0") if n]
        return [os.path.join(base, n) for n in names if os.path.isfile(os.path.join(base, n))]
    except (OSError, subprocess.SubprocessError):
        pass
    found = []
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        found.extend(os.path.join(root, f) for f in files)
        if len(found) > 200_000:
            break
    return found


def _match_glob(rel: str, pattern: str) -> bool:
    rel = rel.replace(os.sep, "/")
    if "/" not in pattern and not pattern.startswith("**"):
        return fnmatch.fnmatch(os.path.basename(rel), pattern)
    return Path(rel).match(pattern) or fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(rel, pattern.removeprefix("**/"))


class Glob(Tool):
    name = "Glob"
    description = ("Find files by name pattern (\"**/*.py\", \"src/**/*.tsx\") under `path` (the working directory by "
                   "default). Returns paths, most recently changed first, at most 100.")
    schema = obj({
        "pattern": {"type": "string", "description": "The glob pattern"},
        "path": {"type": "string", "description": "Folder to search in (absolute)"},
    }, ["pattern"])
    read_only = True
    parallel = True

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        pattern = str(args.get("pattern") or "").strip()
        if not pattern:
            return ToolOutput.error("No pattern given.")
        base = ctx.path(args.get("path") or ctx.runtime.cwd or ctx.cwd)
        if not os.path.isdir(base):
            return ToolOutput.error(f"Not a folder: {base}")
        return await to_thread(self._glob, base, pattern)

    def _glob(self, base: str, pattern: str) -> ToolOutput:
        rg = _rg()
        paths: list[str]
        if rg:
            try:
                out = subprocess.run([rg, "--files", "--hidden", "--glob", "!.git", "--glob", pattern, "--no-messages"],
                                     cwd=base, capture_output=True, timeout=60).stdout
                paths = [os.path.join(base, p) for p in out.decode("utf-8", errors="replace").splitlines() if p]
            except (OSError, subprocess.SubprocessError):
                paths = []
        else:
            paths = [p for p in _files(base) if _match_glob(os.path.relpath(p, base), pattern)]
        if not paths:
            return ToolOutput("No files found")
        paths.sort(key=_mtime, reverse=True)
        more = len(paths) > GLOB_LIMIT
        text = "\n".join(paths[:GLOB_LIMIT])
        if more:
            text += f"\n(Results are truncated: {len(paths)} files match. Use a more specific path or pattern.)"
        return ToolOutput(text)


class Grep(Tool):
    name = "Grep"
    description = (
        "Search file contents with a regular expression (ripgrep syntax). `output_mode`: \"files_with_matches\" "
        "(default: the files, most recently changed first), \"content\" (matching lines; with -n line numbers, -A/-B/-C "
        "context), or \"count\". Narrow it with `glob` (\"*.ts\") or `type` (\"py\", \"js\"…), `-i` for case-insensitive, "
        "`multiline` for patterns across lines. `head_limit` keeps the first N results (after skipping `offset`). Use "
        "this instead of grep or rg in Bash."
    )
    schema = obj({
        "pattern": {"type": "string", "description": "The regular expression"},
        "path": {"type": "string", "description": "File or folder to search (absolute; the working directory by default)"},
        "glob": {"type": "string", "description": "Only files matching this glob"},
        "type": {"type": "string", "description": "Only files of this type (py, js, ts, go, rust, java, md…)"},
        "output_mode": {"type": "string", "enum": ["content", "files_with_matches", "count"]},
        "-i": {"type": "boolean", "description": "Case-insensitive"},
        "-n": {"type": "boolean", "description": "Line numbers (content mode)"},
        "-A": {"type": "number", "description": "Lines after each match (content mode)"},
        "-B": {"type": "number", "description": "Lines before each match (content mode)"},
        "-C": {"type": "number", "description": "Lines around each match (content mode)"},
        "multiline": {"type": "boolean", "description": "Let . and patterns span lines"},
        "head_limit": {"type": "number", "description": "At most this many results"},
        "offset": {"type": "number", "description": "Skip this many results first"},
    }, ["pattern"])
    read_only = True
    parallel = True

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
        pattern = str(args.get("pattern") or "")
        if not pattern:
            return ToolOutput.error("No pattern given.")
        base = ctx.path(args.get("path") or ctx.runtime.cwd or ctx.cwd)
        if not os.path.exists(base):
            return ToolOutput.error(f"Path does not exist: {base}")
        mode = args.get("output_mode") or "files_with_matches"
        rg = _rg()
        try:
            lines = await (self._rg(rg, base, pattern, mode, args) if rg else
                           to_thread(self._py, base, pattern, mode, args))
        except re.error as exc:
            return ToolOutput.error(f"Invalid regular expression: {exc}")
        if mode == "files_with_matches":
            lines.sort(key=_mtime, reverse=True)
        offset = int(args.get("offset") or 0)
        limit = args.get("head_limit")
        lines = lines[offset:]
        if limit:
            lines = lines[: int(limit)]
        if not lines:
            return ToolOutput("No matches found" if mode != "files_with_matches" else "No files found")
        text = "\n".join(lines)
        if mode == "files_with_matches":
            text = f"Found {len(lines)} file{'s' if len(lines) != 1 else ''}\n{text}"
        return ToolOutput(truncate_middle(text, MAX_OUTPUT))

    async def _rg(self, rg: str, base: str, pattern: str, mode: str, args: dict[str, Any]) -> list[str]:
        argv = [rg, "--no-config", "--color=never", "--hidden", "--glob", "!.git", "--max-columns=500",
                "--max-columns-preview", "--no-messages"]
        if args.get("-i"):
            argv.append("-i")
        if args.get("multiline"):
            argv += ["-U", "--multiline-dotall"]
        if args.get("glob"):
            argv += ["--glob", str(args["glob"])]
        if args.get("type"):
            argv += ["--type", str(args["type"])]
        if mode == "files_with_matches":
            argv.append("-l")
        elif mode == "count":
            argv.append("-c")
        else:
            if args.get("-n", True):
                argv.append("-n")
            for flag in ("-A", "-B", "-C"):
                if args.get(flag):
                    argv += [flag, str(int(args[flag]))]
        argv += ["-e", pattern, "--", base]
        proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(proc.communicate(), 120)
        if proc.returncode == 2 and err and b"regex" in err.lower():
            raise re.error(err.decode(errors="replace").strip()[:300])
        return [ln for ln in out.decode("utf-8", errors="replace").splitlines() if ln]

    def _py(self, base: str, pattern: str, mode: str, args: dict[str, Any]) -> list[str]:
        flags = re.IGNORECASE if args.get("-i") else 0
        if args.get("multiline"):
            flags |= re.DOTALL | re.MULTILINE
        rx = re.compile(pattern, flags)
        files = _files(base)
        glob = args.get("glob")
        types = _TYPES.get(str(args.get("type") or ""), ())
        after = int(args.get("-A") or args.get("-C") or 0)
        before = int(args.get("-B") or args.get("-C") or 0)
        numbers = args.get("-n", True)
        out: list[str] = []
        single = os.path.isfile(base)
        for f in files:
            name = os.path.basename(f)
            if glob and not _match_glob(os.path.relpath(f, base) if not single else name, str(glob)):
                continue
            if types and not any(fnmatch.fnmatch(name, t) for t in types):
                continue
            try:
                with open(f, "rb") as fh:
                    raw = fh.read(5_000_000)
            except OSError:
                continue
            if b"\x00" in raw[:8192]:
                continue
            text = raw.decode("utf-8", errors="replace")
            if args.get("multiline"):
                hits = list(rx.finditer(text))
                if not hits:
                    continue
                if mode == "files_with_matches":
                    out.append(f)
                elif mode == "count":
                    out.append(f"{f}:{len(hits)}")
                else:
                    for h in hits:
                        line = text.count("\n", 0, h.start()) + 1
                        out.append(f"{f}:{line}:{h.group(0)[:500]}" if numbers else f"{f}:{h.group(0)[:500]}")
                continue
            lines = text.splitlines()
            matched = [i for i, line in enumerate(lines) if rx.search(line)]
            if not matched:
                continue
            if mode == "files_with_matches":
                out.append(f)
            elif mode == "count":
                out.append(f"{f}:{len(matched)}")
            else:
                shown: set[int] = set()
                for i in matched:
                    for j in range(max(0, i - before), min(len(lines), i + after + 1)):
                        if j in shown:
                            continue
                        shown.add(j)
                        sep = ":" if j == i or j in matched else "-"
                        body = lines[j][:500]
                        out.append(f"{f}{sep}{j + 1}{sep}{body}" if numbers else f"{f}{sep}{body}")
        return out
