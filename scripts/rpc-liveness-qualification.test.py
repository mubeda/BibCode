"""Driver failure seams; disposable subprocesses, never provider fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

DRIVER = Path(__file__).with_name('rpc-liveness-qualification.py')
spec = importlib.util.spec_from_file_location('qualification', DRIVER)
q = importlib.util.module_from_spec(spec)
if DRIVER.exists():
    sys.modules[spec.name] = q
    spec.loader.exec_module(q)


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def require_driver(self):
        self.assertTrue(hasattr(q, 'run_phase'), 'qualification driver not implemented')

    def fixture(self, body):
        path = self.root / 'fixture.py'
        path.write_text(body)
        return [sys.executable, str(path)]

    def phase(self, command, **options):
        self.require_driver()
        report = q.run_phase(command, self.root / 'evidence', runs=1,
                           parallelism=1, pin_cpu=False, process_seconds=2,
                           phase_seconds=5, **options)
        self.assertIsNone(report['error'])
        return report

    def test_log_under_limit_is_preserved_in_full(self):
        self.require_driver()
        log = q.BoundedLog(4096)
        data = bytes(range(256)) * 15 + b'last 200 bytes' * 15
        self.assertLessEqual(len(data), 4096)
        log.append(data[:2048]); log.append(data[2048:])
        self.assertEqual(log.bytes(), data)

    def test_missing_compiler_artifact_is_rejected(self):
        self.require_driver()
        path = self.root / 'build.jsonl'
        path.write_text('{"reason":"build-finished","success":true}\n')
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            q.select_artifact(path)

    def test_natural_baseline_failure_is_executed_but_not_passed(self):
        self.require_driver()
        body = "import sys\nprint('running 1 test')\nprint('test ' + " + repr(q.TEST_NAME) + " + ' ... FAILED')\nprint('test result: FAILED. 0 passed; 1 failed; 0 ignored')\nsys.exit(1)\n"
        report = self.phase(self.fixture(body))
        self.assertTrue(report['results'][0]['executed'])
        self.assertEqual(report['passed'], 0)
        self.assertTrue(report['complete'])

    def test_zero_test_success_is_rejected(self):
        report = self.phase(self.fixture("print('running 0 tests\\ntest result: ok. 0 passed; 0 failed; 0 ignored')"))
        self.assertFalse(report['passed'])
        self.assertFalse(report['results'][0]['one_test'])
        self.assertFalse(report['results'][0]['executed'])
        self.assertTrue(report['results'][0]['reaped'])

    def test_exact_test_success_counts_and_private_roots_are_removed(self):
        self.require_driver()
        body = "import os\nfrom pathlib import Path\nassert Path(os.environ['HOME']).is_dir()\nassert os.environ['HOME'] != str(Path.home().parent)\nassert 'BIBCODE_HERMETIC_GUARD' not in os.environ\nprint('running 1 test')\nprint('test ' + " + repr(q.TEST_NAME) + " + ' ... ok')\nprint('test result: ok. 1 passed; 0 failed; 0 ignored')\n"
        report = self.phase(self.fixture(body))
        self.assertEqual(report['passed'], 1)
        self.assertTrue(report['fixture_roots_removed'])
        self.assertEqual(report['survivors'], [])

    def test_hanging_child_times_out_and_is_reaped(self):
        self.require_driver()
        command = self.fixture('import time\ntime.sleep(60)')
        begin = time.monotonic()
        report = q.run_phase(command, self.root / 'evidence', runs=1,
                             parallelism=1, pin_cpu=False,
                             process_seconds=.15, phase_seconds=5)
        self.assertLess(time.monotonic() - begin, 3)
        self.assertTrue(report['results'][0]['timeout'])
        self.assertTrue(report['results'][0]['reaped'])
        self.assertEqual(report['survivors'], [])
        with self.assertRaises(ProcessLookupError):
            os.kill(report['results'][0]['pid'], 0)

    def test_log_overflow_is_drained_bounded_and_rejected(self):
        report = self.phase(self.fixture("import sys\nsys.stdout.write('x' * 262144)"), log_limit=4096)
        self.assertFalse(report['passed'])
        self.assertTrue(report['results'][0]['log_overflow'])
        self.assertLessEqual((self.root / 'evidence/000.log').stat().st_size, 4096)
        self.assertTrue(report['results'][0]['reaped'])

    def test_phase_deadline_stops_queued_admissions_and_reaps(self):
        self.require_driver()
        command = self.fixture('import time\ntime.sleep(60)')
        report = q.run_phase(command, self.root / 'evidence', runs=20,
                             parallelism=2, pin_cpu=False,
                             process_seconds=10, phase_seconds=.15)
        self.assertEqual(report['completed'], 2)
        self.assertEqual(report['cancelled'], 'phase deadline')
        self.assertTrue(all(row['reaped'] for row in report['results']))
        self.assertEqual(report['survivors'], [])

    @unittest.skipUnless(sys.platform == 'linux', 'native affinity and /proc evidence')
    def test_native_affinity_load_and_reap(self):
        self.require_driver()
        body = "import os\nassert len(os.sched_getaffinity(0)) == 1\nprint('running 1 test')\nprint('test ' + " + repr(q.TEST_NAME) + " + ' ... ok')\nprint('test result: ok. 1 passed; 0 failed; 0 ignored')\n"
        report = q.run_phase(self.fixture(body), self.root / 'evidence', runs=2,
                             parallelism=2, process_seconds=2, phase_seconds=5)
        self.assertTrue(report['complete'])
        self.assertEqual(report['passed'], 2)
        self.assertTrue(report['load_children_reaped'])
        self.assertIsNotNone(report['load_identity']['start_ticks'])
        self.assertTrue(all(row['affinity'] == [report['affinity_cpu']] for row in report['results']))
        self.assertEqual(report['survivors'], [])
        with self.assertRaises(ProcessLookupError):
            os.kill(report['load_identity']['pid'], 0)

    @unittest.skipUnless(sys.platform != 'win32', 'POSIX signal test')
    def test_sigterm_cancels_owned_child_and_writes_evidence(self):
        self.require_driver()
        fixture = self.fixture('import time\ntime.sleep(60)')
        launcher = self.root / 'launcher.py'
        launcher.write_text("import importlib.util,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('q'," + repr(str(DRIVER)) + ")\nq=importlib.util.module_from_spec(s);sys.modules[s.name]=q;s.loader.exec_module(q)\nq.run_phase(" + repr(fixture) + ",Path(" + repr(str(self.root / 'evidence')) + "),runs=20,parallelism=1,pin_cpu=False,process_seconds=60,phase_seconds=60)\n")
        process = subprocess.Popen([sys.executable, str(launcher)])
        try:
            deadline = time.monotonic() + 5
            while not (self.root / 'evidence/active.json').exists():
                if process.poll() is not None or time.monotonic() > deadline:
                    self.fail('driver did not publish owned child')
                time.sleep(.01)
            owned = json.loads((self.root / 'evidence/active.json').read_text())[0]['pid']
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=5)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
        report = json.loads((self.root / 'evidence/results.json').read_text())
        self.assertEqual(report['cancelled'], 'signal 15')
        self.assertEqual(report['completed'], 1)
        with self.assertRaises(ProcessLookupError):
            os.kill(owned, 0)
        self.assertTrue(report['results'][0]['reaped'])
        self.assertEqual(report['survivors'], [])


if __name__ == '__main__':
    unittest.main()
