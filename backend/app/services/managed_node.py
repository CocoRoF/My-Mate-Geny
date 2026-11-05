"""An explicit, app-owned Node.js/npm installation. No system package manager or global PATH edits."""
from __future__ import annotations
import asyncio, hashlib, json, os, platform, re, shutil, tarfile, tempfile, zipfile
from pathlib import Path
import httpx
from app.config import settings

BASE='https://nodejs.org/dist'

def root() -> Path:
    return settings.home_dir/'runtimes'/'node'

def bin_dir() -> Path:
    return root() if os.name=='nt' else root()/'bin'

def environment(env: dict | None=None) -> dict:
    result=dict(os.environ if env is None else env)
    if bin_dir().is_dir():result['PATH']=str(bin_dir())+os.pathsep+result.get('PATH','')
    return result

def which(name: str) -> str | None:
    candidate=bin_dir()/(name+('.cmd' if os.name=='nt' and name=='npm' else '.exe' if os.name=='nt' else ''))
    return str(candidate) if candidate.is_file() and os.access(candidate,os.X_OK) else shutil.which(name)

def status() -> dict:
    node,npm=which('node'),which('npm')
    version=None
    try:version=json.loads((root()/'geny-managed-node.json').read_text()).get('version')
    except (OSError,ValueError):pass
    return {'installed':bool(node and npm),'node':node,'npm':npm,'git':shutil.which('git'),'managed':str(bin_dir()) if bin_dir().is_dir() else None,'version':version}

def archive_name(version: str, system: str, machine: str) -> str:
    arch={'amd64':'x64','x86_64':'x64','aarch64':'arm64','arm64':'arm64'}.get(machine.lower())
    target={'Windows':'win','Linux':'linux','Darwin':'darwin'}.get(system)
    if not arch or not target:raise RuntimeError('Node.js binary installation is not supported on this OS/architecture')
    return f'node-{version}-{target}-{arch}'+('.zip' if target=='win' else '.tar.gz')

def unpack(archive: Path, destination: Path, dirname: str) -> Path:
    if archive.suffix=='.zip':
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                rel=Path(info.filename)
                if rel.is_absolute() or '..' in rel.parts or rel.parts[0]!=dirname or '\\' in info.filename:raise ValueError('Unsafe Node.js archive member')
                if (info.external_attr>>16)&0o170000==0o120000:raise ValueError('Unexpected link in Windows archive')
            z.extractall(destination)
    else:
        with tarfile.open(archive,'r:gz') as t:
            if any(not m.name.split('/') or m.name.split('/')[0]!=dirname for m in t.getmembers()):raise ValueError('Unexpected Node.js archive root')
            t.extractall(destination,filter='data')
    return destination/dirname

async def install(job: dict) -> None:
    parent=root().parent;parent.mkdir(parents=True,exist_ok=True)
    async with httpx.AsyncClient(follow_redirects=True,timeout=60) as client:
        response=await client.get(BASE+'/index.json');response.raise_for_status()
        version=next((x['version'] for x in response.json() if x.get('lts') and re.fullmatch(r'v24\.\d+\.\d+',str(x.get('version','')))),None)
        if not version:raise RuntimeError('No supported Node.js 24 LTS build was found')
        name=archive_name(version,platform.system(),platform.machine())
        sums=await client.get(f'{BASE}/{version}/SHASUMS256.txt');sums.raise_for_status()
        expected=next((line.split()[0] for line in sums.text.splitlines() if len(line.split())==2 and line.split()[1].lstrip('*')==name),None)
        if not expected:raise RuntimeError('Official Node.js checksum is missing')
        with tempfile.TemporaryDirectory(prefix='.node-install-',dir=parent) as directory:
            work=Path(directory);archive=work/name;digest=hashlib.sha256();done=0
            job.update(step='nodeDownload',transferred=0,total=0)
            async with client.stream('GET',f'{BASE}/{version}/{name}') as response:
                response.raise_for_status();job['total']=int(response.headers.get('content-length') or 0)
                with archive.open('wb') as out:
                    async for chunk in response.aiter_bytes(1024*1024):
                        done+=len(chunk)
                        if done>200*1024*1024:raise RuntimeError('Node.js archive exceeds the size limit')
                        out.write(chunk);digest.update(chunk);job['transferred']=done
            if digest.hexdigest()!=expected:raise RuntimeError('Node.js checksum mismatch')
            job['step']='nodeExtract';dirname=name.removesuffix('.zip').removesuffix('.tar.gz')
            task=asyncio.create_task(asyncio.to_thread(unpack,archive,work,dirname))
            try:stage=await asyncio.shield(task)
            except asyncio.CancelledError:await task;raise
            binary=stage/('node.exe' if os.name=='nt' else 'bin/node')
            proc=await asyncio.create_subprocess_exec(str(binary),'--version',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
            try:out,_=await asyncio.wait_for(proc.communicate(),15)
            finally:
                if proc.returncode is None:proc.kill();await proc.wait()
            if proc.returncode or out.decode().strip()!=version:raise RuntimeError('Downloaded Node.js failed verification')
            if not (stage/('node_modules/npm/bin/npm-cli.js' if os.name=='nt' else 'lib/node_modules/npm/bin/npm-cli.js')).is_file():raise RuntimeError('npm is missing from the Node.js distribution')
            (stage/'geny-managed-node.json').write_text(json.dumps({'version':version,'sha256':expected,'source':'https://nodejs.org'}))
            if root().exists():
                if not (root()/'geny-managed-node.json').is_file():raise RuntimeError('Refusing to replace an unowned runtime directory')
                shutil.rmtree(root())
            stage.rename(root());job['log'].append(f'Node.js {version} / npm installed in {root()}')
    if not status()['installed']:raise RuntimeError('Node.js/npm could not be detected after installation')
