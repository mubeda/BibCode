"""Native qualification admission through TempFS/fake PID1 and command ports only."""
import importlib.util
import ast
import inspect
import contextlib
import io
import runpy
import subprocess
import shutil
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

qualification = load('native_qualification', 'qualify-chat-uploads.py')
network_tests = load('native_network_ports', 'qualify-chat-network.test.py')
network = network_tests.network
MODE = 'release-visual-native-sharing'

class NativeQualificationTests(unittest.TestCase):
    def test_actual_private_launcher_tools_start_only_the_inert_apprun_wrapper(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw).resolve(); fixture=root/'fixture'; fixture.mkdir(mode=0o700); (fixture/'bin').mkdir(mode=0o700)
            qualification.prepare_tools(fixture,sys.executable,sys.executable,shutil.which('dirname'))
            readlink=root/'owned readlink'; readlink.write_text('#!'+str(Path(sys.executable).resolve())+'\nimport os,sys\nif len(sys.argv)!=3 or sys.argv[1]!="-f": sys.exit(81)\nprint(os.path.realpath(sys.argv[2]))\n'); readlink.chmod(0o700)
            app=root/'AppRun'; app.write_text('#!/usr/bin/env bash\nset -e\nactual="$(readlink -f "$0")"\n[[ -n "$actual" ]]\nprintf "owned launcher ready\\n"\n'); app.chmod(0o700)
            qualification.prepare_native_launcher_tools(fixture,lambda name:shutil.which('bash') if name=='bash' else str(readlink))
            result=subprocess.run([str(app)],env={'PATH':str(fixture/'bin')},capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0); self.assertEqual(result.stdout,'owned launcher ready\n')
            self.assertEqual(result.stderr,'')
            self.assertNotIn('real-hosting', (fixture/'bin'/'gh').read_text())

    def test_native_cli_guard_returns_only_closed_failure_before_any_native_action(self):
        output=io.StringIO(); errors=io.StringIO()
        with mock.patch.object(sys,'argv',['qualify-chat-uploads.py','--scenario',MODE]), \
             mock.patch.dict(os.environ,{'GITHUB_RUN_ID':'not-a-native-run'}), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors), self.assertRaises(SystemExit) as stopped:
            runpy.run_path(str(Path(__file__).with_name('qualify-chat-uploads.py')),run_name='__main__')
        self.assertEqual(stopped.exception.code,1)
        self.assertEqual(json.loads(output.getvalue()),{'refused':True,'stage':'native-controller'})
        self.assertEqual(errors.getvalue(),'')

    def test_finite_native_entry_and_payload(self):
        self.assertEqual(qualification.scenario_settings(MODE), {
            'controller': 'apps/desktop/e2e/qualify-native-sharing.ts',
            'inner_timeout': 600, 'outer_timeout': 660,
            'evidence_prefix': 'issue29-native-sharing-', 'fixture_prefix': 'bc-vn-'})
        self.assertEqual(qualification.inner_resources([MODE, '/owned/app.AppImage']),
                         (MODE, None, '/owned/app.AppImage', 'core'))
        for args in [[MODE], [MODE, '/owned/app.AppImage', 'extra'], [MODE, '/owned/web']]:
            with self.subTest(args=args), self.assertRaises(RuntimeError): qualification.inner_resources(args)

    def test_actual_native_inner_owns_only_app_xvfb_handoff_and_original_status(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve(); fixture = root / 'fixture'; fixture.mkdir(mode=0o700)
            evidence = root / 'evidence'; evidence.mkdir(mode=0o700)
            app = root / 'app.AppImage'; app.write_bytes(b'inert packaged app'); app.chmod(0o500)
            xvfb = root / 'Xvfb'; xvfb.write_bytes(b'inert display actor'); xvfb.chmod(0o500)
            process = types.SimpleNamespace(pid=42, wait=mock.Mock(return_value=23), poll=lambda: 23)
            real_readlink = os.readlink
            def readlink(path, *args, **kwargs):
                return 'net:[private]' if str(path).startswith('/proc/') else real_readlink(path, *args, **kwargs)
            with mock.patch.object(qualification.os, 'getpid', return_value=1), \
                 mock.patch.object(qualification.os, 'readlink', side_effect=readlink), \
                 mock.patch.object(qualification, 'network_environment', return_value={}), \
                 mock.patch.object(qualification, 'run_ip', return_value='[]'), \
                 mock.patch.object(qualification, 'prepare_tools'), \
                 mock.patch.object(qualification.shutil, 'which', return_value=str(xvfb)), \
                 mock.patch.object(qualification.signal, 'signal'), \
                 mock.patch.object(qualification, 'namespace_children', return_value=[]), \
                 mock.patch.object(qualification, 'reap_children'), \
                 mock.patch.object(qualification.subprocess, 'Popen', return_value=process) as popen:
                status = qualification.inner(evidence, fixture, 'node', 'unused-slot', 'chrome', 'driver', 'git', 'dirname', 'net:[host]', 'a'*40, 'ip', MODE, str(app))
            self.assertEqual(status, 23)
            self.assertEqual(popen.call_args.args[0], ['node', 'apps/desktop/e2e/qualify-native-sharing.ts'])
            env = popen.call_args.kwargs['env']
            self.assertEqual(env['BIBCODE_NATIVE_SHARING_APP'], str(app.resolve()))
            self.assertEqual(env['BIBCODE_NATIVE_SHARING_XVFB'], str(xvfb.resolve()))
            self.assertNotIn('BIBCODE_DELIVERY_UI_WEB', env)
            self.assertNotIn('BIBCODE_DELIVERY_UI_SELECTION', env)
            self.assertEqual(json.loads((evidence/'namespace-cleanup.json').read_text())['remaining'], [])

    def test_network_consumes_actual_native_payload_without_browser_ui_aliases(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve(); app = root/'app.AppImage'; app.write_bytes(b'inert app')
            owner = [*network_tests.OWNER, MODE, str(app)]
            env = {**network_tests.ENV, 'BIBCODE_NATIVE_SHARING_APP': str(app)}
            ports = network_tests.FakeIp()
            proof = network.setup(env, ports, readlink=lambda path: network_tests.NAMESPACES[path],
                                  read_owner=lambda: ('\0'.join(owner)+'\0').encode(), platform='linux',
                                  read_capabilities=lambda: b'CapEff:\t0000000000001000\n')
            self.assertTrue(proof['privateNet'])
            self.assertEqual(ports.mutations, network_tests.MUTATIONS)

    def test_actual_outer_inner_expressions_join_native_network_owner(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw).resolve(); app=root/'app.AppImage'; app.write_bytes(b'inert app'); app.chmod(0o500)
            xvfb=root/'Xvfb'; xvfb.write_bytes(b'inert display'); xvfb.chmod(0o500)
            source=Path(__file__).with_name('qualify-chat-uploads.py'); module=ast.parse(source.read_text())
            outer=next(node for node in module.body if isinstance(node,ast.FunctionDef) and node.name=='outer')
            command=next(node for node in outer.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='command' for target in node.targets))
            selected=next(node for node in outer.body if isinstance(node,ast.If) and any(isinstance(call,ast.Call) and isinstance(call.func,ast.Attribute) and isinstance(call.func.value,ast.Name) and call.func.value.id=='command' and call.func.attr=='extend' for call in ast.walk(node)))
            scope={**qualification.__dict__,'scenario':MODE,'ui_matrix':'core','programs':{key:sys.executable for key in ['google-chrome','chromedriver','git','dirname','ip']}|{'unshare':'/owned/unshare'},
                   'evidence':root/'evidence','fixture':root/'fixture','node':sys.executable,'server':str(app),
                   'namespace':'net:[1]','provenance':{},'shutil':types.SimpleNamespace(which=lambda name:str(xvfb)),
                   'os':types.SimpleNamespace(environ={'GITHUB_SHA':'a'*40,'BIBCODE_NATIVE_SHARING_APP':str(app)})}
            exec(compile(ast.Module(body=[command,selected],type_ignores=[]),'owned-native-argv','exec'),scope)
            owner=scope['command'][scope['command'].index('inner')-2:]
            self.assertEqual(len(owner),16); self.assertEqual(owner[14:],[MODE,str(app)])
            arguments=inspect.signature(qualification.inner).bind(Path(owner[3]),Path(owner[4]),*owner[5:]); arguments.apply_defaults()
            inner=next(node for node in module.body if isinstance(node,ast.FunctionDef) and node.name=='inner')
            resources=next(node for node in inner.body if isinstance(node,ast.Assign) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id=='inner_resources')
            environment=next(node for node in ast.walk(inner) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='environment' for target in node.targets))
            selected_environment=next(node for node in ast.walk(inner) if isinstance(node,ast.If) and any(isinstance(call,ast.Call) and isinstance(call.func,ast.Attribute) and isinstance(call.func.value,ast.Name) and call.func.value.id=='environment' and call.func.attr=='update' for call in ast.walk(node)))
            scope={**qualification.__dict__,**arguments.arguments,'private_namespace':'net:[2]','trusted_network':network_tests.ENV,
                   'shutil':types.SimpleNamespace(which=lambda name:str(xvfb)),
                   'os':types.SimpleNamespace(environ={'PATH':'/owned/tools'},pathsep=':',access=os.access,X_OK=os.X_OK)}
            exec(compile(ast.Module(body=[resources,environment,selected_environment],type_ignores=[]),'owned-native-environment','exec'),scope)
            env=scope['environment']; self.assertNotIn('BIBCODE_DELIVERY_UI_WEB',env)
            ports=network_tests.FakeIp()
            proof=network.setup(env,ports,readlink=lambda path:network_tests.NAMESPACES[path],read_owner=lambda:('\0'.join(owner)+'\0').encode(),platform='linux',read_capabilities=lambda:b'CapEff:\t0000000000001000\n')
            self.assertTrue(proof['privateNet']); self.assertEqual(ports.mutations,network_tests.MUTATIONS)

    def test_network_rejects_foreign_native_app_or_ui_payload_before_mutation(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw).resolve(); app = root/'app.AppImage'; app.write_bytes(b'inert app')
            owner = [*network_tests.OWNER, MODE, str(app)]
            for change in [{'BIBCODE_NATIVE_SHARING_APP': str(root/'other.AppImage')},
                           {'BIBCODE_DELIVERY_UI_WEB': str(root)},
                           {'BIBCODE_DELIVERY_UI_SELECTION': 'release-visual-core'}]:
                with self.subTest(change=change):
                    env = {**network_tests.ENV, 'BIBCODE_NATIVE_SHARING_APP': str(app), **change}
                    ports = network_tests.FakeIp()
                    with self.assertRaises(network.NetworkRefused):
                        network.setup(env, ports, readlink=lambda path: network_tests.NAMESPACES[path],
                                      read_owner=lambda: ('\0'.join(owner)+'\0').encode(), platform='linux')
                    self.assertEqual(ports.mutations, [])

    def test_native_input_hashes_bind_exact_app_and_display_bytes(self):
        with tempfile.TemporaryDirectory() as raw:
            root=Path(raw).resolve(); app=root/'app.AppImage'; xvfb=root/'Xvfb'
            app.write_bytes(b'inert app'); xvfb.write_bytes(b'inert display')
            before=qualification.native_input_hashes(str(app),str(xvfb))
            self.assertEqual(set(before), {'appSha256','xvfbSha256'})
            app.write_bytes(b'changed app')
            self.assertNotEqual(before, qualification.native_input_hashes(str(app),str(xvfb)))

    def test_native_fixture_retention_requires_controller_and_namespace_cleanup_proof(self):
        for change in ['none','unsafe','source','children','cleanup','selection']:
            with self.subTest(change=change), tempfile.TemporaryDirectory(prefix='bc-vn-', dir='/tmp') as raw, tempfile.TemporaryDirectory() as evidence_raw:
                fixture=Path(raw); evidence=Path(evidence_raw)
                (evidence/'namespace-cleanup.json').write_text(json.dumps({'remaining':[],'controllerReaped':True}))
                result={'selection':MODE,'source':'a'*40,'nativeSharingFixtureSafeToDelete':True,'childProcessesClosed':True,'cleanupFailures':[]}
                if change=='unsafe': result['nativeSharingFixtureSafeToDelete']=False
                elif change=='source': result['source']='b'*40
                elif change=='children': result['childProcessesClosed']=False
                elif change=='cleanup': result['cleanupFailures']=[{'role':'primary','failure':{'kind':'unclassified'}}]
                elif change=='selection': result['selection']='release-visual-core'
                (evidence/'result.json').write_text(json.dumps(result))
                with mock.patch.dict(os.environ, {'GITHUB_SHA':'a'*40}):
                    deleted=qualification.cleanup_ui_fixture(fixture,evidence,{'supervisorReaped':True},MODE)
                self.assertEqual(deleted,change=='none')
                self.assertEqual(fixture.exists(),change!='none')

if __name__ == '__main__': unittest.main()
