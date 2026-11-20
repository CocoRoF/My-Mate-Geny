"""The backend tests a change can break — what to run locally before a PR (CI runs the whole suite on the PR).

    cd backend && python tools/affected_tests.py            # changes since origin/main, committed or not
    cd backend && python -m pytest -q -p no:cacheprovider $(python tools/affected_tests.py)

A test is picked when it is a changed test, when it imports a changed module of ``app`` (directly, or through one module
of ``app`` that does — not through a hub most tests import anyway: ``app.main``, the session service …), or when its name
names a changed module (``app/mate/graph.py`` → ``tests/test_mate_graph.py``).
What everything rests on (``tests/conftest.py``, ``pyproject.toml``, ``app/db.py``, ``app/config.py``, ``app/main.py``)
picks every test: then it prints ``tests``. Nothing in the backend changed: it prints nothing (and exits 0).
``--why`` says, on stderr, what picked each test.
"""

from __future__ import annotations

import argparse
import ast
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
HUB = 0.08  # imported by more than this share of the tests
EVERYTHING = {"tests/conftest.py", "pyproject.toml", "app/db.py", "app/config.py", "app/main.py", "app/__init__.py"}


def changed_files(base: str) -> set[str]:
    """Backend files changed since ``base`` (committed on this branch, staged, unstaged or new), relative to backend/."""
    def git(*args: str) -> list[str]:
        out = subprocess.run(["git", *args], cwd=BACKEND, capture_output=True, text=True)
        if out.returncode != 0:
            raise SystemExit(out.stderr.strip() or f"git {' '.join(args)} failed")
        return [line for line in out.stdout.splitlines() if line]

    top = Path(git("rev-parse", "--show-toplevel")[0])
    names = set(git("diff", "--name-only", f"{base}...HEAD")) | set(git("diff", "--name-only", "HEAD"))
    names |= {str((BACKEND / p).resolve().relative_to(top)) for p in git("ls-files", "--others", "--exclude-standard")}
    prefix = str(BACKEND.relative_to(top)) + "/"
    return {n[len(prefix):] for n in names if n.startswith(prefix)}


def module_of(path: str) -> str | None:
    """app/mate/graph.py → app.mate.graph (a package's __init__ → the package)."""
    if not path.endswith(".py") or not path.startswith("app/"):
        return None
    parts = path[:-3].split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


# words of a module's path that name no subject of its own
PLAIN = {"app", "mate", "services", "service", "routers", "providers", "harness", "base", "core", "utils", "util", "ids",
         "init", "main", "api", "store", "models", "model", "types", "tools", "common", "helpers", "runtime"}


def name_words(module: str) -> set[str]:
    """app.mate.gss.runtime → {"gss", "runtime"}: what a test named after it would say."""
    return {w for part in module.split(".") for w in part.strip("_").split("_") if len(w) >= 3 and w not in PLAIN}


def imports_of(path: Path, known: set[str]) -> set[str]:
    """The modules of ``app`` a file imports (``from app.x import y`` is app.x.y when that is a module, else app.x)."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
    except (SyntaxError, UnicodeDecodeError):
        return set()
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name.startswith("app"):
                    out.add(a.name)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0 and node.module.startswith("app"):
            for a in node.names:
                sub = f"{node.module}.{a.name}"
                out.add(sub if sub in known else node.module)
    return {m for m in out if m in known}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="origin/main", help="what the branch is compared with (default origin/main)")
    ap.add_argument("--why", action="store_true", help="say on stderr what picked each test")
    ap.add_argument("files", nargs="*", help="changed files relative to backend/ (default: from git)")
    args = ap.parse_args()
    changed = set(args.files) if args.files else changed_files(args.base)
    if not changed:
        return 0
    if changed & EVERYTHING:
        if args.why:
            print(f"everything: {', '.join(sorted(changed & EVERYTHING))} changed", file=sys.stderr)
        print("tests")
        return 0

    sources = {module_of(str(p.relative_to(BACKEND))): p for p in (BACKEND / "app").rglob("*.py")}
    sources.pop(None, None)
    known = set(sources)
    imported_by: dict[str, set[str]] = defaultdict(set)  # module → the app modules importing it
    for mod, path in sources.items():
        for dep in imports_of(path, known):
            imported_by[dep].add(mod)
    tests = sorted(p for p in (BACKEND / "tests").glob("test_*.py"))

    hit: dict[str, str] = {}
    mods = {m for m in (module_of(f) for f in changed) if m}
    test_deps = {t: imports_of(t, known) for t in tests}
    # a hub: imported by many tests (app.main, the session service, the mate store …) — everything goes through it, so
    # through it everything would be picked
    uses: dict[str, int] = defaultdict(int)
    for deps in test_deps.values():
        for d in deps:
            uses[d] += 1
    hub = {m for m, n in uses.items() if n > HUB * len(tests)}
    # one module of app in between: a change to a helper reaches the tests of what uses it
    near = {m: m for m in mods}
    for m in mods:
        for user in imported_by.get(m, ()):
            if user not in hub:
                near.setdefault(user, m)
    for t in tests:
        rel = f"tests/{t.name}"
        if rel in changed:
            hit[rel] = "changed"
            continue
        deps = test_deps[t]
        why = next((f"imports {d}" + (f" (uses {near[d]})" if near[d] != d else "") for d in sorted(deps) if d in near), None)
        if why is None:  # (named after it: test_gss_service.py for app/mate/gss/runtime.py, test_mate_graph.py for graph)
            words = set(t.stem[len("test_"):].split("_"))
            why = next((f"named after {m}" for m in sorted(mods) if words & name_words(m)), None)
        if why:
            hit[rel] = why
    for f in sorted(changed):  # (a test helper module, e.g. tests/_fakes.py: the tests that import it)
        if f.startswith("tests/") and not Path(f).name.startswith("test_") and f.endswith(".py"):
            name = Path(f).stem
            for t in tests:
                if f"tests.{name}" in t.read_text(encoding="utf-8", errors="ignore"):
                    hit.setdefault(f"tests/{t.name}", f"uses tests/{name}")
    if args.why:
        for rel, why in sorted(hit.items()):
            print(f"{rel}: {why}", file=sys.stderr)
    if len(hit) > 0.6 * len(tests):  # (most of it anyway: the whole is simpler and as quick)
        print("tests")
    elif hit:
        print(" ".join(sorted(hit)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
