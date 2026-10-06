"""Real-process supervisor tests; no namespace, installer, or UI execution."""
import importlib.util
import ast
import contextlib
import io
import json
import hashlib
import os
from pathlib import Path
import signal
import subprocess
import shutil
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

SOURCE = Path(__file__).with_name('qualify-chat-uploads.py')
spec = importlib.util.spec_from_file_location('qualification', SOURCE)
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


class SettingsFollowupBoundariesTests(unittest.TestCase):
    def test_actual_entrypoint_closes_private_native_failures(self):
        tree = ast.parse(SOURCE.read_text())
        entrypoint = tree.body[-1]
        output = io.StringIO()
        def stop(code): raise SystemExit(code)
        namespace = {'__name__': '__main__', 'sys': types.SimpleNamespace(argv=['qualifier', '--scenario', 'release-visual-settings-followups'], exit=stop),
                     'json': json, 'outer': mock.Mock(side_effect=RuntimeError('private native error and arguments'))}
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as ended:
            exec(compile(ast.Module(body=[entrypoint], type_ignores=[]), 'owned-entrypoint', 'exec'), namespace)
        self.assertEqual(ended.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue()), {'refused': True, 'stage': 'settings-controller'})

    def test_actual_outer_stdout_has_only_closed_settings_fields(self):
        outer = next(node for node in ast.parse(SOURCE.read_text()).body if isinstance(node, ast.FunctionDef) and node.name == 'outer')
        emission = next(node for node in reversed(outer.body) if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == 'print')
        output = io.StringIO()
        namespace = {'json': json, 'scenario': 'release-visual-settings-followups', 'result': {'exitCode': 1, 'supervisorReaped': True}, 'evidence': Path('/private/owned/evidence')}
        with contextlib.redirect_stdout(output): exec(compile(ast.Module(body=[emission], type_ignores=[]), 'owned-emission', 'exec'), namespace)
        self.assertEqual(json.loads(output.getvalue()), {'exitCode': 1, 'selection': 'release-visual-settings-followups', 'supervisorReaped': True})

    def test_fixed_controller_payload_and_original_budgets(self):
        self.assertEqual(qualification.scenario_settings('release-visual-settings-followups'), {
            'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts', 'inner_timeout': 600, 'outer_timeout': 660,
            'evidence_prefix': 'issue29-settings-followups-', 'fixture_prefix': 'bc-vf-',
        })
        self.assertEqual(qualification.inner_resources(['release-visual-settings-followups', '/owned/web']),
                         ('release-visual-settings-followups', None, '/owned/web', 'core'))
        for args in [['release-visual-settings-followups'], ['release-visual-settings-followups', '/owned/web', 'full']]:
            with self.assertRaises(RuntimeError): qualification.inner_resources(args)

    def test_unsafe_or_unjoined_settings_restoration_preserves_fixture(self):
        for mode in ['missing', 'false', 'wrong-selection', 'wrong-source', 'live-child', 'cleanup-failure', 'safe']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                evidence = Path(directory); fixture = Path(tempfile.mkdtemp(prefix='bc-vf-', dir='/tmp'))
                try:
                    (evidence / 'namespace-cleanup.json').write_text(json.dumps({'remaining': [], 'controllerReaped': True}))
                    result = {'selection': 'release-visual-settings-followups', 'source': 'a' * 40,
                              'settingsFollowupFixtureSafeToDelete': True, 'childProcessesClosed': True, 'cleanupFailures': []}
                    if mode == 'missing': result.pop('settingsFollowupFixtureSafeToDelete')
                    if mode == 'false': result['settingsFollowupFixtureSafeToDelete'] = False
                    if mode == 'wrong-selection': result['selection'] = 'release-visual-core'
                    if mode == 'wrong-source': result['source'] = 'b' * 40
                    if mode == 'live-child': result['childProcessesClosed'] = False
                    if mode == 'cleanup-failure': result['cleanupFailures'] = [{}]
                    (evidence / 'result.json').write_text(json.dumps(result))
                    with mock.patch.dict(os.environ, {'GITHUB_SHA': 'a' * 40}):
                        deleted = qualification.cleanup_ui_fixture(fixture, evidence, {'supervisorReaped': True}, 'release-visual-settings-followups')
                    self.assertEqual(deleted, mode == 'safe'); self.assertEqual(fixture.exists(), mode != 'safe')
                finally: shutil.rmtree(fixture, ignore_errors=True)


