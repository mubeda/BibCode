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
import hashlib

def ui_matrix_selection(value):
    if value in ['core', 'full']:
        return value
    raise RuntimeError('Unknown remote UI selection')

def scenario_settings(name):
    """Fixed entrypoints and budgets; no arbitrary controller path or argv."""
    if name == 'chat-upload':
        return {'controller': 'apps/desktop/e2e/qualify-chat-uploads.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue17-browser-', 'fixture_prefix': 'bibcode-upload-'}
    if name == 'remote-updates-ui':
        return {'controller': 'apps/desktop/e2e/qualify-remote-updates.ts',
                'inner_timeout': 1800, 'outer_timeout': 1860,
                'evidence_prefix': 'issue16-ui-', 'fixture_prefix': 'bibcode-remote-ui-'}
    if name == 'delivery-retry-ui':
        return {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue19-delivery-', 'fixture_prefix': 'bc-dr-'}
    if name == 'release-visual-core':
        return {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue29-core-', 'fixture_prefix': 'bc-vc-'}
    if name == 'release-visual-settings':
        return {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue29-settings-', 'fixture_prefix': 'bc-vs-'}
    if name == 'release-visual-browser-followups':
        return {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue29-browser-followups-', 'fixture_prefix': 'bc-vb-'}
    if name == 'release-visual-settings-followups':
        return {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue29-settings-followups-', 'fixture_prefix': 'bc-vf-'}
    if name == 'release-visual-git-project':
        return {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue29-git-project-', 'fixture_prefix': 'bc-vg-'}
    if name == 'release-visual-cursor-question':
        return {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue29-cursor-question-', 'fixture_prefix': 'bc-vq-'}
    if name == 'release-visual-workspace-substates':
        return {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue29-workspace-substates-', 'fixture_prefix': 'bc-vw-'}
    if name == 'release-visual-provider-chat':
        return {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue29-provider-chat-', 'fixture_prefix': 'bc-vp-'}
    if name == 'release-visual-project-lifecycle':
        return {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue29-project-lifecycle-', 'fixture_prefix': 'bc-vl-'}
    if name == 'release-visual-pull-requests':
        return {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue29-pull-requests-', 'fixture_prefix': 'bc-vr-'}
    if name == 'release-visual-native-sharing':
        return {'controller': 'apps/desktop/e2e/qualify-native-sharing.ts',
                'inner_timeout': 600, 'outer_timeout': 660,
                'evidence_prefix': 'issue29-native-sharing-', 'fixture_prefix': 'bc-vn-'}
    raise RuntimeError('Unknown qualification scenario')

def native_input_hashes(app, xvfb):
    """Exactly the immutable packaged application and its owned display executable."""
    result = {}
    for key, raw in [('appSha256', app), ('xvfbSha256', xvfb)]:
        path = Path(raw)
        if (not path.is_absolute() or path.is_symlink() or not path.is_file()
                or str(path.resolve(strict=True)) != raw or path.stat().st_size > 512 * 1024 * 1024):
            raise RuntimeError('Owned native build input refused')
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
        result[key] = digest.hexdigest()
    return result

def ui_input_hashes(server, fake_host, web_root):
    def digest(path):
        result = hashlib.sha256()
        with Path(path).open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                result.update(chunk)
        return result.hexdigest()
    root = Path(web_root)
    files = sorted(root.rglob('*'))
    if len(files) > 20000 or any(path.is_symlink() for path in files) or not (root / 'index.html').is_file():
        raise RuntimeError('Owned web build manifest refused')
    result = hashlib.sha256()
    count = 0
    for path in files:
        if path.is_file():
            result.update(path.relative_to(root).as_posix().encode() + b'\0' + digest(path).encode() + b'\n')
            count += 1
    return {'serverSha256': digest(server),
            **({'fakeHostSha256': digest(fake_host)} if fake_host is not None else {}),
            'webSha256': result.hexdigest(), 'webFiles': count}

def browser_input_hashes(server, web_root):
    root = Path(web_root)
    hosted = root.parent / 'hosted-web'
    if (hosted.is_symlink() or not hosted.is_dir() or hosted.resolve(strict=True) != hosted
            or root.resolve(strict=True) != root or root == hosted):
        raise RuntimeError('Owned hosted input refused')
    primary = ui_input_hashes(server, None, root)
    secondary = ui_input_hashes(server, None, hosted)
    return {**primary, 'hostedWebSha256': secondary['webSha256'],
            'hostedWebFiles': secondary['webFiles']}

def pull_requests_hosting_restored(fixture, result):
    """Closed source/theme proof plus exact retained private bytes after both process owners join."""
    try:
        proof_keys = {'source', 'theme', 'baselineRestored', 'undoCompleted', 'inputsUnchanged',
                      'ownedProcessesJoined', 'configSha256', 'hostingInputsSha256',
                      'baselineStateSha256', 'completionLogSha256', 'mutableFilesIdentitySha256'}
        proofs = result.get('pullRequestsHostingRestorationProofs')
        if not isinstance(proofs, list) or len(proofs) != 2:
            return False
        uid = fixture.lstat().st_uid
        def read_owned(path, size, mode):
            metadata = path.lstat()
            if (path.is_symlink() or not path.is_file() or path.resolve(strict=True) != path
                    or metadata.st_nlink != 1 or metadata.st_uid != uid
                    or metadata.st_mode & 0o777 != mode or metadata.st_size > size):
                raise ValueError('Owned hosting bytes refused')
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                opened = os.fstat(descriptor)
                with os.fdopen(descriptor, 'rb', closefd=False) as source:
                    value = source.read(size + 1)
                if (opened.st_dev != metadata.st_dev or opened.st_ino != metadata.st_ino
                        or len(value) != metadata.st_size):
                    raise ValueError('Owned hosting bytes changed')
                return value
            finally:
                os.close(descriptor)
        def exact_json(raw):
            def fields(pairs):
                value = {}
                for key, item in pairs:
                    if key in value: raise ValueError('Duplicate hosting field')
                    value[key] = item
                return value
            return json.loads(raw, object_pairs_hook=fields)
        seen = set()
        for proof in proofs:
            if (not isinstance(proof, dict) or set(proof) != proof_keys
                    or proof.get('theme') not in ['light', 'dark'] or proof['theme'] in seen
                    or proof.get('source') != result.get('source')
                    or any(proof.get(key) is not True for key in ['baselineRestored', 'undoCompleted', 'inputsUnchanged', 'ownedProcessesJoined'])
                    or any(not isinstance(proof.get(key), str) or len(proof[key]) != 64
                           or any(char not in '0123456789abcdef' for char in proof[key])
                           for key in ['configSha256', 'hostingInputsSha256', 'baselineStateSha256', 'completionLogSha256', 'mutableFilesIdentitySha256'])):
                return False
            seen.add(proof['theme'])
            lexical = fixture / proof['theme']
            if lexical.is_symlink(): return False
            root = lexical.resolve(strict=True)
            hosting = root / 'hosting'
            for directory in [root, hosting, hosting / 'bin']:
                metadata = directory.lstat()
                if (directory.is_symlink() or not directory.is_dir() or metadata.st_uid != uid
                        or metadata.st_mode & 0o777 != 0o700): return False
            if set(path.name for path in hosting.iterdir()) != {'bin', 'origins.gitconfig', 'host-state.json', 'host-calls.jsonl', 'hosting-config.json'}:
                return False
            files = ['hosting/bin/gh', 'hosting/bin/glab', 'hosting/bin/release-visual-pull-requests-protocol.mjs', 'hosting/hosting-config.json', 'hosting/origins.gitconfig']
            frozen = {name: read_owned(root / name, 1048576, 0o500 if '/bin/' in name else 0o600) for name in files}
            config_bytes = frozen['hosting/hosting-config.json']
            if hashlib.sha256(config_bytes).hexdigest() != proof['configSha256']: return False
            input_bytes = ''.join(name + '\0' + hashlib.sha256(frozen[name]).hexdigest() + '\n' for name in sorted(files)).encode()
            if hashlib.sha256(input_bytes).hexdigest() != proof['hostingInputsSha256']: return False
            config = exact_json(config_bytes)
            if (not isinstance(config, dict) or set(config) != {'root', 'sourceSha', 'uid', 'projects', 'exchanges', 'state', 'calls'}
                    or config.get('root') != str(root) or config.get('sourceSha') != proof['source']
                    or type(config.get('uid')) is not int or config['uid'] != uid
                    or config.get('state') != str(hosting / 'host-state.json')
                    or config.get('calls') != str(hosting / 'host-calls.jsonl')): return False
            state = read_owned(hosting / 'host-state.json', 4096, 0o600)
            state_value = exact_json(state)
            if (not isinstance(state_value, dict) or set(state_value) != {'labelApplied'} or state_value['labelApplied'] is not False
                    or hashlib.sha256(state).hexdigest() != proof['baselineStateSha256']): return False
            identity = ''
            for name in ['host-state.json', 'host-calls.jsonl']:
                metadata = (hosting / name).lstat()
                identity += name + '\0' + str(metadata.st_dev) + ':' + str(metadata.st_ino) + ':' + str(metadata.st_uid) + ':' + str(metadata.st_mode & 0o777) + '\n'
            if hashlib.sha256(identity.encode()).hexdigest() != proof['mutableFilesIdentitySha256']: return False
            calls = read_owned(hosting / 'host-calls.jsonl', 65536, 0o600)
            if hashlib.sha256(calls).hexdigest() != proof['completionLogSha256'] or not calls.endswith(b'\n'): return False
            records = [exact_json(line) for line in calls.splitlines()]
            if len(records) > 200: return False
            mutations = []
            for record in records:
                if (not isinstance(record, dict) or set(record) != {'kind', 'provider', 'number', 'success', 'bodySha256', 'mutation', 'stateSha256', 'stateIdentitySha256'}
                        or record.get('provider') not in ['github', 'gitlab'] or type(record.get('success')) is not bool): return False
                table = config.get('exchanges', {}).get(record['provider'])
                if (not isinstance(table, list) or not any(isinstance(entry, dict) and entry.get('kind') == record.get('kind')
                        and entry.get('number') == record.get('number') and (entry.get('exitCode') == 0) == record['success'] for entry in table)): return False
                if record['kind'] == 'labels':
                    if (record['provider'] != 'github' or record['number'] != 43 or record['success'] is not True
                            or record['bodySha256'] is not None or record['mutation'] not in ['label-add', 'label-remove']
                            or any(not isinstance(record[key], str) or len(record[key]) != 64 or any(char not in '0123456789abcdef' for char in record[key]) for key in ['stateSha256', 'stateIdentitySha256'])): return False
                    expected_state = b'{"labelApplied":true}' if record['mutation'] == 'label-add' else state
                    if record['stateSha256'] != hashlib.sha256(expected_state).hexdigest(): return False
                    if record['mutation'] == 'label-remove':
                        metadata = (hosting / 'host-state.json').lstat()
                        state_identity = 'host-state.json\0' + str(metadata.st_dev) + ':' + str(metadata.st_ino) + ':' + str(metadata.st_uid) + ':' + str(metadata.st_mode & 0o777) + '\n'
                        if record['stateIdentitySha256'] != hashlib.sha256(state_identity.encode()).hexdigest(): return False
                    mutations.append(record['mutation'])
                elif record['mutation'] is not None or record['stateSha256'] is not None or record['stateIdentitySha256'] is not None: return False
            if mutations != ['label-add', 'label-remove']: return False
        return seen == {'light', 'dark'}
    except (OSError, ValueError, TypeError, AttributeError):
        return False

def cleanup_ui_fixture(fixture, evidence, supervisor, scenario='remote-updates-ui'):
    """Delete only this allocated UI root after both owners prove joined cleanup."""
    if (supervisor.get('supervisorReaped') is not True or fixture.parent != Path('/tmp')
            or not fixture.name.startswith(scenario_settings(scenario)['fixture_prefix']) or fixture.is_symlink()):
        return False
    if (scenario == 'release-visual-pull-requests'
            and (supervisor.get('hostNetworkNamespaceUnchanged') is not True
                 or supervisor.get('buildInputsUnchanged') is not True)):
        return False
    try:
        receipt = evidence / 'namespace-cleanup.json'
        if receipt.stat().st_size > 4096:
            return False
        cleanup = json.loads(receipt.read_text())
        if cleanup.get('remaining') != [] or cleanup.get('controllerReaped') is not True:
            return False
        if scenario in ['release-visual-provider-chat', 'release-visual-project-lifecycle', 'release-visual-native-sharing', 'release-visual-settings-followups', 'release-visual-pull-requests', 'release-visual-browser-followups']:
            result_path = evidence / 'result.json'
            metadata = result_path.lstat()
            if result_path.is_symlink() or not result_path.is_file() or metadata.st_nlink != 1 or metadata.st_size > 131072:
                return False
            result = json.loads(result_path.read_text())
            if (result.get('selection') != scenario or result.get('source') != os.environ.get('GITHUB_SHA')
                    or result.get({'release-visual-provider-chat': 'providerChatFixtureSafeToDelete',
                                   'release-visual-project-lifecycle': 'projectLifecycleFixtureSafeToDelete',
                                   'release-visual-native-sharing': 'nativeSharingFixtureSafeToDelete',
                                   'release-visual-pull-requests': 'pullRequestsFixtureSafeToDelete',
                                   'release-visual-settings-followups': 'settingsFollowupFixtureSafeToDelete',
                                   'release-visual-browser-followups': 'browserFollowupFixtureSafeToDelete'}[scenario]) is not True
                    or result.get('childProcessesClosed') is not True or result.get('cleanupFailures') != []):
                return False
        if scenario == 'release-visual-pull-requests' and not pull_requests_hosting_restored(fixture, result):
            return False
        shutil.rmtree(fixture)
        return True
    except (OSError, ValueError, AttributeError):
        return False

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

def lifecycle_adopted_reaper(read_controller, children=None, waitpid=None):
    """Best-effort specific adopted-zombie reaping; the direct controller keeps its status owner."""
    children = children or namespace_children
    waitpid = waitpid or os.waitpid
    def reap(*_):
        try:
            controller = read_controller()
            if controller is None:
                return  # SIGCHLD may arrive while Popen has not yet assigned its direct child.
            direct = controller.pid
            if type(direct) is not int or not 2 <= direct <= 2147483647:
                return
            observed = children()
            if len(observed) > 256:
                return
            for pid, state in observed:
                if type(pid) is not int or not 2 <= pid <= 2147483647 or pid == direct or state != 'Z':
                    continue
                try:
                    waitpid(pid, os.WNOHANG)
                except (ChildProcessError, ProcessLookupError):
                    pass  # Adoption/exit can race the private namespace sample.
        except Exception:
            pass  # Optional reaping never replaces Popen.wait or the final cleanup proof.
    return reap


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

def prepare_native_launcher_tools(fixture, which=shutil.which):
    """Only the pinned AppRun interpreter/path reader, without widening PATH."""
    import shlex
    for name in ['bash', 'readlink']:
        raw = which(name)
        if not raw or not Path(raw).is_absolute():
            raise RuntimeError('Owned native launcher tool unavailable')
        executable = Path(raw).resolve(strict=True)
        if (not executable.is_file() or not os.access(executable, os.X_OK)
                or executable.stat().st_mode & 0o022):
            raise RuntimeError('Owned native launcher executable refused')
        path = fixture / 'bin' / name
        with path.open('x') as stream:
            stream.write('#!/bin/sh\nexec ' + shlex.quote(str(executable)) + ' "$@"\n')
        path.chmod(0o700)


def import_evidence_environment(scenario, source, environment):
    """Forward public recipient context only for the explicitly selected manual batch."""
    if (scenario != 'release-visual-browser-followups'
            or environment.get('CI') != 'true'
            or environment.get('GITHUB_ACTIONS') != 'true'
            or environment.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or environment.get('GITHUB_JOB') != 'visual_core'
            or environment.get('BIBCODE_IMPORT_EVIDENCE_SELECTED') != 'true'
            or not environment.get('BIBCODE_IMPORT_EVIDENCE_PUBLIC_SPKI')
            or not environment.get('BIBCODE_IMPORT_EVIDENCE_PUBLIC_SHA256')):
        return {}
    names = ['GITHUB_ACTIONS', 'GITHUB_EVENT_NAME', 'GITHUB_JOB',
             'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
             'BIBCODE_IMPORT_EVIDENCE_SELECTED', 'BIBCODE_IMPORT_EVIDENCE_PUBLIC_SPKI',
             'BIBCODE_IMPORT_EVIDENCE_PUBLIC_SHA256']
    return {**{name: environment.get(name, '') for name in names}, 'GITHUB_SHA': source}


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


def inner_resources(arguments):
    """Only the fixed chat, remote-update and real-server UI owner forms."""
    if len(arguments) == 0:
        return 'chat-upload', None, None, 'core'
    if len(arguments) == 4 and arguments[0] == 'remote-updates-ui':
        return arguments[0], arguments[1], arguments[2], ui_matrix_selection(arguments[3])
    if (len(arguments) == 2 and arguments[0] == 'release-visual-native-sharing'
            and Path(arguments[1]).is_absolute() and arguments[1].endswith('.AppImage')):
        return arguments[0], None, arguments[1], 'core'
    if len(arguments) == 2 and arguments[0] in ['delivery-retry-ui', 'release-visual-core', 'release-visual-settings', 'release-visual-git-project', 'release-visual-cursor-question', 'release-visual-workspace-substates', 'release-visual-provider-chat', 'release-visual-project-lifecycle', 'release-visual-settings-followups', 'release-visual-pull-requests', 'release-visual-browser-followups']:
        return arguments[0], None, arguments[1], 'core'
    raise RuntimeError('Unknown qualification owner payload')


def inner(evidence, fixture, node, server, chrome, driver, git, dirname, host_namespace, source, ip,
          *scenario_arguments):
    scenario, fake_host, web_root, ui_matrix = inner_resources(scenario_arguments)
    selection = scenario_settings(scenario)
    ui_matrix = ui_matrix_selection(ui_matrix)
    private_namespace = os.readlink('/proc/self/ns/net')
    if os.getpid() != 1 or private_namespace == host_namespace:
        raise RuntimeError('Refusing to run outside the owned PID/network namespaces')
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    process = None
    status = 1
    lifecycle_reaper = None
    previous_sigchld = None
    try:
        trusted_network = network_environment(host_namespace, ip)
        run_ip(ip, 'link', 'set', 'lo', 'up')
        if json.loads(run_ip(ip, '-j', 'route', 'show', 'default')):
            raise RuntimeError('The qualification namespace unexpectedly has an external route')
        for directory in ['home', 'config', 'cache', 'data', 'runtime', 'bin']:
            (fixture / directory).mkdir(mode=0o700)
        prepare_tools(fixture, node, git, dirname)
        if scenario == 'release-visual-native-sharing':
            prepare_native_launcher_tools(fixture, shutil.which)
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
            **trusted_network,
            **import_evidence_environment(scenario, source, os.environ),
        }
        if scenario == 'remote-updates-ui':
            environment.update({'BIBCODE_RELEASE_UI_FAKE_HOST': str(Path(fake_host).resolve(strict=True)),
                                'BIBCODE_RELEASE_UI_WEB': str(Path(web_root).resolve(strict=True)),
                                'BIBCODE_RELEASE_UI_MATRIX': ui_matrix})
        elif scenario == 'release-visual-native-sharing':
            app = Path(web_root)
            xvfb = Path(shutil.which('Xvfb') or '')
            if (not app.is_absolute() or app.is_symlink() or not app.is_file()
                    or str(app.resolve(strict=True)) != web_root or not os.access(app, os.X_OK)
                    or not xvfb.is_absolute() or not xvfb.is_file()):
                raise RuntimeError('Owned native executable handoff refused')
            environment.update({'BIBCODE_NATIVE_SHARING_APP': str(app),
                                'BIBCODE_NATIVE_SHARING_XVFB': str(xvfb.resolve(strict=True)),
                                'GIT_CONFIG_NOSYSTEM': '1',
                                'GIT_CONFIG_GLOBAL': str(fixture / 'empty-git-config')})
        elif scenario in ['delivery-retry-ui', 'release-visual-core', 'release-visual-settings', 'release-visual-git-project', 'release-visual-cursor-question', 'release-visual-workspace-substates', 'release-visual-provider-chat', 'release-visual-project-lifecycle', 'release-visual-settings-followups', 'release-visual-pull-requests', 'release-visual-browser-followups']:
            environment.update({'BIBCODE_DELIVERY_UI_WEB': str(Path(web_root).resolve(strict=True)),
                                'BIBCODE_DELIVERY_UI_SELECTION': scenario,
                                'GIT_CONFIG_NOSYSTEM': '1',
                                'GIT_CONFIG_GLOBAL': str(fixture / 'empty-git-config')})
        with os.fdopen(os.open(fixture / 'private-controller.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
            if scenario in ['release-visual-project-lifecycle', 'release-visual-settings-followups', 'release-visual-pull-requests', 'release-visual-browser-followups']:
                previous_sigchld = signal.getsignal(signal.SIGCHLD)
                lifecycle_reaper = lifecycle_adopted_reaper(lambda: process)
                signal.signal(signal.SIGCHLD, lifecycle_reaper)
            process = subprocess.Popen([node, selection['controller']],
                                       env=environment, stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            if lifecycle_reaper is not None:
                lifecycle_reaper()  # Also cover adoption before installation/assignment without another signal.
            status = process.wait(timeout=selection['inner_timeout'])
    finally:
        if lifecycle_reaper is not None:
            signal.signal(signal.SIGCHLD, previous_sigchld)
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


def outer(scenario='chat-upload', ui_matrix='core'):
    selection = scenario_settings(scenario)
    ui_matrix = ui_matrix_selection(ui_matrix)
    programs = host_programs()
    run_id = os.environ['GITHUB_RUN_ID']
    node = resolve_node_runtime()
    server = str(Path(os.environ['BIBCODE_UPLOAD_SERVER']).resolve(strict=True))
    evidence = Path(os.environ['RUNNER_TEMP']) / (selection['evidence_prefix'] + run_id)
    # Evidence carries the run ID; keep this owned TMPDIR short for Chromium's Unix socket.
    fixture = Path('/tmp') / (selection['fixture_prefix'] + uuid.uuid4().hex)
    evidence.mkdir(mode=0o700, exist_ok=False)
    fixture.mkdir(mode=0o700, exist_ok=False)
    namespace = os.readlink('/proc/self/ns/net')
    versions = {name: subprocess.check_output([path, '--version'], text=True, timeout=10).splitlines()[0]
                for name, path in programs.items() if name in ['google-chrome', 'chromedriver']}
    provenance = {'source': os.environ['GITHUB_SHA'], 'versions': versions, 'guardMode': 'default Abort'}
    command = [programs['unshare'], '--user', '--map-current-user', '--keep-caps', '--net', '--pid', '--mount-proc',
               '--fork', '--kill-child', sys.executable, __file__, 'inner', str(evidence), str(fixture),
               node, server, programs['google-chrome'], programs['chromedriver'], programs['git'], programs['dirname'],
               namespace, os.environ['GITHUB_SHA'], str(Path(programs['ip']).resolve(strict=True))]
    if scenario == 'release-visual-native-sharing':
        app = str(Path(os.environ['BIBCODE_NATIVE_SHARING_APP']).resolve(strict=True))
        xvfb = str(Path(shutil.which('Xvfb') or '').resolve(strict=True))
        provenance.update({'scenario': scenario, 'inputs': native_input_hashes(app, xvfb)})
        command.extend([scenario, app])
    elif scenario == 'remote-updates-ui':
        fake_host = str(Path(os.environ['BIBCODE_RELEASE_UI_FAKE_HOST']).resolve(strict=True))
        web_root = str(Path(os.environ['BIBCODE_RELEASE_UI_WEB']).resolve(strict=True))
        provenance.update({'scenario': scenario, 'selection': ui_matrix,
                           'inputs': ui_input_hashes(server, fake_host, web_root)})
        command.extend([scenario, fake_host, web_root, ui_matrix])
    elif scenario in ['delivery-retry-ui', 'release-visual-core', 'release-visual-settings', 'release-visual-git-project', 'release-visual-cursor-question', 'release-visual-workspace-substates', 'release-visual-provider-chat', 'release-visual-project-lifecycle', 'release-visual-settings-followups', 'release-visual-pull-requests', 'release-visual-browser-followups']:
        fake_host = None
        web_root = str(Path(os.environ['BIBCODE_DELIVERY_UI_WEB']).resolve(strict=True))
        provenance.update({'scenario': scenario, 'inputs': (browser_input_hashes(server, web_root) if scenario == 'release-visual-browser-followups' else ui_input_hashes(server, None, web_root))})
        command.extend([scenario, web_root])
    else:
        provenance['fixtureRoot'] = str(fixture)
    write_json(evidence / 'provenance.json', provenance)
    result, _ = run_owned_command(command, timeout=selection['outer_timeout'], grace=15)
    result['hostNetworkNamespaceUnchanged'] = os.readlink('/proc/self/ns/net') == namespace
    if scenario == 'release-visual-native-sharing':
        result['buildInputsUnchanged'] = native_input_hashes(app, xvfb) == provenance['inputs']
        result['privateFixtureDeleted'] = cleanup_ui_fixture(fixture, evidence, result, scenario)
        if not result['privateFixtureDeleted'] or not result['hostNetworkNamespaceUnchanged'] or not result['buildInputsUnchanged']:
            result['exitCode'] = result['exitCode'] or 1
    elif scenario in ['remote-updates-ui', 'delivery-retry-ui', 'release-visual-core', 'release-visual-settings', 'release-visual-git-project', 'release-visual-cursor-question', 'release-visual-workspace-substates', 'release-visual-provider-chat', 'release-visual-project-lifecycle', 'release-visual-settings-followups', 'release-visual-pull-requests', 'release-visual-browser-followups']:
        result['buildInputsUnchanged'] = (browser_input_hashes(server, web_root) if scenario == 'release-visual-browser-followups' else ui_input_hashes(server, fake_host, web_root)) == provenance['inputs']
        result['privateFixtureDeleted'] = cleanup_ui_fixture(fixture, evidence, result, scenario)
        if not result['privateFixtureDeleted'] or not result['hostNetworkNamespaceUnchanged'] or not result['buildInputsUnchanged']:
            result['exitCode'] = result['exitCode'] or 1
    write_json(evidence / 'supervisor.json', result)
    print(json.dumps({'exitCode': result['exitCode'],
                      **({'selection': scenario} if scenario in ['release-visual-settings-followups', 'release-visual-pull-requests', 'release-visual-browser-followups'] else {'evidence': str(evidence)}),
                      'supervisorReaped': result['supervisorReaped']}))
    return result['exitCode']


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'network':
        sys.exit(network())
    if len(sys.argv) > 1 and sys.argv[1] == 'preflight':
        sys.exit(preflight())
    if len(sys.argv) > 1 and sys.argv[1] == 'inner':
        sys.exit(inner(Path(sys.argv[2]), Path(sys.argv[3]), *sys.argv[4:]))
    if len(sys.argv) == 3 and sys.argv[1] == '--scenario':
        if sys.argv[2] in ['release-visual-settings-followups', 'release-visual-browser-followups']:
            try:
                sys.exit(outer(sys.argv[2]))
            except Exception:
                print(json.dumps({'refused': True, 'stage': 'browser-controller' if sys.argv[2] == 'release-visual-browser-followups' else 'settings-controller'}))
                sys.exit(1)
        if sys.argv[2] == 'release-visual-native-sharing':
            try:
                sys.exit(outer(sys.argv[2]))
            except Exception:
                # Native admission failure never publishes raw executable paths or exceptions.
                print(json.dumps({'refused': True, 'stage': 'native-controller'}))
                sys.exit(1)
        sys.exit(outer(sys.argv[2]))
    if len(sys.argv) == 5 and sys.argv[1:4] == ['--scenario', 'remote-updates-ui', '--matrix']:
        sys.exit(outer('remote-updates-ui', sys.argv[4]))
    if len(sys.argv) != 1:
        raise RuntimeError('Unknown qualification command')
    sys.exit(outer())
