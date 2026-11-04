"""Check the runtime inside the actual Electron output, including paths containing spaces."""
from pathlib import Path
import subprocess

manifests=list(Path('dist').glob('**/local-runtime/manifest.json'))
if len(manifests)!=1:
    raise SystemExit(f'Expected exactly one packaged runtime, found {manifests}')
subprocess.run(['node','test/local-runtime-smoke.js',str(manifests[0].parent.resolve())],check=True)
print('PACKAGED_LOCAL_RUNTIME_OK',flush=True)
