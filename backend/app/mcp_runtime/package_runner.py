"""Run an isolated installed console entry with the CURRENT bundled interpreter.

No persisted interpreter paths: AppImage extraction paths and app versions change.
"""

import importlib.metadata
import sys
from pathlib import Path

site, package, entry = sys.argv[1:4]
root = Path(site).resolve(strict=True)
sys.path.insert(0, str(root))
sys.argv = [entry, *sys.argv[4:]]
normalize = lambda s: s.lower().replace("_", "-").replace(".", "-")
for dist in importlib.metadata.distributions(path=[str(root)]):
    if normalize(dist.metadata["Name"]) == normalize(package):
        command = next(
            (e for e in dist.entry_points if e.group == "console_scripts" and e.name == entry), None
        )
        if command is not None:
            command.load()()
            break
else:
    raise SystemExit("Installed MCP entry point is missing. Download it again from the catalog.")
