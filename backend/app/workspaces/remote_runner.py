"""Stdlib-only remote job supervisor, shipped over SSH. Its RPC does not own command lifetime."""
from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import time
from contextlib import contextmanager

TERMINAL = {'completed', 'failed', 'stopped', 'timed_out', 'lost'}


def save(path, value):
    temp = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    with open(temp, 'w', encoding='utf-8') as stream:
        os.chmod(temp, 0o600)
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def read(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


@contextmanager
def locked(job):
    with open(job / 'lock', 'a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def birth(pid):
    try:
        # Linux: kernel start tick, independent of PID reuse. Other Unix hosts use ps start time.
        stat = Path('/proc') / str(pid) / 'stat'
        if stat.exists():
            fields = stat.read_text().rsplit(')', 1)[1].split()
            return None if fields[0] == 'Z' else fields[19]
        return subprocess.check_output(['ps', '-o', 'lstart=', '-p', str(pid)], text=True).strip()
    except (OSError, subprocess.SubprocessError):
        return None


def alive(pid, identity=None):
    if not isinstance(pid, int) or pid < 2:
        return False
    try:
        os.kill(pid, 0)
        return not identity or birth(pid) == identity
    except ProcessLookupError:
        return False


def signal_group(state, sig):
    pid = state.get('pid')
    # Refuse a reused leader PID. A dead leader can leave children in its original group.
    if pid and birth(pid) not in (None, state.get('birth')):
        return False
    if not isinstance(pid, int) or pid < 2:
        return False
    try:
        os.killpg(pid, sig)
        return True
    except ProcessLookupError:
        return False


def group_alive(state):
    pid = state.get('pid')
    if not isinstance(pid, int) or pid < 2 or birth(pid) not in (None, state.get('birth')):
        return False
    try:
        os.killpg(pid, 0)
    except ProcessLookupError:
        return False
    if alive(pid,state.get('birth')):
        return True
    if Path('/proc').is_dir():
        # Ignore dead, unreaped grandchildren in containers whose PID 1 does not reap promptly.
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                fields = (entry/'stat').read_text().rsplit(')', 1)[1].split()
                if int(fields[2]) == pid and fields[0] != 'Z':
                    return True
            except (OSError, ValueError, IndexError):
                continue
        return False
    return True


def terminate(state):
    signal_group(state, signal.SIGTERM)
    until = time.monotonic() + 2
    while time.monotonic() < until:
        if not group_alive(state):
            return
        time.sleep(.05)
    signal_group(state, signal.SIGKILL)


def valid_cwd(request):
    cwd = os.path.realpath(os.path.expanduser(request['cwd']))
    roots = [os.path.realpath(os.path.expanduser(r)) for r in request['roots']]
    if not any(os.path.commonpath([cwd, r]) == r for r in roots):
        raise ValueError('refused: command directory is outside the attached folders')
    if not os.path.isdir(cwd):
        raise ValueError('remote_bash: command directory does not exist')
    return cwd


def worker(job):
    state = read(job / 'state.json')
    with locked(job):
        if (job / 'claimed').exists() or (job / 'cancel').exists():
            return
        (job / 'claimed').touch(mode=0o600)
        request = read(job / 'request.json')
        state.update(status='running', worker=os.getpid(), worker_birth=birth(os.getpid()))
        save(job / 'state.json', state)
    proc = None
    try:
        cwd = valid_cwd(request)
        shell = os.environ.get('SHELL') or '/bin/sh'
        with open(job / 'output.bin', 'ab', buffering=0) as output:
            proc = subprocess.Popen([shell, '-c', request['command']], cwd=cwd,
                                    stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                    start_new_session=True, close_fds=True)
            state.update(pid=proc.pid, birth=birth(proc.pid))
            save(job / 'state.json', state)
            deadline = time.monotonic() + request['timeout_ms']/1000 if request.get('timeout_ms') else None
            while proc.poll() is None or group_alive(state):
                cancelled = (job / 'cancel').exists()
                timed_out = deadline is not None and time.monotonic() >= deadline
                if cancelled or timed_out:
                    terminate(state)
                    proc.wait()
                    state.update(status='stopped' if cancelled else 'timed_out', exit_code=130 if cancelled else 124)
                    if not cancelled:
                        state['error'] = 'Stopped: it reached its time limit of %g minutes.' % (request['timeout_ms']/60000)
                    break
                time.sleep(.05)
            else:
                state.update(status='completed' if proc.returncode == 0 else 'failed', exit_code=proc.returncode)
    except BaseException as exc:
        if proc and proc.poll() is None:
            terminate(state)
            proc.wait()
        state.update(status='failed', exit_code=1, error=str(exc)[:300])
    finally:
        state['ended_at'] = time.time()
        save(job / 'state.json', state)
        # No second copy of the shell command after execution.
        (job / 'request.json').unlink(missing_ok=True)


def poll(job, request):
    wait_ms = max(0, min(int(request.get('wait_ms') or 0), 30000))
    until = time.monotonic() + wait_ms/1000
    while True:
        state = read(job / 'state.json')
        if state.get('status') in TERMINAL or time.monotonic() >= until:
            break
        if state.get('status') == 'running' and not alive(state.get('worker'), state.get('worker_birth')):
            if not group_alive(state):
                state.update(status='lost', ended_at=time.time(), error='Remote supervisor exited; command is not restarted automatically.')
                save(job / 'state.json', state)
                break
        time.sleep(.05)
    if not state:
        return {'status': 'not_found'}
    offset = int(request.get('offset') or 0)
    limit = max(1, min(int(request.get('max_bytes') or 65536), 1048576))
    output_path = job / 'output.bin'
    size = output_path.stat().st_size if output_path.exists() else 0
    if not 0 <= offset <= size:
        raise ValueError('output offset is outside the saved output')
    data = b''
    if size:
        with open(output_path, 'rb') as stream:
            stream.seek(offset)
            data = stream.read(limit)
    return {**state, 'data': base64.b64encode(data).decode(), 'offset': offset,
            'next_offset': offset+len(data), 'total_bytes': size, 'has_more': offset+len(data)<size, 'process_group_alive': group_alive(state)}


def rpc(request):
    if not re.fullmatch(r'[a-f0-9]{32}', request.get('job_id', '')):
        raise ValueError('invalid remote job id')
    root = Path(os.path.expanduser(request['root']))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    job = root / request['job_id']
    job.mkdir(exist_ok=True, mode=0o700)
    action = request['action']
    if action == 'start':
        with locked(job):
            state = read(job / 'state.json')
            if not state:
                cwd = valid_cwd(request)
                source = request.pop('runner_source')
                runner = root / ('runner-' + hashlib.sha256(source.encode()).hexdigest()[:16] + '.py')
                if not runner.exists():
                    save_source = runner.with_suffix('.tmp.' + str(os.getpid()))
                    save_source.write_text(source)
                    os.chmod(save_source, 0o600)
                    os.replace(save_source, runner)
                state = {'status': 'queued', 'started_at': time.time(), 'job_id': request['job_id'], 'cwd': cwd, 'runner': str(runner)}
                save(job / 'request.json', request)
                save(job / 'state.json', state)
            else:
                runner = Path(state['runner']) if state.get('status') == 'queued' and state.get('runner') else None
            # Retries can only create another supervisor before an execution claim exists.
            # The claim itself is locked and exclusive, so a command never runs twice.
            if runner and not (job / 'cancel').exists() and not (job / 'claimed').exists():
                subprocess.Popen([sys.executable, str(runner), 'worker', str(job)], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    elif action == 'stop':
        with locked(job):
            (job / 'cancel').touch(mode=0o600)
            state = read(job / 'state.json')
            if not state:
                state = {'status': 'stopped', 'exit_code': 130, 'ended_at': time.time(), 'job_id': request['job_id']}
                save(job / 'state.json', state)
        if state.get('status') not in TERMINAL:
            if not alive(state.get('worker'), state.get('worker_birth')):
                terminate(state)
                state.update(status='stopped', exit_code=130, ended_at=time.time())
                save(job / 'state.json', state)
            request['wait_ms'] = 3000
    elif action == 'purge':
        state = read(job/'state.json')
        if state and (state.get('status') not in TERMINAL or group_alive(state)):
            raise ValueError('cannot purge a running remote job')
        shutil.rmtree(job)
        return {'status':'purged','job_id':request['job_id']}
    elif action != 'poll':
        raise ValueError('unknown remote job action')
    return poll(job, request)


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[1] == 'worker':
        worker(Path(sys.argv[2]))
    else:
        try:
            print(json.dumps(rpc(json.load(sys.stdin))))
        except Exception as exc:
            print(json.dumps({'error': str(exc)[:300], 'error_type':type(exc).__name__}))
            sys.exit(1)
