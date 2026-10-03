#!/usr/bin/env python3
"""Disposable Linux browser upload qualification; never runs on a local host."""
import json
import hashlib
import os
from pathlib import Path
import shutil
import signal
import stat
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


def run_ip(ip, *args):
    return subprocess.check_output([ip, *args], text=True, timeout=10)


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


def network_environment(host_namespace, ip):
    """Only the checked private PID1 may publish identities to its child helper."""
    if os.getpid() != 1:
        raise RuntimeError('Network helper requires its owned PID1')
    identities = {kind: os.readlink('/proc/self/ns/' + kind) for kind in ['net', 'pid', 'user']}
    if identities['net'] == host_namespace or any(os.readlink('/proc/1/ns/' + kind) != value for kind, value in identities.items()):
        raise RuntimeError('Network helper namespace ownership refused')
    return {'BIBCODE_UPLOAD_HOST_NETNS': host_namespace, 'BIBCODE_UPLOAD_NETNS': identities['net'],
            'BIBCODE_UPLOAD_PIDNS': identities['pid'], 'BIBCODE_UPLOAD_USERNS': identities['user'],
            'BIBCODE_UPLOAD_IP': str(Path(ip).resolve(strict=True)),
            'BIBCODE_UPLOAD_PYTHON': str(Path(sys.executable).resolve(strict=True)),
            'BIBCODE_UPLOAD_NETWORK_HELPER': str(Path(__file__).resolve(strict=True))}


