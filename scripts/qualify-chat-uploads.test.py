"""Real-process supervisor tests; no namespace, installer, or UI execution."""
import importlib.util
import ast
import contextlib
import io
import json
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
        for scenario in ['remote-updates-ui', 'chat-upload', 'delivery-retry-ui', 'release-visual-core', 'release-visual-settings', 'release-visual-git-project', 'release-visual-cursor-question']:
            for run_id in ['37096649000', '9' * 20, '9' * 128]:
                fixture, _ = self.actual_paths(scenario, run_id)
                for brand in ['com.google.Chrome', 'org.chromium.Chromium']:
                    with self.subTest(scenario=scenario, run_digits=len(run_id), brand=brand):
                        socket = fixture / (brand + '.XXXXXX') / 'SingletonSocket'
                        self.assertLess(len(str(socket).encode('utf8')), 108)

    def test_only_private_root_omits_run_id_while_evidence_keeps_it(self):
        for scenario in ['chat-upload', 'remote-updates-ui', 'delivery-retry-ui', 'release-visual-core', 'release-visual-settings', 'release-visual-git-project', 'release-visual-cursor-question']:
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

if __name__ == '__main__':
    unittest.main()