class BrowserFollowupBoundariesTests(unittest.TestCase):
    def test_actual_outer_initial_and_postrun_consumers_join_unchanged_inputs_and_refuse_either_ui_drift(self):
        for scenario, drift in [('release-visual-browser-followups', None), ('release-visual-browser-followups', 'web'), ('release-visual-browser-followups', 'hosted-web'), ('release-visual-core', 'hosted-web'), ('remote-updates-ui', 'hosted-web')]:
            with self.subTest(scenario=scenario, drift=drift), tempfile.TemporaryDirectory() as directory:
                root=Path(directory).resolve();server=root/'server';server.write_bytes(b'inert binary');web=root/'web';web.mkdir();(web/'index.html').write_bytes(b'inert primary');hosted=root/'hosted-web';hosted.mkdir();(hosted/'index.html').write_bytes(b'inert hosted');(hosted/'qualified-hosted-mode.js').write_bytes(b'inert SDK probe');fake=root/'fake';fake.write_bytes(b'inert fake host');owned=[];commands=[]
                programs={name:str(server) for name in ['unshare','google-chrome','chromedriver','git','dirname','ip']}
                def run(argv, **options):
                    commands.append(argv);inner=argv.index('inner');owned.append(Path(argv[inner+2]));self.assertEqual(options,{'timeout':660 if scenario != 'remote-updates-ui' else 1860,'grace':15})
                    if drift: (root/drift/'index.html').write_bytes(b'inert changed original')
                    return {'exitCode':0,'supervisorReaped':True}, []
                output=io.StringIO();original_readlink=qualification.os.readlink
                def readlink(path):return 'net:[inert]' if str(path)=='/proc/self/ns/net' else original_readlink(path)
                try:
                    with mock.patch.dict(os.environ,{'GITHUB_RUN_ID':'inert-run','GITHUB_SHA':'a'*40,'RUNNER_TEMP':str(root),'BIBCODE_UPLOAD_SERVER':str(server),'BIBCODE_DELIVERY_UI_WEB':str(web),'BIBCODE_RELEASE_UI_WEB':str(web),'BIBCODE_RELEASE_UI_FAKE_HOST':str(fake)}), mock.patch.object(qualification,'host_programs',return_value=programs), mock.patch.object(qualification,'resolve_node_runtime',return_value=str(server)), mock.patch.object(qualification.os,'readlink',side_effect=readlink), mock.patch.object(qualification.subprocess,'check_output',return_value='inert version\n'), mock.patch.object(qualification,'run_owned_command',side_effect=run), mock.patch.object(qualification,'cleanup_ui_fixture',return_value=True), contextlib.redirect_stdout(output):
                        status=qualification.outer(scenario)
                    evidence=root/(qualification.scenario_settings(scenario)['evidence_prefix']+'inert-run');initial=json.loads((evidence/'provenance.json').read_text())['inputs'];result=json.loads((evidence/'supervisor.json').read_text());unchanged=scenario!='release-visual-browser-followups' or drift is None
                    self.assertEqual(status,0 if unchanged else 1);self.assertEqual(result['buildInputsUnchanged'],unchanged);self.assertTrue(result['hostNetworkNamespaceUnchanged']);self.assertEqual(len(commands),1)
                    self.assertEqual('hostedWebSha256' in initial,scenario=='release-visual-browser-followups');self.assertEqual('hostedWebFiles' in initial,scenario=='release-visual-browser-followups')
                    if scenario=='release-visual-browser-followups':self.assertEqual(set(json.loads(output.getvalue())),{'exitCode','selection','supervisorReaped'})
                finally:
                    for fixture in owned:shutil.rmtree(fixture,ignore_errors=True)

    def test_fixed_two_scalar_controller_and_original_bounds(self):
        self.assertEqual(qualification.scenario_settings('release-visual-browser-followups'), {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts', 'inner_timeout': 600, 'outer_timeout': 660, 'evidence_prefix': 'issue29-browser-followups-', 'fixture_prefix': 'bc-vb-'})
        self.assertEqual(qualification.inner_resources(['release-visual-browser-followups', '/owned/web']), ('release-visual-browser-followups', None, '/owned/web', 'core'))
        for arguments in [['release-visual-browser-followups'], ['release-visual-browser-followups', '/owned/web', '/hosted'], ['release-visual-browser-followups/other', '/owned/web']]:
            with self.assertRaises(RuntimeError): qualification.inner_resources(arguments)

    def test_actual_entrypoint_refuses_with_only_closed_browser_fields(self):
        entrypoint=ast.parse(SOURCE.read_text()).body[-1]; output=io.StringIO()
        def stop(code): raise SystemExit(code)
        namespace={'__name__':'__main__','sys':types.SimpleNamespace(argv=['qualifier','--scenario','release-visual-browser-followups'],exit=stop),'json':json,'outer':mock.Mock(side_effect=RuntimeError('inert private input'))}
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit) as ended:
            exec(compile(ast.Module(body=[entrypoint],type_ignores=[]),'owned-browser-entrypoint','exec'),namespace)
        self.assertEqual(ended.exception.code,1);self.assertEqual(json.loads(output.getvalue()),{'refused':True,'stage':'browser-controller'})

    def test_actual_immutable_build_inputs_join_the_derived_hosted_tree_and_refuse_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();server=root/'server';server.write_bytes(b'inert');web=root/'web';web.mkdir();(web/'index.html').write_bytes(b'inert primary');hosted=root/'hosted-web';hosted.mkdir();(hosted/'index.html').write_bytes(b'inert hosted');(hosted/'qualified-hosted-mode.js').write_bytes(b'inert SDK probe')
            first=qualification.browser_input_hashes(str(server),str(web));(hosted/'qualified-hosted-mode.js').write_bytes(b'changed')
            self.assertNotEqual(first,qualification.browser_input_hashes(str(server),str(web)))
            alias=root/'alias';alias.symlink_to(hosted,target_is_directory=True)
            with self.assertRaises(RuntimeError): qualification.browser_input_hashes(str(server),str(alias))
            (hosted/'unsafe').symlink_to(server)
            with self.assertRaises(RuntimeError): qualification.browser_input_hashes(str(server),str(web))

    def test_cleanup_retains_fixture_until_all_browser_owners_and_source_join(self):
        for mode in ['safe','missing','unsafe','source','selection','live','cleanup']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                evidence=Path(directory);fixture=Path(tempfile.mkdtemp(prefix='bc-vb-',dir='/tmp'));(fixture/'retained').write_bytes(b'inert owned')
                try:
                    (evidence/'namespace-cleanup.json').write_text(json.dumps({'remaining':[],'controllerReaped':True}))
                    result={'selection':'release-visual-browser-followups','source':'a'*40,'browserFollowupFixtureSafeToDelete':True,'childProcessesClosed':True,'cleanupFailures':[]}
                    if mode=='missing':result.pop('browserFollowupFixtureSafeToDelete')
                    if mode=='unsafe':result['browserFollowupFixtureSafeToDelete']=False
                    if mode=='source':result['source']='b'*40
                    if mode=='selection':result['selection']='release-visual-core'
                    if mode=='live':result['childProcessesClosed']=False
                    if mode=='cleanup':result['cleanupFailures']=[{}]
                    (evidence/'result.json').write_text(json.dumps(result))
                    with mock.patch.dict(os.environ,{'GITHUB_SHA':'a'*40}):deleted=qualification.cleanup_ui_fixture(fixture,evidence,{'supervisorReaped':True},'release-visual-browser-followups')
                    self.assertEqual(deleted,mode=='safe');self.assertEqual(fixture.exists(),mode!='safe')
                finally:shutil.rmtree(fixture,ignore_errors=True)


class LifecycleAdoptedReaperTests(unittest.TestCase):
    def test_unassigned_controller_callbacks_cannot_reap_any_process(self):
        children = mock.Mock(return_value=[(42, 'Z'), (57, 'Z')]); waitpid = mock.Mock()
        current = [None]
        reap = qualification.lifecycle_adopted_reaper(lambda: current[0], children, waitpid)
        reap(signal.SIGCHLD, None)
        children.assert_not_called(); waitpid.assert_not_called()
        current[0] = types.SimpleNamespace(pid=42)
        reap()
        self.assertEqual(waitpid.call_args_list, [mock.call(57, os.WNOHANG)])

    def test_specific_zombies_only_excluding_controller_and_reparent_races(self):
        children = mock.Mock(return_value=[(42, 'Z'), (57, 'Z'), (59, 'S'), (61, 'Z')])
        def waitpid(pid, flags):
            self.assertEqual(flags, os.WNOHANG)
            if pid == 61: raise ChildProcessError()
            return (0, 0)  # The observation raced with reparent/exit; never block or signal.
        waits = mock.Mock(side_effect=waitpid)
        reap = qualification.lifecycle_adopted_reaper(lambda: types.SimpleNamespace(pid=42), children, waits)
        reap(signal.SIGCHLD, None)
        self.assertEqual(waits.call_args_list, [mock.call(57, os.WNOHANG), mock.call(61, os.WNOHANG)])
        children.side_effect = ProcessLookupError()
        reap()  # A disappearing namespace entry cannot replace the controller's result.

    def test_actual_inner_handler_covers_assignment_and_early_or_late_adoption_without_stealing_status(self):
        for scenario, timing in [(scenario, timing) for scenario in ['release-visual-project-lifecycle', 'release-visual-settings-followups'] for timing in ['before-install', 'during-assignment', 'during-wait']]:
            with self.subTest(scenario=scenario, timing=timing), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve(); fixture = root / 'fixture'; fixture.mkdir(); evidence = root / 'evidence'; evidence.mkdir(); web = root / 'web'; web.mkdir()
                handlers = {signal.SIGCHLD: 'original'}; states = {}; current = [None]; seen = []; tick = [0]; case = self
                original_readlink = qualification.os.readlink
                def readlink(path): return 'net:[private]' if str(path) == '/proc/self/ns/net' else original_readlink(path)
                def clock(): tick[0] += 10; return tick[0]
                if timing == 'before-install': states[57] = 'Z'
                def install(number, callback): handlers[number] = callback
                def waitpid(pid, flags):
                    self.assertEqual(flags, os.WNOHANG); self.assertNotEqual(pid, 42)
                    seen.append(pid); states.pop(pid, None); return pid, 0
                class FakeProcess:
                    pid = 42
                    status = None
                    def wait(self, timeout):
                        if timing == 'during-wait':
                            states[57] = 'Z'
                            if callable(handlers[signal.SIGCHLD]): handlers[signal.SIGCHLD](signal.SIGCHLD, None)
                        case.assertNotIn(57, states)  # Producer must see the hook reaped before its own exit.
                        self.status = 23; states.pop(42, None); return self.status
                    def poll(self): return self.status
                def popen(*args, **kwargs):
                    if timing == 'during-assignment':
                        states[42] = 'Z'; states[57] = 'Z'
                        if callable(handlers[signal.SIGCHLD]): handlers[signal.SIGCHLD](signal.SIGCHLD, None)
                        self.assertEqual(seen, [])
                    process = FakeProcess(); current[0] = process; return process
                with mock.patch.object(qualification.os, 'getpid', return_value=1), \
                     mock.patch.object(qualification.os, 'readlink', side_effect=readlink), \
                     mock.patch.object(qualification.signal, 'getsignal', side_effect=lambda number: handlers[number]), \
                     mock.patch.object(qualification.signal, 'signal', side_effect=install), \
                     mock.patch.object(qualification.os, 'waitpid', side_effect=waitpid), \
                     mock.patch.object(qualification, 'namespace_children', side_effect=lambda: list(states.items())), \
                     mock.patch.object(qualification, 'network_environment', return_value={}), \
                     mock.patch.object(qualification, 'run_ip', return_value='[]'), \
                     mock.patch.object(qualification, 'prepare_tools'), \
                     mock.patch.object(qualification.subprocess, 'Popen', side_effect=popen), \
                     mock.patch.object(qualification, 'reap_children'), \
                     mock.patch.object(qualification.time, 'monotonic', side_effect=clock), \
                     mock.patch.object(qualification.os, 'kill') as kill:
                    status = qualification.inner(evidence, fixture, 'node', 'server', 'chrome', 'driver', 'git', 'dirname', 'net:[host]', 'a' * 40, 'ip', scenario, str(web))
                self.assertEqual(status, 23)
                self.assertEqual(seen, [57]); kill.assert_not_called()
                self.assertEqual(handlers[signal.SIGCHLD], 'original')
                self.assertEqual(json.loads((evidence / 'namespace-cleanup.json').read_text())['remaining'], [])


class FixturePathBudgetTests(unittest.TestCase):
    def actual_paths(self, scenario, run_id):
        module = ast.parse(SOURCE.read_text())
        outer = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'outer')
        assignments = [node for node in outer.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in ['fixture', 'evidence'] for target in node.targets)]
        self.assertEqual(len(assignments), 2)
        scope = {'Path': Path, 'selection': qualification.scenario_settings(scenario), 'run_id': run_id,
                 'uuid': types.SimpleNamespace(uuid4=lambda: types.SimpleNamespace(hex='a' * 32)),
                 'os': types.SimpleNamespace(environ={'RUNNER_TEMP': '/owned-evidence'})}
        exec(compile(ast.Module(body=assignments, type_ignores=[]), 'actual-private-root-producer', 'exec'), scope)
        return scope['fixture'], scope['evidence']

    def test_actual_roots_fit_branded_and_unbranded_chromium_unix_socket_paths(self):
        # Chromium branch 8037 FormatTemporaryFileName + SingletonSocket; Linux sun_path[108].
        # Portable SetupSockAddr requires byte length below 108, including room for NUL.
        for scenario in ['remote-updates-ui', 'chat-upload', 'delivery-retry-ui', 'release-visual-core', 'release-visual-settings', 'release-visual-git-project', 'release-visual-cursor-question', 'release-visual-workspace-substates', 'release-visual-provider-chat']:
            for run_id in ['37096649000', '9' * 20, '9' * 128]:
                fixture, _ = self.actual_paths(scenario, run_id)
                for brand in ['com.google.Chrome', 'org.chromium.Chromium']:
                    with self.subTest(scenario=scenario, run_digits=len(run_id), brand=brand):
                        socket = fixture / (brand + '.XXXXXX') / 'SingletonSocket'
                        self.assertLess(len(str(socket).encode('utf8')), 108)

    def test_only_private_root_omits_run_id_while_evidence_keeps_it(self):
        for scenario in ['chat-upload', 'remote-updates-ui', 'delivery-retry-ui', 'release-visual-core', 'release-visual-settings', 'release-visual-git-project', 'release-visual-cursor-question', 'release-visual-workspace-substates', 'release-visual-provider-chat']:
            selection = qualification.scenario_settings(scenario)
            roots = []
            for run_id in ['37096649000', '9' * 128]:
                fixture, evidence = self.actual_paths(scenario, run_id)
                self.assertEqual(fixture, Path('/tmp') / (selection['fixture_prefix'] + 'a' * 32))
                self.assertEqual(evidence, Path('/owned-evidence') / (selection['evidence_prefix'] + run_id))
                roots.append(fixture)
            self.assertEqual(roots[0], roots[1])

    def test_actual_private_directory_creation_stays_exclusive_and_0700(self):
        module = ast.parse(SOURCE.read_text())
        outer = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'outer')
        expression = next(node.value for node in outer.body if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute) and isinstance(node.value.func.value, ast.Name) and node.value.func.value.id == 'fixture' and node.value.func.attr == 'mkdir')
        with tempfile.TemporaryDirectory(prefix='bibcode-private-root-mode-') as directory:
            fixture = Path(directory) / 'owned'
            create = lambda: eval(compile(ast.Expression(expression), 'actual-private-root-create', 'eval'), {'fixture': fixture})
            create()
            self.assertEqual(fixture.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(FileExistsError): create()


class ScenarioSelectionTests(unittest.TestCase):
    def test_lifecycle_cleanup_preserves_private_state_until_exact_restoration_and_all_owners_join(self):
        for mode in ['missing', 'false', 'wrong-selection', 'wrong-source', 'live-child', 'cleanup-failure', 'malformed', 'safe']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as evidence_dir:
                evidence = Path(evidence_dir)
                fixture = Path(tempfile.mkdtemp(prefix='bc-vl-unit-', dir='/tmp'))
                try:
                    (evidence / 'namespace-cleanup.json').write_text(json.dumps({'remaining': [], 'controllerReaped': True}))
                    result = {'selection': 'release-visual-project-lifecycle', 'source': 'a' * 40,
                              'projectLifecycleFixtureSafeToDelete': True, 'childProcessesClosed': True, 'cleanupFailures': []}
                    if mode == 'missing': result.pop('projectLifecycleFixtureSafeToDelete')
                    if mode == 'false': result['projectLifecycleFixtureSafeToDelete'] = False
                    if mode == 'wrong-selection': result['selection'] = 'release-visual-core'
                    if mode == 'wrong-source': result['source'] = 'b' * 40
                    if mode == 'live-child': result['childProcessesClosed'] = False
                    if mode == 'cleanup-failure': result['cleanupFailures'] = [{}]
                    (evidence / 'result.json').write_text('invalid' if mode == 'malformed' else json.dumps(result))
                    with mock.patch.dict(os.environ, {'GITHUB_SHA': 'a' * 40}):
                        deleted = qualification.cleanup_ui_fixture(fixture, evidence, {'supervisorReaped': True}, 'release-visual-project-lifecycle')
                    self.assertEqual(deleted, mode == 'safe')
                    self.assertEqual(fixture.exists(), mode != 'safe')
                finally:
                    shutil.rmtree(fixture, ignore_errors=True)

    def test_project_lifecycle_has_fixed_controller_bounds_and_exact_owner_payload(self):
        self.assertEqual(qualification.scenario_settings('release-visual-project-lifecycle'), {
            'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
            'inner_timeout': 600, 'outer_timeout': 660,
            'evidence_prefix': 'issue29-project-lifecycle-', 'fixture_prefix': 'bc-vl-',
        })
        self.assertEqual(qualification.inner_resources(['release-visual-project-lifecycle', '/owned/web']),
                         ('release-visual-project-lifecycle', None, '/owned/web', 'core'))
        for args in [['release-visual-project-lifecycle'], ['release-visual-project-lifecycle', '/owned/web', 'full'],
                     ['release-visual-project-lifecycle', '/owned/web', '']]:
            with self.assertRaisesRegex(RuntimeError, 'Unknown qualification owner payload'):
                qualification.inner_resources(args)

    def test_provider_chat_cleanup_requires_the_actual_safe_restoration_and_join_receipt(self):
        for mode in ['missing', 'false', 'wrong-selection', 'wrong-source', 'live-child', 'cleanup-failure', 'malformed', 'safe']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as evidence_dir:
                evidence = Path(evidence_dir)
                fixture = Path(tempfile.mkdtemp(prefix='bc-vp-unit-', dir='/tmp'))
                try:
                    (evidence / 'namespace-cleanup.json').write_text(json.dumps({'remaining': [], 'controllerReaped': True}))
                    result = {'selection': 'release-visual-provider-chat', 'source': 'a' * 40,
                              'providerChatFixtureSafeToDelete': True, 'childProcessesClosed': True,
                              'cleanupFailures': []}
                    if mode == 'missing': result.pop('providerChatFixtureSafeToDelete')
                    if mode == 'false': result['providerChatFixtureSafeToDelete'] = False
                    if mode == 'wrong-selection': result['selection'] = 'release-visual-core'
                    if mode == 'wrong-source': result['source'] = 'b' * 40
                    if mode == 'live-child': result['childProcessesClosed'] = False
                    if mode == 'cleanup-failure': result['cleanupFailures'] = [{}]
                    (evidence / 'result.json').write_text('invalid' if mode == 'malformed' else json.dumps(result))
                    with mock.patch.dict(os.environ, {'GITHUB_SHA': 'a' * 40}):
                        deleted = qualification.cleanup_ui_fixture(fixture, evidence, {'supervisorReaped': True}, 'release-visual-provider-chat')
                    self.assertEqual(deleted, mode == 'safe')
                    self.assertEqual(fixture.exists(), mode != 'safe')
                finally:
                    shutil.rmtree(fixture, ignore_errors=True)
    def test_provider_chat_has_fixed_seven_row_owner_and_unchanged_bounds(self):
        self.assertEqual(qualification.scenario_settings('release-visual-provider-chat'), {
            'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
            'inner_timeout': 600, 'outer_timeout': 660,
            'evidence_prefix': 'issue29-provider-chat-', 'fixture_prefix': 'bc-vp-',
        })
        self.assertEqual(qualification.inner_resources(['release-visual-provider-chat', '/owned/web']),
                         ('release-visual-provider-chat', None, '/owned/web', 'core'))
        for args in [['release-visual-provider-chat'], ['release-visual-provider-chat', '/owned/web', 'full']]:
            with self.assertRaisesRegex(RuntimeError, 'Unknown qualification owner payload'):
                qualification.inner_resources(args)
    def test_workspace_substates_have_fixed_bounds_and_exact_owner_payload(self):
        self.assertEqual(qualification.scenario_settings('release-visual-workspace-substates'), {
            'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
            'inner_timeout': 600, 'outer_timeout': 660,
            'evidence_prefix': 'issue29-workspace-substates-', 'fixture_prefix': 'bc-vw-',
        })
        self.assertEqual(qualification.inner_resources(['release-visual-workspace-substates', '/owned/web']),
                         ('release-visual-workspace-substates', None, '/owned/web', 'core'))
        for args in [['release-visual-workspace-substates'], ['release-visual-workspace-substates', '/owned/web', 'full']]:
            with self.assertRaisesRegex(RuntimeError, 'Unknown qualification owner payload'):
                qualification.inner_resources(args)

    def test_cursor_question_selection_is_separate_fixed_and_owned(self):
        self.assertEqual(qualification.scenario_settings('release-visual-cursor-question'), {
            'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
            'inner_timeout': 600, 'outer_timeout': 660,
            'evidence_prefix': 'issue29-cursor-question-', 'fixture_prefix': 'bc-vq-',
        })
        self.assertEqual(qualification.inner_resources(['release-visual-cursor-question', '/owned/web']),
                         ('release-visual-cursor-question', None, '/owned/web', 'core'))
        for args in [['release-visual-cursor-question'], ['release-visual-cursor-question', '/owned/web', 'full']]:
            with self.assertRaisesRegex(RuntimeError, 'Unknown qualification owner payload'):
                qualification.inner_resources(args)

    def test_settings_cleanup_keeps_private_state_until_the_existing_owner_joins(self):
        with tempfile.TemporaryDirectory() as evidence_dir:
            evidence = Path(evidence_dir)
            fixture = Path(tempfile.mkdtemp(prefix='bc-vs-unit-', dir='/tmp'))
            try:
                (evidence / 'namespace-cleanup.json').write_text(json.dumps({'remaining': [], 'controllerReaped': True}))
                self.assertFalse(qualification.cleanup_ui_fixture(fixture, evidence, {'supervisorReaped': False}, 'release-visual-settings'))
                self.assertFalse(qualification.cleanup_ui_fixture(fixture, evidence, {'supervisorReaped': True}, 'release-visual-core'))
                self.assertTrue(fixture.exists())
                self.assertTrue(qualification.cleanup_ui_fixture(fixture, evidence, {'supervisorReaped': True}, 'release-visual-settings'))
                self.assertFalse(fixture.exists())
            finally:
                shutil.rmtree(fixture, ignore_errors=True)
    def test_settings_visual_batch_is_a_separate_fixed_four_pair_owner_selection(self):
        self.assertEqual(qualification.scenario_settings('release-visual-settings'), {
            'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
            'inner_timeout': 600, 'outer_timeout': 660,
            'evidence_prefix': 'issue29-settings-', 'fixture_prefix': 'bc-vs-',
        })
        self.assertEqual(qualification.inner_resources(['release-visual-settings', '/owned/web']),
                         ('release-visual-settings', None, '/owned/web', 'core'))
        for arguments in [['release-visual-settings'], ['release-visual-settings', '/owned/web', 'full']]:
            with self.assertRaisesRegex(RuntimeError, 'Unknown qualification owner payload'):
                qualification.inner_resources(arguments)

    def test_git_project_visual_selection_has_fixed_controller_bounds_and_exact_owner_payload(self):
        self.assertEqual(qualification.scenario_settings('release-visual-git-project'), {
            'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
            'inner_timeout': 600, 'outer_timeout': 660,
            'evidence_prefix': 'issue29-git-project-', 'fixture_prefix': 'bc-vg-',
        })
        self.assertEqual(qualification.inner_resources(['release-visual-git-project', '/owned/web']),
                         ('release-visual-git-project', None, '/owned/web', 'core'))
        for arguments in [['release-visual-git-project'], ['release-visual-git-project', '/owned/web', 'full']]:
            with self.assertRaisesRegex(RuntimeError, 'Unknown qualification owner payload'):
                qualification.inner_resources(arguments)

    def test_first_visual_batch_reuses_the_managed_worktree_controller_and_original_bounds(self):
        try:
            selected = qualification.scenario_settings('release-visual-core')
        except RuntimeError:
            selected = None
        self.assertEqual(selected, {
            'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
            'inner_timeout': 600, 'outer_timeout': 660,
            'evidence_prefix': 'issue29-core-', 'fixture_prefix': 'bc-vc-',
        })

    def test_first_visual_batch_requires_its_exact_two_argument_owner_payload(self):
        self.assertEqual(qualification.inner_resources(['release-visual-core', '/owned/web']),
                         ('release-visual-core', None, '/owned/web', 'core'))
        for arguments in [['release-visual-core'], ['release-visual-core', '/owned/web', 'full']]:
            with self.assertRaisesRegex(RuntimeError, 'Unknown qualification owner payload'):
                qualification.inner_resources(arguments)

    def test_visual_fixture_cleanup_refuses_live_children_and_cross_scenario_roots(self):
        with tempfile.TemporaryDirectory() as evidence_dir:
            evidence = Path(evidence_dir)
            fixture = Path(tempfile.mkdtemp(prefix='bc-vc-unit-', dir='/tmp'))
            try:
                (evidence / 'namespace-cleanup.json').write_text(json.dumps({'remaining': [[7, 'S']], 'controllerReaped': True}))
                self.assertFalse(qualification.cleanup_ui_fixture(fixture, evidence, {'supervisorReaped': True}, 'release-visual-core'))
                (evidence / 'namespace-cleanup.json').write_text(json.dumps({'remaining': [], 'controllerReaped': True}))
                self.assertFalse(qualification.cleanup_ui_fixture(fixture, evidence, {'supervisorReaped': True}, 'delivery-retry-ui'))
                self.assertTrue(fixture.exists())
                self.assertTrue(qualification.cleanup_ui_fixture(fixture, evidence, {'supervisorReaped': True}, 'release-visual-core'))
                self.assertFalse(fixture.exists())
            finally:
                shutil.rmtree(fixture, ignore_errors=True)

    def test_delivery_retry_has_a_fixed_bounded_entrypoint_without_fake_host(self):
        try:
            selected = qualification.scenario_settings('delivery-retry-ui')
        except RuntimeError:
            selected = None
        self.assertEqual(selected, {
            'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts',
            'inner_timeout': 600, 'outer_timeout': 660,
            'evidence_prefix': 'issue19-delivery-', 'fixture_prefix': 'bc-dr-',
        })

    def test_delivery_build_receipt_needs_only_real_server_and_immutable_web(self):
        with tempfile.TemporaryDirectory(prefix='delivery-inputs-') as directory:
            root = Path(directory)
            server = root / 'server'; server.write_bytes(b'owned-server')
            web = root / 'web'; web.mkdir(); (web / 'index.html').write_text('owned-web')
            result = qualification.ui_input_hashes(server, None, web)
            self.assertEqual(set(result), {'serverSha256', 'webSha256', 'webFiles'})
            self.assertEqual(result['webFiles'], 1)

    def test_ui_build_receipt_contains_hashes_and_counts_without_paths(self):
        with tempfile.TemporaryDirectory(prefix='bibcode-ui-inputs-') as directory:
            root = Path(directory)
            server, fake, web = root / 'private-server', root / 'private-fake', root / 'private-web'
            server.write_bytes(b'owned-server'); fake.write_bytes(b'owned-fake'); web.mkdir()
            (web / 'index.html').write_text('owned-public-web')
            first = qualification.ui_input_hashes(server, fake, web)
            self.assertEqual(first['webFiles'], 1)
            self.assertNotIn('private', json.dumps(first))
            (web / 'index.html').write_text('changed-public-web')
            second = qualification.ui_input_hashes(server, fake, web)
            self.assertNotEqual(first['webSha256'], second['webSha256'])
            self.assertEqual(first['serverSha256'], second['serverSha256'])

    def test_ui_private_fixture_deletes_only_after_owned_namespace_and_supervisor_join(self):
        with tempfile.TemporaryDirectory(prefix='bibcode-ui-evidence-') as evidence_dir:
            evidence = Path(evidence_dir)
            fixture = Path(tempfile.mkdtemp(prefix='bibcode-remote-ui-unit-', dir='/tmp'))
            try:
                (fixture / 'private-credential').write_text('secret')
                supervisor = {'supervisorReaped': True}
                (evidence / 'namespace-cleanup.json').write_text(json.dumps({'remaining': [], 'controllerReaped': True}))
                self.assertFalse(qualification.cleanup_ui_fixture(fixture, evidence, {'supervisorReaped': False}))
                self.assertTrue(fixture.exists())
                (evidence / 'namespace-cleanup.json').write_text(json.dumps({'remaining': [[7, 'S']], 'controllerReaped': True}))
                self.assertFalse(qualification.cleanup_ui_fixture(fixture, evidence, supervisor))
                self.assertTrue(fixture.exists())
                (evidence / 'namespace-cleanup.json').write_text(json.dumps({'remaining': [], 'controllerReaped': True}))
                self.assertTrue(qualification.cleanup_ui_fixture(fixture, evidence, supervisor))
                self.assertFalse(fixture.exists())
            finally:
                shutil.rmtree(fixture, ignore_errors=True)

    def test_ui_matrix_selection_is_closed_before_any_host_action(self):
        self.assertEqual(qualification.ui_matrix_selection('core'), 'core')
        self.assertEqual(qualification.ui_matrix_selection('full'), 'full')
        for value in ['', 'FULL', 'private-secret', 'core --override']:
            with mock.patch.object(qualification, 'host_programs') as programs:
                with self.assertRaisesRegex(RuntimeError, 'Unknown remote UI selection'):
                    qualification.outer('remote-updates-ui', value)
                programs.assert_not_called()

    def test_default_smoke_retains_its_controller_and_deadlines(self):
        selection = qualification.scenario_settings('chat-upload')
        self.assertEqual(selection['controller'], 'apps/desktop/e2e/qualify-chat-uploads.ts')
        self.assertEqual((selection['inner_timeout'], selection['outer_timeout']), (600, 660))

    def test_remote_ui_has_a_separate_closed_controller_and_real_deadline_budget(self):
        selection = qualification.scenario_settings('remote-updates-ui')
        self.assertEqual(selection['controller'], 'apps/desktop/e2e/qualify-remote-updates.ts')
        self.assertEqual((selection['inner_timeout'], selection['outer_timeout']), (1800, 1860))
        self.assertEqual(selection['evidence_prefix'], 'issue16-ui-')

    def test_arbitrary_controller_input_is_refused_before_host_actions(self):
        for name in ['', '../private-controller.ts', 'remote-updates-ui --override', 'unknown']:
            with self.subTest(name=name), mock.patch.object(qualification, 'host_programs') as programs:
                with self.assertRaisesRegex(RuntimeError, 'Unknown qualification scenario'):
                    qualification.outer(name)
                programs.assert_not_called()


class SupervisorTests(unittest.TestCase):
    def test_actual_controller_log_is_exclusive_0600_even_with_permissive_umask(self):
        module = ast.parse(SOURCE.read_text())
        inner = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'inner')
        expression = next(item.context_expr for node in ast.walk(inner) if isinstance(node, ast.With) for item in node.items if 'private-controller.log' in ast.unparse(item.context_expr))
        with tempfile.TemporaryDirectory(prefix='bibcode-ui-log-mode-') as directory:
            fixture = Path(directory)
            previous = os.umask(0)
            try:
                def open_actual():
                    return eval(compile(ast.Expression(expression), 'actual-private-log', 'eval'), {'fixture': fixture, 'os': os})
                with open_actual() as output:
                    output.write(b'owned-private-output')
                path = fixture / 'private-controller.log'
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    open_actual()
                self.assertEqual(path.read_bytes(), b'owned-private-output')
            finally:
                os.umask(previous)

    def test_preflight_cancellation_does_not_start_another_owned_probe(self):
        cancelled = {'exitCode': 143, 'timedOut': False, 'cancelledSignal': signal.SIGTERM, 'supervisorReaped': True}
        succeeded = {'exitCode': 0, 'timedOut': False, 'cancelledSignal': None, 'supervisorReaped': True}
        with mock.patch.object(qualification, 'host_programs', return_value={'unshare': '/unshare', 'ip': '/ip'}), \
             mock.patch.object(qualification.subprocess, 'check_output', return_value='--keep-caps'), \
             mock.patch.object(qualification.os, 'readlink', return_value='net:[owned-test-host]'), \
             mock.patch.object(qualification, 'run_owned_command', side_effect=[(cancelled, b''), (succeeded, b'')]) as run, \
             contextlib.redirect_stdout(io.StringIO()):
            result = qualification.preflight()
        self.assertEqual(result, 143)
        self.assertEqual(run.call_count, 1)

    def test_actual_generated_provider_enters_app_server_under_restricted_path(self):
        node = qualification.resolve_node_runtime()
        helper = SOURCE.parent.parent / 'apps/desktop/e2e/support/test-project.ts'
        with tempfile.TemporaryDirectory(prefix='bibcode-upload-launcher-') as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            env = {'HOME': str(root), 'PATH': '/usr/bin:/bin',
                   'BIBCODE_E2E_RUN_ROOT': str(root / 'run'),
                   'BIBCODE_E2E_ARTIFACT_DIR': str(root / 'private'),
                   'BIBCODE_E2E_PLATFORM': 'linux'}
            code = 'import { prepareDesktopUiTestContext } from ' + json.dumps(helper.as_uri()) + '; prepareDesktopUiTestContext();'
            subprocess.run([node, '--input-type=module', '-e', code], env=env, check=True,
                           capture_output=True, timeout=15)
            qualification.prepare_tools(root, node, shutil.which('git'), shutil.which('dirname'))
            env['PATH'] = str(root / 'run/provider-shims') + os.pathsep + str(root / 'bin')
            result = subprocess.run([str(root / 'run/provider-shims/codex'), 'app-server'], env=env,
                                    input='{"id":1,"method":"initialize","params":{}}\n',
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            messages = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(messages[0]['result']['userAgent'], 'bibcode-ui-fixture')

    def test_resolved_node_runs_with_private_home_without_its_manager_shim(self):
        node = qualification.resolve_node_runtime()
        with tempfile.TemporaryDirectory(prefix='issue28-node-') as root:
            output = subprocess.check_output([node, '-p', 'process.execPath'], text=True,
                                             env={'HOME': root, 'PATH': '/usr/bin:/bin'}, timeout=5).strip()
            self.assertEqual(str(Path(output).resolve()), node)

    def test_cancellation_between_spawn_and_handle_publication(self):
        create = subprocess.Popen
        owned = []

        def signal_after_spawn(*args, **kwargs):
            child = create(*args, **kwargs)
            owned.append(child)
            os.kill(os.getpid(), signal.SIGTERM)
            return child

        try:
            with mock.patch.object(qualification.subprocess, 'Popen', signal_after_spawn):
                result, _ = qualification.run_owned_command(
                    [sys.executable, '-c', 'import time;time.sleep(30)'], grace=.2)
            self.assertEqual(result['cancelledSignal'], signal.SIGTERM)
            self.assertTrue(result['supervisorReaped'])
            self.assertEqual(len(owned), 1)
            self.assertIsNotNone(owned[0].poll())
        finally:
            for child in owned:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)

    def test_exit_and_output(self):
        result, output = qualification.run_owned_command([sys.executable, '-c', 'print("done")'])
        self.assertEqual(result['exitCode'], 0)
        self.assertTrue(result['supervisorReaped'])
        self.assertEqual(output, b'done\n')

    def test_timeout_kills_and_reaps_term_ignoring_child(self):
        with tempfile.TemporaryDirectory(prefix='issue28-supervisor-') as root:
            pid_path = Path(root) / 'pid'
            child = 'import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path(' + repr(str(pid_path)) + ').write_text(str(os.getpid()));time.sleep(30)'
            result, _ = qualification.run_owned_command([sys.executable, '-c', child], timeout=.4, grace=.2)
            self.assertEqual(result['exitCode'], 124)
            self.assertTrue(result['timedOut'])
            self.assertTrue(result['supervisorReaped'])
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid_path.read_text()), 0)

    def test_term_enters_cleanup_and_retains_cancellation(self):
        with tempfile.TemporaryDirectory(prefix='issue28-supervisor-') as root:
            pid_path = Path(root) / 'child.pid'
            report = Path(root) / 'result.json'
            child = 'import os,signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path(' + repr(str(pid_path)) + ').write_text(str(os.getpid()));time.sleep(30)'
            parent = '\n'.join([
                'import importlib.util,json,sys',
                'from pathlib import Path',
                's=importlib.util.spec_from_file_location("q",' + repr(str(SOURCE)) + ')',
                'q=importlib.util.module_from_spec(s);s.loader.exec_module(q)',
                'r,_=q.run_owned_command([sys.executable,"-c",' + repr(child) + '],timeout=30,grace=.2)',
                'Path(' + repr(str(report)) + ').write_text(json.dumps(r))',
            ])
            owner = subprocess.Popen([sys.executable, '-c', parent], start_new_session=True)
            try:
                deadline = time.monotonic() + 5
                while not pid_path.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(pid_path.exists(), 'child did not start')
                owner.send_signal(signal.SIGTERM)
                owner.wait(timeout=5)
                result = json.loads(report.read_text())
                self.assertEqual(result['cancelledSignal'], signal.SIGTERM)
                self.assertEqual(result['exitCode'], 143)
                self.assertTrue(result['supervisorReaped'])
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(pid_path.read_text()), 0)
            finally:
                if owner.poll() is None:
                    owner.kill()
                    owner.wait(timeout=5)
                if pid_path.exists():
                    try:
                        os.kill(int(pid_path.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass





class NetworkHandoffTests(unittest.TestCase):
    def test_only_owned_pid1_publishes_resolved_namespace_helper_configuration(self):
        values = {'net': 'net:[2]', 'pid': 'pid:[3]', 'user': 'user:[4]'}
        real_readlink = os.readlink
        with mock.patch.object(qualification.os, 'getpid', return_value=1), mock.patch.object(qualification.os, 'readlink', side_effect=lambda path: values[str(path).rsplit('/', 1)[1]] if str(path).startswith('/proc/') else real_readlink(path)):
            env = qualification.network_environment('net:[1]', sys.executable)
        self.assertEqual(env['BIBCODE_UPLOAD_HOST_NETNS'], 'net:[1]')
        self.assertEqual(env['BIBCODE_UPLOAD_NETNS'], 'net:[2]')
        self.assertEqual(env['BIBCODE_UPLOAD_PIDNS'], 'pid:[3]')
        self.assertEqual(env['BIBCODE_UPLOAD_USERNS'], 'user:[4]')
        self.assertTrue(Path(env['BIBCODE_UPLOAD_PYTHON']).is_absolute())
        self.assertEqual(env['BIBCODE_UPLOAD_NETWORK_HELPER'], str(SOURCE.resolve()))
    def test_non_pid1_or_same_as_host_never_publishes_helper_configuration(self):
        with mock.patch.object(qualification.os, 'getpid', return_value=2):
            with self.assertRaises(RuntimeError): qualification.network_environment('net:[1]', sys.executable)
        with mock.patch.object(qualification.os, 'getpid', return_value=1), mock.patch.object(qualification.os, 'readlink', return_value='net:[1]'):
            with self.assertRaises(RuntimeError): qualification.network_environment('net:[1]', sys.executable)


    def test_actual_helper_refusal_emits_only_the_closed_receipt(self):
        capture = io.StringIO()
        with mock.patch.dict(qualification.os.environ, {'CI': 'false', 'BIBCODE_UPLOAD_HOST_NETNS': 'secret'}), mock.patch.object(qualification, 'run_owned_command') as run, contextlib.redirect_stdout(capture):
            self.assertEqual(qualification.network(), 1)
        run.assert_not_called()
        receipt = json.loads(capture.getvalue())
        self.assertEqual(receipt, {'refused': True, 'failure': {'stage': 'platform-check', 'attemptedMutations': 0, 'completedMutations': 0, 'netAdminEffective': None, 'lastCommand': None}})
        self.assertNotIn('secret', capture.getvalue())

def owned_hosting_proofs(fixture, source):
    proofs = []
    for theme in ['light', 'dark']:
        root = (fixture / theme).resolve(); hosting = root / 'hosting'; binary = hosting / 'bin'
        for directory in [root, hosting, binary]: directory.mkdir(mode=0o700)
        frozen = {}
        for name in ['hosting/bin/gh', 'hosting/bin/glab', 'hosting/bin/release-visual-pull-requests-protocol.mjs', 'hosting/origins.gitconfig']:
            path = root / name; value = ('Owned source fixture ' + name).encode(); path.write_bytes(value); path.chmod(0o500 if '/bin/' in name else 0o600); frozen[name] = value
        state = b'{"labelApplied":false}'
        (hosting / 'host-state.json').write_bytes(state); (hosting / 'host-state.json').chmod(0o600)
        metadata = (hosting / 'host-state.json').stat()
        state_identity = 'host-state.json\0' + str(metadata.st_dev) + ':' + str(metadata.st_ino) + ':' + str(metadata.st_uid) + ':' + str(metadata.st_mode & 0o777) + '\n'
        records = [{'kind': 'labels', 'provider': 'github', 'number': 43, 'success': True, 'bodySha256': None, 'mutation': mutation, 'stateSha256': hashlib.sha256(b'{"labelApplied":true}' if mutation == 'label-add' else state).hexdigest(), 'stateIdentitySha256': hashlib.sha256(state_identity.encode()).hexdigest()} for mutation in ['label-add', 'label-remove']]
        calls = ''.join(json.dumps(record) + '\n' for record in records).encode()
        (hosting / 'host-calls.jsonl').write_bytes(calls); (hosting / 'host-calls.jsonl').chmod(0o600)
        config = {'root': str(root), 'sourceSha': source, 'uid': os.getuid(), 'projects': {}, 'exchanges': {'github': [{'kind': 'labels', 'number': 43, 'exitCode': 0}], 'gitlab': []}, 'state': str(hosting / 'host-state.json'), 'calls': str(hosting / 'host-calls.jsonl')}
        value = json.dumps(config).encode(); (hosting / 'hosting-config.json').write_bytes(value); (hosting / 'hosting-config.json').chmod(0o600); frozen['hosting/hosting-config.json'] = value
        joined = ''.join(name + '\0' + hashlib.sha256(frozen[name]).hexdigest() + '\n' for name in sorted(frozen)).encode()
        identity = ''.join(name + '\0' + str((hosting / name).stat().st_dev) + ':' + str((hosting / name).stat().st_ino) + ':' + str((hosting / name).stat().st_uid) + ':' + str((hosting / name).stat().st_mode & 0o777) + '\n' for name in ['host-state.json', 'host-calls.jsonl'])
        proofs.append({'mutableFilesIdentitySha256': hashlib.sha256(identity.encode()).hexdigest(), 'source': source, 'theme': theme, 'baselineRestored': True, 'undoCompleted': True, 'inputsUnchanged': True, 'ownedProcessesJoined': True, 'configSha256': hashlib.sha256(value).hexdigest(), 'hostingInputsSha256': hashlib.sha256(joined).hexdigest(), 'baselineStateSha256': hashlib.sha256(state).hexdigest(), 'completionLogSha256': hashlib.sha256(calls).hexdigest()})
    return proofs

class PullRequestsContainment(unittest.TestCase):
    def test_exact_selector_uses_original_controller_and_fixed_budgets(self):
        selected = qualification.scenario_settings('release-visual-pull-requests')
        self.assertEqual(selected, {'controller': 'apps/desktop/e2e/qualify-delivery-retry.ts', 'inner_timeout': 600, 'outer_timeout': 660, 'evidence_prefix': 'issue29-pull-requests-', 'fixture_prefix': 'bc-vr-'})
        with self.assertRaises(RuntimeError):
            qualification.scenario_settings('release-visual-pull-requests-other')

    def test_cleanup_refuses_missing_false_or_mismatched_request_source_join(self):
        for mode in ['missing', 'false', 'source', 'cleanup', 'closed', 'missing-host', 'false-host', 'malformed-host', 'missing-inputs', 'false-inputs', 'malformed-inputs', 'missing-host-restoration', 'false-host-restoration', 'safe']:
            with self.subTest(mode=mode):
                with tempfile.TemporaryDirectory() as parent:
                    root = Path(parent); fixture = Path(tempfile.mkdtemp(prefix='bc-vr-', dir='/tmp')); evidence = root / 'evidence'
                    self.addCleanup(shutil.rmtree, fixture, ignore_errors=True); evidence.mkdir()
                    (evidence / 'namespace-cleanup.json').write_text(json.dumps({'remaining': [], 'controllerReaped': True}))
                    result = {'selection': 'release-visual-pull-requests', 'source': 'a' * 40, 'pullRequestsFixtureSafeToDelete': True, 'childProcessesClosed': True, 'cleanupFailures': [], 'pullRequestsHostingRestorationProofs': owned_hosting_proofs(fixture, 'a' * 40)}
                    if mode == 'missing': result.pop('pullRequestsFixtureSafeToDelete')
                    elif mode == 'false': result['pullRequestsFixtureSafeToDelete'] = False
                    elif mode == 'source': result['source'] = 'b' * 40
                    elif mode == 'cleanup': result['cleanupFailures'] = [{'role': 'owned', 'failure': 'refused'}]
                    elif mode == 'closed': result['childProcessesClosed'] = False
                    elif mode == 'missing-host-restoration': result.pop('pullRequestsHostingRestorationProofs', None)
                    elif mode == 'false-host-restoration': result['pullRequestsHostingRestorationProofs'] = []
                    (evidence / 'result.json').write_text(json.dumps(result))
                    supervisor = {'supervisorReaped': True, 'hostNetworkNamespaceUnchanged': True, 'buildInputsUnchanged': True}
                    if mode == 'missing-host': supervisor.pop('hostNetworkNamespaceUnchanged')
                    elif mode == 'false-host': supervisor['hostNetworkNamespaceUnchanged'] = False
                    elif mode == 'malformed-host': supervisor['hostNetworkNamespaceUnchanged'] = 1
                    elif mode == 'missing-inputs': supervisor.pop('buildInputsUnchanged')
                    elif mode == 'false-inputs': supervisor['buildInputsUnchanged'] = False
                    elif mode == 'malformed-inputs': supervisor['buildInputsUnchanged'] = 'true'
                    with mock.patch.dict(os.environ, {'GITHUB_SHA': 'a' * 40}):
                        actual = qualification.cleanup_ui_fixture(fixture, evidence, supervisor, 'release-visual-pull-requests')
                    self.assertEqual(actual, mode == 'safe'); self.assertEqual(fixture.exists(), mode != 'safe')

    def test_hosting_restoration_refuses_applied_foreign_malformed_or_substituted_retained_bytes(self):
        modes = ['applied', 'state-number', 'state-extra', 'state-symlink', 'state-hardlink', 'state-substitute', 'calls-substitute', 'calls-missing-undo', 'calls-failed-undo', 'calls-wrong-owner', 'calls-duplicate-field', 'source', 'theme', 'proof-extra', 'proof-false', 'config', 'input', 'pending-writer']
        for mode in modes:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='bc-vr-', dir='/tmp') as path:
                fixture = Path(path); proofs = owned_hosting_proofs(fixture, 'a' * 40)
                result = {'source': 'a' * 40, 'pullRequestsHostingRestorationProofs': proofs}
                hosting = (fixture / 'light' / 'hosting').resolve(); state = hosting / 'host-state.json'; calls = hosting / 'host-calls.jsonl'
                if mode == 'applied': state.write_text('{"labelApplied":true}')
                elif mode == 'state-number': state.write_text('{"labelApplied":0}')
                elif mode == 'state-extra': state.write_text('{"labelApplied":false,"foreign":false}')
                elif mode == 'state-symlink':
                    saved = hosting / 'saved'; state.rename(saved); state.symlink_to(saved)
                elif mode == 'state-hardlink': os.link(state, hosting / 'saved')
                elif mode in ['state-substitute', 'calls-substitute']:
                    target = state if mode == 'state-substitute' else calls
                    saved = target.with_name('substitute'); saved.write_bytes(target.read_bytes()); saved.chmod(0o600); saved.replace(target)
                elif mode.startswith('calls-'):
                    records = [json.loads(line) for line in calls.read_text().splitlines()]
                    if mode == 'calls-missing-undo': records.pop()
                    elif mode == 'calls-failed-undo': records[-1]['success'] = False
                    elif mode == 'calls-wrong-owner': records[-1]['provider'] = 'gitlab'
                    text = ''.join(json.dumps(record) + '\n' for record in records)
                    if mode == 'calls-duplicate-field': text = text.replace('"success": true', '"success": true, "success": true')
                    calls.write_text(text); proofs[0]['completionLogSha256'] = hashlib.sha256(text.encode()).hexdigest()
                elif mode == 'source': proofs[0]['source'] = 'b' * 40
                elif mode == 'theme': proofs[0]['theme'] = 'dark'
                elif mode == 'proof-extra': proofs[0]['foreign'] = True
                elif mode == 'proof-false': proofs[0]['undoCompleted'] = False
                elif mode == 'config': (hosting / 'hosting-config.json').write_text('{}')
                elif mode == 'input': (hosting / 'bin' / 'gh').chmod(0o600)
                elif mode == 'pending-writer': (hosting / 'host-state.json.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').write_text('{"labelApplied":false}')
                self.assertFalse(qualification.pull_requests_hosting_restored(fixture, result))
                self.assertTrue(fixture.exists())

if __name__ == '__main__':
    unittest.main()