def network():
    import importlib.util
    spec = importlib.util.spec_from_file_location('contained_network', Path(__file__).with_name('qualify-chat-network.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        proof = module.setup(os.environ, run_owned_command)
    except module.NetworkRefused as failure:
        print(json.dumps({'refused': True, 'failure': failure.proof}))
        return 1
    except Exception:
        # Never emit exception, raw ip output, routes or environment identities.
        print(json.dumps({'refused': True, 'failure': {'stage': 'helper-process', 'attemptedMutations': None, 'completedMutations': None, 'netAdminEffective': None, 'lastCommand': None}}))
        return 1
    print(json.dumps(proof))
    return 0


def qualification_mode(value):
    if value is None or value == 'upload-smoke':
        return 'upload-smoke'
    if value in ['startup-only', 'upload-matrix', 'remaining-qualification']:
        return value
    raise RuntimeError('The qualification mode is invalid')



def case_settings(mode, selected):
    if mode != 'upload-matrix':
        if selected not in [None, '']:
            raise RuntimeError('The upload matrix case is invalid')
        return {'case': None, 'inner_timeout': 900, 'outer_timeout': 960} if mode == 'remaining-qualification' else {'case': None, 'inner_timeout': 600, 'outer_timeout': 660}
    manifest = json.loads((Path(__file__).resolve().parent.parent / 'apps/desktop/e2e/support/chat-upload-matrix-cases.json').read_text())
    match = next((entry for entry in manifest if entry['case'] == selected), None)
    if (match is None or match.get('innerTimeoutSeconds') != 1800 or match.get('outerTimeoutSeconds') != 1860
            or match.get('upBytesPerSecond') not in [16384, 65536]
            or match.get('transport') not in ['plain', 'noise'] or match.get('theme') not in ['light', 'dark']):
        raise RuntimeError('The upload matrix case is invalid')
    return {'case': match['case'], 'inner_timeout': 1800, 'outer_timeout': 1860}


def verify_old_inline_input(server, receipt_path):
    """A CI-owned source receipt is separate from observed server/UI qualification."""
    try:
        with os.fdopen(os.open(receipt_path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as receipt_file:
            if not stat.S_ISREG(os.fstat(receipt_file.fileno()).st_mode):
                raise ValueError()
            raw = receipt_file.read(4097)
        if len(raw) > 4096:
            raise ValueError()
        receipt = json.loads(raw)
        keys = {'source', 'serverVersion', 'binarySha256', 'build', 'hermeticGuard', 'contractProof'}
        proof_keys = {'serveFlags', 'pairingIssue', 'inlineDataUrl', 'capabilityAbsent', 'operateScope'}
        if (not isinstance(receipt, dict) or set(receipt) != keys
                or receipt['source'] != 'cd66fda5700294a320fe76256c486bd7a7a0b3a5'
                or receipt['serverVersion'] != '0.7.2' or receipt['build'] != 'immutable-source'
                or receipt['hermeticGuard'] != 'unavailable-in-old-source'
                or not isinstance(receipt['binarySha256'], str) or len(receipt['binarySha256']) != 64
                or any(char not in '0123456789abcdef' for char in receipt['binarySha256'])
                or not isinstance(receipt['contractProof'], dict)
                or set(receipt['contractProof']) != proof_keys
                or any(value is not True for value in receipt['contractProof'].values())):
            raise ValueError()
        hasher = hashlib.sha256()
        with os.fdopen(os.open(server, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as binary:
            before = os.fstat(binary.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_mode & 0o222 or not 0 < before.st_size <= 512 * 1024 ** 2:
                raise ValueError()
            total = 0
            while chunk := binary.read(65536):
                total += len(chunk)
                if total > before.st_size:
                    raise ValueError()
                hasher.update(chunk)
            after = os.fstat(binary.fileno())
        if (total != before.st_size or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                or hasher.hexdigest() != receipt['binarySha256']):
            raise ValueError()
        return receipt
    except (OSError, ValueError, TypeError, KeyError):
        raise RuntimeError('Old inline input refused') from None


def old_inline_contract_proof(files, version, serve_help, pairing_help):
    """Compatibility source/CLI proof; not observed application or provider success."""
    expected = {'manifest', 'lifecycle', 'control', 'environment', 'orchestration', 'scope', 'model', 'library'}
    if (not isinstance(files, dict) or set(files) != expected
            or any(not isinstance(value, str) or len(value) > 2 * 1024 ** 2 for value in files.values())
            or not isinstance(version, str) or version.strip() != 'bibcode 0.7.2'
            or not isinstance(serve_help, str) or len(serve_help) > 65536
            or not isinstance(pairing_help, str) or len(pairing_help) > 65536):
        raise RuntimeError('Old inline input refused')
    position = files['scope'].find('"orchestration.dispatchCommand"')
    tail = files['scope'][position:] if position >= 0 else ''
    arm = tail.split('=>', 1)[1].split(',', 1)[0] if '=>' in tail else ''
    proof = {
        'serveFlags': all(flag in serve_help for flag in ['--mode', '--host', '--port', '--base-dir', '--dev-url', '--no-browser', '--no-startup-pairing-offer']),
        'pairingIssue': all(flag in pairing_help for flag in ['--base-dir', '--dev-url', '--json']) and 'issue_administrative_pairing_link' in files['library'],
        'inlineDataUrl': 'dataUrl' in files['orchestration'] and 'uploadId' not in files['orchestration'],
        'capabilityAbsent': all('attachmentStaging' not in files[key] for key in ['lifecycle', 'control', 'environment']),
        'operateScope': 'Some(SCOPE_ORCHESTRATION_OPERATE)' in arm and '"orchestration:operate"' in files['model'],
    }
    if ('version = "0.7.2"' not in files['manifest'] or 'hermetic-test-guard' in files['manifest']
            or any(value is not True for value in proof.values())):
        raise RuntimeError('Old inline input refused')
    return proof


def prepare_old_inline_input():
    """CI-only producer for the immutable second checkout and separate native build."""
    if sys.platform != 'linux' or os.environ.get('CI') != 'true' or not os.environ.get('GITHUB_RUN_ID', '').isdigit():
        raise RuntimeError('Old inline preparation refused')
    try:
        checkout = (Path(os.environ['GITHUB_WORKSPACE']) / '.qa-old-inline-source').resolve(strict=True)
        runner = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
        built = runner / 'issue17-old-inline-target/debug/bibcode'
        receipt_path = runner / 'issue17-old-inline-input.json'
        git = shutil.which('git')
        if not git or not built.is_file() or built.is_symlink() or not 0 < built.stat().st_size <= 512 * 1024 ** 2:
            raise ValueError()
        git_env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0'}
        for key in list(git_env):
            if key.upper().startswith('GIT_') and key not in ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_OPTIONAL_LOCKS']:
                del git_env[key]
        def revision():
            sha = subprocess.check_output([git, '-C', str(checkout), 'rev-parse', 'HEAD'], env=git_env, text=True, timeout=5).strip()
            dirty = subprocess.check_output([git, '-C', str(checkout), 'status', '--porcelain', '--untracked-files=all'], env=git_env, text=True, timeout=5)
            if sha != 'cd66fda5700294a320fe76256c486bd7a7a0b3a5' or dirty:
                raise ValueError()
            return sha
        source = revision()
        native_input = runner / 'issue17-old-inline-input'
        native_input.mkdir(mode=0o700, exist_ok=False)
        binary = native_input / 'bibcode'
        shutil.copyfile(built, binary)
        binary.chmod(0o500)
        paths = {'manifest': 'apps/server/Cargo.toml', 'lifecycle': 'apps/server/src/lifecycle.rs', 'control': 'apps/server/src/production/control.rs', 'environment': 'packages/contracts/src/environment.ts', 'orchestration': 'packages/contracts/src/orchestration.ts', 'scope': 'apps/server/src/auth/scope.rs', 'model': 'apps/server/src/auth/model.rs', 'library': 'apps/server/src/lib.rs'}
        files = {}
        for key, relative in paths.items():
            path = checkout / relative
            if path.stat().st_size > 2 * 1024 ** 2:
                raise ValueError()
            files[key] = path.read_text()
        private = runner / 'issue17-old-inline-preparation'
        private.mkdir(mode=0o700, exist_ok=False)
        home = private / 'home'; home.mkdir(mode=0o700)
        environment = {'PATH': os.environ['PATH'], 'LANG': 'C.UTF-8', 'HOME': str(home), 'USERPROFILE': str(home), 'CODEX_HOME': str(home / '.codex'), 'CLAUDE_CONFIG_DIR': str(home / '.claude'), 'XDG_CONFIG_HOME': str(home / 'config'), 'XDG_CACHE_HOME': str(home / 'cache'), 'XDG_DATA_HOME': str(home / 'data')}
        outputs = []
        for index, arguments in enumerate([['--version'], ['serve', '--help'], ['pairing', 'issue', '--help']]):
            output_path = private / ('cli-' + str(index))
            with output_path.open('xb') as output:
                process = subprocess.run([str(binary), *arguments], env=environment, cwd=private, stdout=output, stderr=output, timeout=10, check=False)
            if process.returncode != 0 or output_path.stat().st_size > 65536:
                raise ValueError()
            outputs.append(output_path.read_text())
        proof = old_inline_contract_proof(files, *outputs)
        revision()
        hasher = hashlib.sha256()
        with binary.open('rb') as opened:
            while chunk := opened.read(65536):
                hasher.update(chunk)
        receipt = {'source': source, 'serverVersion': '0.7.2', 'binarySha256': hasher.hexdigest(), 'build': 'immutable-source', 'hermeticGuard': 'unavailable-in-old-source', 'contractProof': proof}
        with receipt_path.open('x') as output:
            os.chmod(receipt_path, 0o600)
            output.write(json.dumps(receipt, indent=2) + '\n')
        verify_old_inline_input(str(binary), str(receipt_path))
        receipt_path.chmod(0o400)
        print(json.dumps({'oldInputPrepared': True, **receipt}))
        return 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        raise RuntimeError('Old inline preparation refused') from None


def inner(evidence, fixture, node, server, chrome, driver, git, dirname, host_namespace, source, ip, old_receipt_json=None):
    mode = qualification_mode(os.environ.get('BIBCODE_UPLOAD_MODE'))
    selection = case_settings(mode, os.environ.get('BIBCODE_UPLOAD_CASE'))
    old_receipt = json.loads(old_receipt_json) if old_receipt_json is not None else None
    private_namespace = os.readlink('/proc/self/ns/net')
    if os.getpid() != 1 or private_namespace == host_namespace:
        raise RuntimeError('Refusing to run outside the owned PID/network namespaces')
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    process = None
    status = 1
    try:
        trusted_network = network_environment(host_namespace, ip)
        run_ip(ip, 'link', 'set', 'lo', 'up')
        if json.loads(run_ip(ip, '-j', 'route', 'show', 'default')):
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
            'BIBCODE_UPLOAD_MODE': mode,
            **({'BIBCODE_UPLOAD_CASE': selection['case']} if selection['case'] is not None else {}),
            **({'BIBCODE_UPLOAD_OLD_INPUT': json.dumps(old_receipt)} if mode == 'remaining-qualification' else {}),
            **trusted_network,
        }
        with (fixture / 'private-controller.log').open('xb') as output:
            process = subprocess.Popen([node, 'apps/desktop/e2e/qualify-chat-uploads.ts'],
                                       env=environment, stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            # Only explicit fixed profiles receive their reviewed diagnostic budgets.
            status = process.wait(timeout=selection['inner_timeout'])
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
    mode = qualification_mode(os.environ.get('BIBCODE_UPLOAD_MODE'))
    selection = case_settings(mode, os.environ.get('BIBCODE_UPLOAD_CASE'))
    programs = host_programs()
    run_id = os.environ['GITHUB_RUN_ID']
    node = resolve_node_runtime()
    old_receipt = None
    if mode == 'remaining-qualification':
        old_server = os.environ.get('BIBCODE_UPLOAD_OLD_SERVER')
        old_receipt_path = os.environ.get('BIBCODE_UPLOAD_OLD_RECEIPT')
        if not old_server or not old_receipt_path:
            raise RuntimeError('Old inline input refused')
        old_receipt = verify_old_inline_input(old_server, old_receipt_path)
        server = str(Path(old_server).resolve(strict=True))
    else:
        server = str(Path(os.environ['BIBCODE_UPLOAD_SERVER']).resolve(strict=True))
    evidence = Path(os.environ['RUNNER_TEMP']) / ('issue17-browser-' + run_id)
    # Evidence carries the run ID; keep owned TMPDIR short for native Unix sockets.
    fixture = Path('/tmp') / ('bibcode-upload-' + uuid.uuid4().hex)
    evidence.mkdir(mode=0o700, exist_ok=False)
    fixture.mkdir(mode=0o700, exist_ok=False)
    namespace = os.readlink('/proc/self/ns/net')
    versions = {name: subprocess.check_output([path, '--version'], text=True, timeout=10).splitlines()[0]
                for name, path in programs.items() if name in ['google-chrome', 'chromedriver']}
    webkit_driver_available = shutil.which('WebKitWebDriver') is not None
    write_json(evidence / 'provenance.json', {'source': os.environ['GITHUB_SHA'], 'versions': versions,
                                             'qualificationMode': mode, 'matrixCase': selection['case'],
                                             'fixtureRoot': str(fixture),
                                             'guardMode': 'unavailable-in-old-source' if old_receipt is not None else 'default Abort',
                                             'oldInput': old_receipt,
                                             'webkitgtk': {'measurement': 'not-measured', 'driverAvailable': webkit_driver_available,
                                                           'reason': 'owned-profile-unavailable' if webkit_driver_available else 'driver-not-installed'}})
    if mode == 'remaining-qualification' and webkit_driver_available:
        raise RuntimeError('Available WebKitGTK driver requires its owned native profile')
    command = [programs['unshare'], '--user', '--map-current-user', '--keep-caps', '--net', '--pid', '--mount-proc',
               '--fork', '--kill-child', sys.executable, __file__, 'inner', str(evidence), str(fixture),
               node, server, programs['google-chrome'], programs['chromedriver'], programs['git'], programs['dirname'],
               namespace, os.environ['GITHUB_SHA'], str(Path(programs['ip']).resolve(strict=True)),
               json.dumps(old_receipt)]
    result, _ = run_owned_command(command, timeout=selection['outer_timeout'], grace=15)
    result['hostNetworkNamespaceUnchanged'] = os.readlink('/proc/self/ns/net') == namespace
    write_json(evidence / 'supervisor.json', result)
    print(json.dumps({'exitCode': result['exitCode'], 'evidence': str(evidence),
                      'supervisorReaped': result['supervisorReaped']}))
    return result['exitCode']


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'prepare-old-input':
        sys.exit(prepare_old_inline_input())
    if len(sys.argv) > 1 and sys.argv[1] == 'network':
        sys.exit(network())
    if len(sys.argv) > 1 and sys.argv[1] == 'preflight':
        sys.exit(preflight())
    if len(sys.argv) > 1 and sys.argv[1] == 'inner':
        sys.exit(inner(Path(sys.argv[2]), Path(sys.argv[3]), *sys.argv[4:]))
    sys.exit(outer())
