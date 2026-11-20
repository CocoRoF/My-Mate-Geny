"""tools/affected_tests.py — the tests a change can break (AGENTS.md: what to run locally before a PR)."""

import subprocess
import sys
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent / "tools" / "affected_tests.py"


def picked(*files: str) -> list[str]:
    out = subprocess.run([sys.executable, str(TOOL), *files], capture_output=True, text=True, check=True).stdout.split()
    return out


def test_a_module_picks_its_tests_and_not_the_whole_suite():
    got = picked("app/mate/graph.py")
    assert "tests/test_mate_graph.py" in got and "tests/test_attachments.py" not in got
    assert picked("app/mate/gss/runtime.py").count("tests/test_gss_service.py") == 1  # (named after it)


def test_what_everything_rests_on_picks_everything_and_a_doc_nothing():
    assert picked("app/db.py") == ["tests"]
    assert picked("tests/conftest.py") == ["tests"]
    assert picked("../docs/apps.md") == []
    assert picked("tests/test_mate_graph.py") == ["tests/test_mate_graph.py"]
