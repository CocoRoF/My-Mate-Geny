"""Local durable handles for SSH jobs. Only short control requests depend on an SSH connection."""
from __future__ import annotations

import base64
import codecs
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
import uuid

SOURCE = Path(__file__).with_name('remote_runner.py').read_text()
TERMINAL = {'completed', 'failed', 'stopped', 'timed_out', 'lost'}


class RemoteTransportError(RuntimeError):
    pass


#: how long a command may run when the agent names no limit. Nobody waits for a command left in the background, so a wait
#: loop that can't finish any more (the file it watches was deleted, say) would otherwise run for ever. The foreground limit
#: only catches what the agent walked away from: long work it really waits for fits well inside it.
BACKGROUND_TIMEOUT_MS = 2 * 3600 * 1000
FOREGROUND_TIMEOUT_MS = 24 * 3600 * 1000


def atomic(path, data):
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with open(temp, 'w') as stream:
        os.chmod(temp, 0o600)
        json.dump(data, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def ssh_prefix(host):
    argv = ['ssh', '-T', '-p', str(host.get('port') or 22), '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
            '-o', 'StrictHostKeyChecking=accept-new']
    if host.get('known_hosts'):
        argv += ['-o', 'UserKnownHostsFile=' + host['known_hosts']]
    if host.get('key_file'):
        argv += ['-i', host['key_file']]
    if host.get('control_path') and len(os.fsencode(host['control_path'])) <= 90:
        control=Path(host['control_path']);control.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        argv += ['-o','ControlMaster=auto','-o','ControlPersist=60','-o','ControlPath='+str(control)]
    argv.append(host.get('user', '') + '@' + host['host'])
    return argv


def fingerprint(host):
    return tuple(str(host.get(k) or '') for k in ('host', 'port', 'user', 'key_file'))


class RemoteJobs:
    def __init__(self, directory, sid, prefix=ssh_prefix):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', sid):
            raise ValueError('invalid remote job session')
        self.directory = Path(directory)
        self.root = self.directory / sid
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        self.sid, self.prefix = sid, prefix

    def path(self, job_id):
        if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9]{32}', job_id):
            raise ValueError('invalid remote job id')
        return self.root / job_id

    def manifest(self, job_id):
        path = self.path(job_id) / 'manifest.json'
        try:
            value = json.loads(path.read_text())
        except (OSError, ValueError) as exc:
            raise ValueError('unknown job in this conversation') from exc
        if value.get('sid') != self.sid or value.get('job_id') != job_id:
            raise ValueError('job belongs to another conversation')
        return value

    def control(self, manifest, request):
        request = {**request, 'job_id': manifest['job_id'], 'root': manifest['remote_root']}
        host = manifest['host']
        try:
            result = subprocess.run([*self.prefix(host), 'python3 -c ' + shlex.quote(SOURCE)],
                                    input=json.dumps(request).encode(), capture_output=True,
                                    timeout=max(20, int(request.get('wait_ms', 0))/1000+15))
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RemoteTransportError('SSH control connection unavailable; retain the job ID and poll it, do not rerun the command.') from exc
        if b"No module named 'fcntl'" in result.stderr:
            raise ValueError('Managed remote commands require a POSIX SSH host with Python 3.8+; no command was executed.')
        if result.returncode == 127 and b'python3' in result.stderr:
            raise ValueError('Remote command management requires python3 on this SSH host; no command was executed.')
        try:
            # Noninteractive login banners must not corrupt the one JSON control response.
            value = json.loads(result.stdout.splitlines()[-1])
            if not isinstance(value, dict): raise ValueError('invalid control response')
        except (ValueError, UnicodeError, IndexError) as exc:
            raise RemoteTransportError('Remote job control unavailable (requires python3 on the SSH host); command status is unknown. Poll this job rather than resubmitting.') from exc
        # (error_type: this control request failed. A job's own state can carry an error too, as a finished job: that is an
        # answer, and taking it for a failed request would leave the job "running" for ever.)
        if value.get('error_type'):
            error = RemoteTransportError if value.get('error_type') in ('OSError','PermissionError','FileNotFoundError') else ValueError
            raise error(value['error'])
        if not isinstance(value.get('status'), str):
            raise RemoteTransportError('Remote control response is incomplete; retain the existing job ID.')
        return value

    def prepare(self, host, command, cwd, *, description='', timeout_ms=0, background=False):
        if not isinstance(command, str) or not command.strip():
            raise ValueError('command must be a nonempty string')
        if not isinstance(description, str) or not isinstance(background, bool):
            raise ValueError('description must be text and run_in_background must be boolean')
        if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, (int,float)) or not 0 <= timeout_ms < 1e12:
            raise ValueError('timeout_ms must be a positive number, or zero for the default limit')
        job_id = uuid.uuid4().hex
        path = self.path(job_id)
        path.mkdir(mode=0o700)
        manifest = {'sid': self.sid, 'job_id': job_id, 'host': host, 'started_at': time.time(),
                    'description': (description or 'Remote command · ' + host['name'])[:200],
                    'background': bool(background), 'remote_root': host.get('job_root') or '~/.cache/my-mate-geny/remote-jobs/' + self.sid}
        request = {'action':'start', 'cwd':cwd, 'roots':host['roots'], 'command':command,
                   'timeout_ms':timeout_ms or (BACKGROUND_TIMEOUT_MS if background else FOREGROUND_TIMEOUT_MS),
                   'runner_source':SOURCE}
        atomic(path/'launch.json', request)
        # Published last: the backend sees either a complete launch or nothing.
        atomic(path/'manifest.json', manifest)
        inbox = self.directory/'inbox'
        inbox.mkdir(exist_ok=True,mode=0o700)
        atomic(inbox/(self.sid+'_'+job_id+'.json'), {'sid':self.sid,'job_id':job_id})
        return manifest

    def start(self, manifest, *, wait_ms=1000, max_bytes=65536):
        path = self.path(manifest['job_id'])
        try:
            launch = json.loads((path/'launch.json').read_text())
        except FileNotFoundError:
            return self.poll(manifest, wait_ms=wait_ms, max_bytes=max_bytes)
        if (path/'cancel').exists():
            return self.stop(manifest)
        try:
            result = self.control(manifest, {**launch, 'wait_ms':wait_ms, 'max_bytes':max_bytes})
        except ValueError as exc:
            atomic(path/'state.json', {'status':'failed','exit_code':1,'error':str(exc),'ended_at':time.time(),'received_ended_at':time.time(),'started_at':manifest['started_at']})
            (path/'launch.json').unlink(missing_ok=True)
            raise
        if result.get('status') != 'not_found':
            (path/'launch.json').unlink(missing_ok=True)
        return result

    def poll(self, manifest, *, offset=0, wait_ms=0, max_bytes=65536):
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise ValueError('offset must be a nonnegative byte offset')
        return self.control(manifest, {'action':'poll', 'offset':offset, 'wait_ms':wait_ms, 'max_bytes':max_bytes})

    def stop(self, manifest):
        path = self.path(manifest['job_id'])
        (path/'cancel').touch(mode=0o600)
        return self.control(manifest, {'action':'stop'})

    def purge(self, manifest):
        return self.control(manifest, {'action':'purge'})

    @staticmethod
    def display(result):
        data = base64.b64decode(result.get('data') or '')
        decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        output = decoder.decode(data, final=result.get('status') in TERMINAL and not result.get('has_more'))
        pending = decoder.getstate()[0]
        return {**{k:result[k] for k in ('job_id','status','exit_code','error','cwd','total_bytes','has_more') if k in result},
                'output':output, 'offset':result.get('offset',0), 'next_offset':result.get('next_offset',0)-len(pending)}
