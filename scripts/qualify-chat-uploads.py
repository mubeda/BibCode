#!/usr/bin/env python3
"""Disposable Linux browser upload qualification; never runs on a local host."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')


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

def prepare_tools(fixture, node, git, dirname):
    import shlex
    for name, executable in [('node', node), ('git', git), ('dirname', dirname)]:
        path = fixture / 'bin' / name
        path.write_text('#!/bin/sh\nexec ' + shlex.quote(executable) + ' "$@"\n')
        path.chmod(0o700)
    for name in ['gh', 'glab']:
        path = fixture / 'bin' / name
        path.write_text('#!/bin/sh\nexit 127\n')
        path.chmod(0o700)


def inner(evidence, fixture, node, server, chrome, driver, git, dirname, host_namespace, source):
    private_namespace = os.readlink('/proc/self/ns/net')
    if os.getpid() != 1 or private_namespace == host_namespace:
        raise RuntimeError('Refusing to run outside the owned PID/network namespaces')
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    process = None
    status = 1
    try:
        run_ip('link', 'set', 'lo', 'up')
        if json.loads(run_ip('-j', 'route', 'show', 'default')):
            raise RuntimeError('The qualification namespace unexpectedly has an external route')
        for directory in ['home', 'config', 'cache', 'data', 'runtime', 'bin']:
            (fixture / directory).mkdir(mode=0o700)
        prepare_tools(fixture, node, git, dirname)
        environment = {
            'CI': 'true', 'PATH': str(Path(node).parent) + os.pathsep + os.environ['PATH'],
            'HOME': str(fixture / 'home'), 'XDG_CONFIG_HOME': str(fixture / 'config'),
            'XDG_CACHE_HOME': str(fixture / 'cache'), 'XDG_DATA_HOME': str(fixture / 'data'),
            'XDG_RUNTIME_DIR': str(fixture / 'runtime'), 'TMPDIR': str(fixture), 'LANG': 'C.UTF-8',
            'BIBCODE_LOG': 'warn', 'RUST_LOG': 'warn',
            'BIBCODE_UPLOAD_FIXTURE': str(fixture), 'BIBCODE_UPLOAD_EVIDENCE': str(evidence),
            'BIBCODE_UPLOAD_NETNS': private_namespace, 'BIBCODE_UPLOAD_SERVER': server,
            'BIBCODE_UPLOAD_CHROME': chrome, 'BIBCODE_UPLOAD_DRIVER': driver,
            'BIBCODE_UPLOAD_SOURCE': source,
        }
        with (fixture / 'private-controller.log').open('xb') as output:
            process = subprocess.Popen([node, 'apps/desktop/e2e/qualify-chat-uploads.ts'],
                                       env=environment, stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            # This branch runs only the small-image smoke. Slow-link matrix
            # runs need their own explicit budget after this short loop works.
            status = process.wait(timeout=600)
    finally:
        observed = namespace_children()
        for number in [signal.SIGTERM, signal.SIGKILL]:
            for pid, state in namespace_children():
                if state != 'Z':
                    try:
                        os.kill(pid, number)
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
        write_json(evidence / 'namespace-cleanup.json', {
            'observedOwnedPids': [pid for pid, _ in observed], 'remaining': remaining,
            'controllerReaped': process is None or process.poll() is not None,
        })
        if remaining:
            raise RuntimeError('Owned namespace children survived cleanup')
    return status


def host_programs():
    if not os.environ.get('GITHUB_RUN_ID', '').isdigit() or sys.platform != 'linux':
        raise RuntimeError('This qualification runs only on a disposable Linux GitHub runner')
    programs = {name: shutil.which(name) for name in ['google-chrome', 'chromedriver', 'git', 'dirname', 'unshare', 'ip']}
    if not all(programs.values()):
        raise RuntimeError('The runner is missing required preinstalled Chrome/ChromeDriver or namespace tools')
    return programs


def preflight():
    programs = host_programs()
    help_text = subprocess.check_output([programs['unshare'], '--help'], text=True, timeout=5)
    if '--keep-caps' not in help_text:
        raise RuntimeError('The runner unshare does not support preserving its own user-namespace capabilities')
    old_namespace = os.readlink('/proc/self/ns/net')
    code = """
