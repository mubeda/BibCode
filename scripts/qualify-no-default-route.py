#!/usr/bin/env python3
"""Disposable packaged check in unprivileged user/network/PID namespaces."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')


def failure_summary(path):
    if not path.is_file():
        return {'available': False, 'errors': []}
    with path.open('rb') as source:
        source.seek(max(0, path.stat().st_size - 128 * 1024))
        raw = source.read(128 * 1024).decode('utf8', errors='replace')
    errors = []
    for line in raw.splitlines():
        if not re.search(r'\b(?:Error|ERROR|error|failed|Failed|ENOENT|EACCES)\b', line):
            continue
        if re.search(r'\b(?:DATA|COMMAND|Authorization|Cookie|Set-Cookie)\b', line, re.I):
            continue
        line = re.sub(r'(?i)(?:bearer\s+|(?:access_?token|refresh_?token|credential|password|wsTicket|pairing_?code)[\s"\x27:=]+)[^\s,"\x27}]+', '[redacted]', line)
        line = re.sub(r'https?://[^\s"\x27]+', '[url]', line)
        line = re.sub(r'[A-Za-z0-9_+/=-]{24,}', '[long-value]', line)
        errors.append(line[:400])
        if len(errors) == 12:
            break
    return {'available': True, 'errors': errors}


class StopRequested(BaseException):
    def __init__(self, number):
        self.number = number


def run_owned_command(command, timeout=630, grace=10):
    """Forward cancellation to, and reap, this newly created process group."""
    process = None
    output = b''
    status = 1
    timed_out = False
    cancelled = None
    previous = {}
    admitting = True
    pending_signal = None

    def stop(number, _frame):
        nonlocal pending_signal
        # Do not raise between the child being created and its handle becoming
        # owned below. Child signal masks stay unchanged.
        if admitting:
            pending_signal = number
            return
        raise StopRequested(number)

    for number in [signal.SIGTERM, signal.SIGINT]:
        previous[number] = signal.signal(number, stop)
    try:
        if pending_signal is not None:
            raise StopRequested(pending_signal)
        process = subprocess.Popen(command, start_new_session=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        admitting = False
        if pending_signal is not None:
            raise StopRequested(pending_signal)
        output, _ = process.communicate(timeout=timeout)
        status = process.returncode
    except StopRequested as request:
        cancelled = request.number
        status = 128 + request.number
    except subprocess.TimeoutExpired:
        timed_out = True
        status = 124
    finally:
        # A second cancellation must not interrupt bounded child cleanup.
        for number in previous:
            signal.signal(number, signal.SIG_IGN)
        try:
            if process is not None and process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    output, _ = process.communicate(timeout=grace)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    output, _ = process.communicate(timeout=grace)
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)
    return {'exitCode': status, 'timedOut': timed_out, 'cancelledSignal': cancelled,
            'supervisorReaped': process is not None and process.poll() is not None}, output


def run_ip(*args):
    return subprocess.check_output(['ip', *args], text=True, timeout=10)


def resolve_node_runtime():
    launcher = shutil.which('node')
    if launcher is None:
        raise RuntimeError('Pinned Node runtime is missing')
    # The PATH entry may be Vite+'s HOME-dependent shim. Resolve the already
    # installed executable before private HOME and network isolation take effect.
    runtime = subprocess.check_output([launcher, '-p', 'process.execPath'],
                                      text=True, timeout=10).strip()
    path = Path(runtime)
    if not path.is_absolute() or not path.is_file():
        raise RuntimeError('Pinned Node runtime path is invalid')
    return str(path.resolve(strict=True))


def reap_children():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                return
        except ChildProcessError:
            return


def namespace_children():
    children = []
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit() and int(entry.name) != 1:
            try:
                state = (entry / 'stat').read_text().rsplit(')', 1)[1].strip().split()[0]
                children.append((int(entry.name), state))
            except (FileNotFoundError, ProcessLookupError):
                pass
    return children


def inner(evidence, fixture, executable, node, host_namespace):
    # PID1 and a distinct network namespace establish ownership before any mutation.
    private_namespace = os.readlink('/proc/self/ns/net')
    if os.getpid() != 1 or private_namespace == host_namespace:
        raise RuntimeError('Refusing to run outside the private PID/network namespaces')
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    process = None
    status = 1
    try:
        run_ip('link', 'set', 'lo', 'up')
        run_ip('link', 'add', 'issue28-in', 'type', 'veth', 'peer', 'name', 'issue28-peer')
        for interface, address in [('issue28-in', '10.188.28.2/24'), ('issue28-peer', '10.188.28.1/24')]:
            run_ip('address', 'add', address, 'dev', interface)
            run_ip('link', 'set', interface, 'up')
        assert json.loads(run_ip('-j', 'route', 'show', 'default')) == []
        write_json(evidence / 'initial-routes.json', json.loads(run_ip('-j', 'route', 'show', 'table', 'all')))
        for directory in ['config', 'cache', 'data', 'runtime', 'tmp']:
            (fixture / directory).mkdir(parents=True, mode=0o700, exist_ok=True)
        environment = {
            'PATH': str(Path(node).parent) + os.pathsep + os.environ['PATH'],
            'HOME': str(fixture), 'ZDOTDIR': str(fixture),
            'XDG_CONFIG_HOME': str(fixture / 'config'), 'XDG_CACHE_HOME': str(fixture / 'cache'),
            'XDG_DATA_HOME': str(fixture / 'data'), 'XDG_RUNTIME_DIR': str(fixture / 'runtime'),
            'TMPDIR': str(fixture / 'tmp'), 'LANG': 'C.UTF-8',
            'RUST_LOG': 'warn', 'BIBCODE_LOG': 'warn', 'BIBCODE_HERMETIC_GUARD': 'report',
            'BIBCODE_PORT': '14828', 'BIBCODE_GDK_BACKEND': 'x11',
            'APPIMAGE_EXTRACT_AND_RUN': '1',
            'WAYLAND_DISPLAY': 'bibcode-no-wayland',
            'BIBCODE_E2E_PLATFORM': 'linux', 'BIBCODE_E2E_APP_PATH': executable,
            'BIBCODE_E2E_RUN_ROOT': str(fixture / 'run'),
            'BIBCODE_E2E_ARTIFACT_DIR': str(evidence / 'private'),
            'BIBCODE_ISSUE28_NETNS': private_namespace,
            'BIBCODE_ISSUE28_HOST_NETNS': host_namespace,
            'BIBCODE_E2E_SPEC': './specs/no-default-route.e2e.ts',
        }
        command = ['xvfb-run', '--auto-servernum', node,
                   'node_modules/@wdio/cli/bin/wdio.js', 'run', './e2e/issue28.wdio.conf.ts']
        with (evidence / 'private-driver.log').open('wb') as output:
            process = subprocess.Popen(command, cwd='apps/desktop', env=environment,
                                       stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            status = process.wait(timeout=600)
    finally:
        # Every visible PID belongs to this newly created PID namespace. No host PID
        # is addressable through this /proc mount or this namespace's kill API.
        observed = namespace_children()
        for sig in [signal.SIGTERM, signal.SIGKILL]:
            for pid, state in namespace_children():
                if state != 'Z':
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if process is not None and process.poll() is None:
                    time.sleep(.05)
                    continue
                reap_children()
                if not namespace_children():
                    break
                time.sleep(.05)
        remaining = namespace_children()
        write_json(evidence / 'inner-cleanup.json', {
            'observedOwnedPids': [pid for pid, _ in observed],
            'remaining': remaining, 'driverReaped': process is None or process.poll() is not None,
        })
        if remaining:
            raise RuntimeError('Owned namespace children survived cleanup')
    return status


def outer():
    run_id = os.environ.get('GITHUB_RUN_ID', '')
    if not run_id.isdigit() or sys.platform != 'linux':
        raise RuntimeError('This disposable qualification requires a Linux GitHub runner')
    evidence = Path(os.environ['RUNNER_TEMP']) / 'issue28-evidence'
    fixture = Path(os.environ['RUNNER_TEMP']) / 'issue28-fixture'
    evidence.mkdir(mode=0o700, exist_ok=True)
    fixture.mkdir(mode=0o700, exist_ok=False)
    host_namespace = os.readlink('/proc/self/ns/net')
    executable = str(Path(os.environ['BIBCODE_E2E_APP_PATH']).resolve(strict=True))
    digest = hashlib.sha256()
    with open(executable, 'rb') as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    write_json(evidence / 'artifact.json', {'path': executable, 'sha256': digest.hexdigest(),
               'bytes': Path(executable).stat().st_size, 'source': os.environ.get('GITHUB_SHA')})
    node = resolve_node_runtime()
    command = ['unshare', '--user', '--map-root-user', '--net', '--pid', '--fork',
               '--mount-proc', '--kill-child=KILL', sys.executable, str(Path(__file__).resolve()),
               'inner', str(evidence), str(fixture), executable, node, host_namespace]
    summary, output = run_owned_command(command)
    # This contains only supervisor setup/tracebacks; WDIO/backend logs stay private.
    (evidence / 'supervisor.log').write_bytes(output[-65536:])
    for phase in ['no-default-route-light', 'no-default-route-dark', 'route-recovered-light', 'route-recovered-dark']:
        for extension in ['.json', '.png']:
            source = evidence / 'private' / (phase + extension)
            if source.is_file():
                shutil.copyfile(source, evidence / source.name)
    result = evidence / 'private' / 'result.json'
    if result.is_file():
        shutil.copyfile(result, evidence / 'result.json')
    write_json(evidence / 'failure-summary.json', failure_summary(evidence / 'private-driver.log'))
    # The unshare child's termination destroys its PID/network namespaces. Check the
    # host route namespace remains unchanged; never change routes in the outer process.
    summary.update({'hostNamespaceUnchanged': os.readlink('/proc/self/ns/net') == host_namespace,
                    'resultPresent': result.is_file(), 'privilegeMode': 'unprivileged user/network/PID namespaces'})
    write_json(evidence / 'execution.json', summary)
    print(json.dumps(summary))
    return summary['exitCode'] or int(summary['timedOut'] or not result.is_file())


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'preflight':
        host = os.readlink('/proc/self/ns/net')
        probe = ('import os,subprocess,sys;'
                 'assert os.getpid()==1 and os.readlink("/proc/self/ns/net")!=sys.argv[1];'
                 'subprocess.run(["ip","link","add","issue28-probe","type","veth","peer","name","issue28-peer"],check=True,timeout=5)')
        subprocess.run(['unshare', '--user', '--map-root-user', '--net', '--pid', '--fork',
                        '--mount-proc', '--kill-child=KILL', sys.executable, '-c', probe, host],
                       check=True, timeout=10)
        print('Unprivileged isolated route namespace preflight passed.')
        raise SystemExit(0)
    if len(sys.argv) > 1 and sys.argv[1] == 'inner':
        raise SystemExit(inner(Path(sys.argv[2]), Path(sys.argv[3]), *sys.argv[4:]))
    raise SystemExit(outer())
