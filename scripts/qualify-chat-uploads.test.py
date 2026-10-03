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
from types import SimpleNamespace
import unittest
from unittest import mock

SOURCE = Path(__file__).with_name('qualify-chat-uploads.py')
spec = importlib.util.spec_from_file_location('qualification', SOURCE)
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


class SupervisorTests(unittest.TestCase):
    def test_actual_budget_and_private_environment_producers_use_selected_case(self):
        module = ast.parse(SOURCE.read_text())
        inner = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'inner')
        outer = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'outer')
        wait = next(node for node in ast.walk(inner) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'wait')
        run = next(node for node in ast.walk(outer) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'run_owned_command')
        for mode, selected, expected in [('upload-smoke', None, (600, 660)), ('startup-only', None, (600, 660)), ('upload-matrix', 'noise-16-light-delivery', (1800, 1860))]:
            selection = qualification.case_settings(mode, selected)
            observed = []
            process = SimpleNamespace(wait=lambda **kwargs: observed.append(kwargs['timeout']))
            eval(compile(ast.Expression(wait), 'actual-inner-budget', 'eval'), {'process': process, 'selection': selection})
            eval(compile(ast.Expression(run), 'actual-outer-budget', 'eval'), {'command': ['owned'], 'selection': selection, 'run_owned_command': lambda *args, **kwargs: observed.append(kwargs['timeout'])})
            self.assertEqual(tuple(observed), expected)
        environment = next(node for node in ast.walk(inner) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'environment' for target in node.targets))
        scope = {'mode': 'upload-matrix', 'selection': qualification.case_settings('upload-matrix', 'noise-16-light-delivery'), 'Path': Path, 'fixture': Path('/owned/fixture'), 'evidence': Path('/owned/evidence'), 'node': '/owned/node', 'os': os, 'private_namespace': 'owned', 'server': '/owned/server', 'chrome': '/owned/chrome', 'driver': '/owned/driver', 'source': 'a' * 40, 'trusted_network': {}}
        exec(compile(ast.Module(body=[environment], type_ignores=[]), 'actual-matrix-environment', 'exec'), scope)
        self.assertEqual(scope['environment']['BIBCODE_UPLOAD_CASE'], 'noise-16-light-delivery')
        self.assertEqual(scope['environment']['BIBCODE_UPLOAD_MODE'], 'upload-matrix')

    def test_actual_root_admission_remains_exclusive_private_and_evidence_run_id_is_separate(self):
        source = SOURCE.read_text()
        module = ast.parse(source)
        outer = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'outer')
        admissions = [node for node in ast.walk(outer) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'mkdir']
        self.assertEqual(len(admissions), 2)
        for call in admissions:
            self.assertEqual({entry.arg: ast.literal_eval(entry.value) for entry in call.keywords}, {'mode': 0o700, 'exist_ok': False})
        evidence = next(node for node in ast.walk(outer) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'evidence' for target in node.targets))
        scope = {'Path': Path, 'os': SimpleNamespace(environ={'RUNNER_TEMP': '/owned/evidence'}), 'run_id': '1234567890'}
        exec(compile(ast.Module(body=[evidence], type_ignores=[]), 'actual-evidence-producer', 'exec'), scope)
        self.assertEqual(scope['evidence'], Path('/owned/evidence/issue17-browser-1234567890'))
        self.assertIn("'--fork', '--kill-child', sys.executable, __file__, 'inner'", source)

    def test_matrix_cases_use_fixed_long_budgets_while_defaults_stay_unchanged(self):
        self.assertEqual(qualification.qualification_mode('upload-matrix'), 'upload-matrix')
        self.assertEqual(qualification.case_settings('upload-smoke', None), {'case': None, 'inner_timeout': 600, 'outer_timeout': 660})
        self.assertEqual(qualification.case_settings('startup-only', None), {'case': None, 'inner_timeout': 600, 'outer_timeout': 660})
        manifest = json.loads((SOURCE.parent.parent / 'apps/desktop/e2e/support/chat-upload-matrix-cases.json').read_text())
        self.assertEqual(len(manifest), 14)
        for selected in manifest:
            self.assertEqual(qualification.case_settings('upload-matrix', selected['case']), {'case': selected['case'], 'inner_timeout': 1800, 'outer_timeout': 1860})
        with self.assertRaisesRegex(RuntimeError, 'matrix case'):
            qualification.case_settings('upload-matrix', 'private-invalid')
        with self.assertRaisesRegex(RuntimeError, 'matrix case'):
            qualification.case_settings('upload-smoke', manifest[0]['case'])

    def test_invalid_matrix_case_refuses_before_any_program_or_namespace_admission(self):
        with mock.patch.dict(os.environ, {'BIBCODE_UPLOAD_MODE': 'upload-matrix', 'BIBCODE_UPLOAD_CASE': 'private-invalid'}), mock.patch.object(qualification, 'host_programs') as programs:
            with self.assertRaisesRegex(RuntimeError, 'matrix case'):
                qualification.outer()
            programs.assert_not_called()

    def test_actual_fixture_root_assignment_uses_uuid_without_long_run_id(self):
        module = ast.parse(SOURCE.read_text())
        outer = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'outer')
        assignment = next(node for node in ast.walk(outer) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'fixture' for target in node.targets))
        scope = {'Path': Path, 'run_id': '12345678901234567890', 'uuid': SimpleNamespace(uuid4=lambda: SimpleNamespace(hex='a' * 32))}
        exec(compile(ast.Module(body=[assignment], type_ignores=[]), 'actual-root-producer', 'exec'), scope)
        self.assertEqual(scope['fixture'], Path('/tmp') / ('bibcode-upload-' + 'a' * 32))

    def test_mode_defaults_to_upload_and_startup_is_explicit(self):
        self.assertEqual(qualification.qualification_mode(None), 'upload-smoke')
        self.assertEqual(qualification.qualification_mode('startup-only'), 'startup-only')
        with self.assertRaisesRegex(RuntimeError, 'qualification mode'):
            qualification.qualification_mode('private-invalid')

    def test_invalid_mode_refuses_before_program_or_namespace_admission(self):
        with mock.patch.dict(os.environ, {'BIBCODE_UPLOAD_MODE': 'private-invalid'}), \
             mock.patch.object(qualification, 'host_programs') as programs:
            with self.assertRaisesRegex(RuntimeError, 'qualification mode'):
                qualification.outer()
            programs.assert_not_called()

    def test_actual_inner_environment_forwards_only_the_selected_mode(self):
        module = ast.parse(SOURCE.read_text())
        inner = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'inner')
        assignment = next(node for node in ast.walk(inner) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'environment' for target in node.targets))
        scope = {'mode': 'startup-only', 'Path': Path, 'fixture': Path('/owned/fixture'), 'evidence': Path('/owned/evidence'),
                 'node': '/owned/node', 'os': os, 'private_namespace': 'owned', 'server': '/owned/server',
                 'chrome': '/owned/chrome', 'driver': '/owned/driver', 'source': 'a' * 40, 'trusted_network': {}, 'selection': {'case': None}}
        exec(compile(ast.Module(body=[assignment], type_ignores=[]), 'owned-environment', 'exec'), scope)
        self.assertEqual(scope['environment']['BIBCODE_UPLOAD_MODE'], 'startup-only')

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