import os,subprocess,json,sys
from pathlib import Path
result = {'pid1': os.getpid() == 1, 'privateNamespace': os.readlink('/proc/self/ns/net') != sys.argv[1], 'uid': os.geteuid()}
cap = next(line.split()[1] for line in Path('/proc/self/status').read_text().splitlines() if line.startswith('CapEff:'))
result['netAdminBeforeExec'] = bool(int(cap, 16) & (1 << 12))
if not result['pid1'] or not result['privateNamespace']:
    print(json.dumps(result)); sys.exit(1)
link = subprocess.run([sys.argv[2], 'link', 'set', 'lo', 'up'], capture_output=True, text=True, timeout=5)
result['loopbackExit'] = link.returncode
result['loopbackPermissionDenied'] = 'Operation not permitted' in link.stderr
if link.returncode != 0:
    print(json.dumps(result)); sys.exit(1)
routes = subprocess.check_output([sys.argv[2], '-j', 'route', 'show', 'default'], text=True, timeout=5)
result['noDefaultRoute'] = json.loads(routes) == []
print(json.dumps(result)); sys.exit(0 if result['noDefaultRoute'] else 1)
"""
    records = []
    for keep in [False, True]:
        command = [programs['unshare'], '--user', '--map-current-user']
        if keep:
            command.append('--keep-caps')
        command += ['--net', '--pid', '--mount-proc', '--fork', '--kill-child', sys.executable,
                    '-c', code, old_namespace, programs['ip']]
        result, output = run_owned_command(command, timeout=15, grace=5)
        observation = None
        for line in output.decode('utf8', errors='replace').splitlines():
            try:
                candidate = json.loads(line)
                if isinstance(candidate, dict) and isinstance(candidate.get('pid1'), bool):
                    observation = {key: value for key, value in candidate.items()
                                   if key in ['pid1', 'privateNamespace', 'uid', 'netAdminBeforeExec',
                                              'loopbackExit', 'loopbackPermissionDenied', 'noDefaultRoute']
                                   and isinstance(value, (bool, int))}
            except (ValueError, TypeError):
                pass
        record = {'phase': 'namespace-preflight', 'keepUserNamespaceCapabilities': keep,
                  **result, 'observation': observation,
                  'unsharePermissionDenied': b'unshare failed: Operation not permitted' in output}
        records.append(record)
        print(json.dumps(record))
        if result['cancelledSignal'] is not None or result['timedOut'] or not result['supervisorReaped']:
            return result['exitCode'] or 1
    # Actual qualification uses the observed preserving configuration below.
    return records[-1]['exitCode']


def outer():
    programs = host_programs()
    run_id = os.environ['GITHUB_RUN_ID']
    node = resolve_node_runtime()
    server = str(Path(os.environ['BIBCODE_UPLOAD_SERVER']).resolve(strict=True))
    evidence = Path(os.environ['RUNNER_TEMP']) / ('issue17-browser-' + run_id)
    fixture = Path('/tmp') / ('bibcode-upload-' + run_id + '-' + uuid.uuid4().hex)
    evidence.mkdir(mode=0o700, exist_ok=False)
    fixture.mkdir(mode=0o700, exist_ok=False)
    namespace = os.readlink('/proc/self/ns/net')
    versions = {name: subprocess.check_output([path, '--version'], text=True, timeout=10).splitlines()[0]
                for name, path in programs.items() if name in ['google-chrome', 'chromedriver']}
    write_json(evidence / 'provenance.json', {'source': os.environ['GITHUB_SHA'], 'versions': versions,
                                             'fixtureRoot': str(fixture), 'guardMode': 'default Abort'})
    command = [programs['unshare'], '--user', '--map-current-user', '--keep-caps', '--net', '--pid', '--mount-proc',
               '--fork', '--kill-child', sys.executable, __file__, 'inner', str(evidence), str(fixture),
               node, server, programs['google-chrome'], programs['chromedriver'], programs['git'], programs['dirname'],
               namespace, os.environ['GITHUB_SHA']]
    result, _ = run_owned_command(command, timeout=660, grace=15)
    result['hostNetworkNamespaceUnchanged'] = os.readlink('/proc/self/ns/net') == namespace
    write_json(evidence / 'supervisor.json', result)
    print(json.dumps({'exitCode': result['exitCode'], 'evidence': str(evidence),
                      'supervisorReaped': result['supervisorReaped']}))
    return result['exitCode']


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'preflight':
        sys.exit(preflight())
    if len(sys.argv) > 1 and sys.argv[1] == 'inner':
        sys.exit(inner(Path(sys.argv[2]), Path(sys.argv[3]), *sys.argv[4:]))
    sys.exit(outer())
