#!/usr/bin/env python3
"""Disposable issue-39 qualification. Linux socket tests launch no child fixtures."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time

TEST_NAME = 'an_idle_client_that_answers_pings_is_kept_past_the_silence_limit'
BASELINE_SHA = '102691a329e84e7422348a44e192e560e57280fa'
BASELINE_TEST_HASH = '33c06368dbcde17bfecfb9e6de737e499eb4fa9839cfcf19140304bf5999ce28'
TEST_SOURCE = 'apps/server/tests/rpc_liveness.rs'


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def identity(pid):
    """Native evidence omits environment/arguments, which can contain secrets."""
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        row = {'pid': pid, 'ppid': int(fields[1]), 'pgid': int(fields[2]),
               'start_ticks': fields[19]}
        try:
            row['exe'] = os.readlink(f'/proc/{pid}/exe')
        except PermissionError:
            row['exe'] = '<unreadable>'
        return row
    except (FileNotFoundError, ProcessLookupError):
        return None


def group_survivors(groups):
    if sys.platform != 'linux':
        return []  # Portable self-tests prove wait/reap; qualification requires Linux.
    survivors = []
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            row = identity(int(entry.name))
            if row and row['pgid'] in groups:
                survivors.append(row)
    return survivors


def stop_owned(process, recorded):
    """The unreaped child plus its start identity fences PID reuse before signals."""
    if process.poll() is None:
        if sys.platform == 'linux':
            current = identity(process.pid)
            if not current and process.poll() is not None:
                return process.wait(timeout=5)
            if not current or not recorded or current['start_ticks'] != recorded['start_ticks']:
                raise RuntimeError(f'owned process identity changed: {process.pid}')
        try:
            if os.getpgid(process.pid) != process.pid:
                raise RuntimeError('owned process left its private group')
        except ProcessLookupError:
            return process.wait(timeout=5)
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
    return process.wait(timeout=5)


def fixture_environment(root):
    # Allowlist deliberately omits credentials, inherited GIT_* and guard overrides.
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8',
           'LC_ALL': 'C.UTF-8', 'RUST_BACKTRACE': '0'}
    for name, subdir in [('HOME', 'home'), ('USERPROFILE', 'home'),
                         ('BIBCODE_HOME', 'bibcode'), ('XDG_CONFIG_HOME', 'config'),
                         ('XDG_CACHE_HOME', 'cache'), ('XDG_DATA_HOME', 'data'),
                         ('XDG_STATE_HOME', 'state'), ('TMPDIR', 'tmp')]:
        target = root / subdir
        target.mkdir(exist_ok=True)
        env[name] = str(target)
    return env


class BoundedLog:
    def __init__(self, limit):
        self.limit = limit
        self.size = 0
        self.head = bytearray()
        self.tail = bytearray()

    def append(self, data):
        self.size += len(data)
        self.head.extend(data[:max(0, self.limit - len(self.head))])
        self.tail.extend(data)
        del self.tail[:-min(65536, self.limit // 2)]

    def bytes(self):
        if self.size <= self.limit:
            return bytes(self.head)
        marker = b'\n[log overflow: head and tail]\n'
        prefix = self.limit - len(marker) - len(self.tail)
        return bytes(self.head[:prefix]) + marker + bytes(self.tail)


def run_phase(command, output, *, runs=300, parallelism=16, pin_cpu=True,
              process_seconds=1500, phase_seconds=2400, log_limit=1024 * 1024):
    """One bounded admission loop; signals stop admission and reap only owned roots."""
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    original_affinity = sorted(os.sched_getaffinity(0)) if pin_cpu else []
    cpu = min(original_affinity) if pin_cpu else None
    active, results, groups = {}, [], set()
    selector = selectors.DefaultSelector()
    cancelled = None
    load = None
    load_identity = None
    load_reaped = False
    error = None
    fixtures = Path(tempfile.mkdtemp(prefix='issue39-fixtures-', dir=output.parent))
    previous_handlers = {}
    def on_signal(number, _frame):
        nonlocal cancelled
        cancelled = f'signal {number}'
    for number in (signal.SIGTERM, signal.SIGINT):
        previous_handlers[number] = signal.signal(number, on_signal)

    def drain(row):
        try:
            data = os.read(row['process'].stdout.fileno(), 65536)
        except BlockingIOError:
            return
        if data:
            row['log'].append(data)
        else:
            selector.unregister(row['process'].stdout)
            row['eof'] = True

    def drain_exited(row):
        nonlocal error
        deadline = time.monotonic() + 1
        while not row['eof'] and time.monotonic() < deadline:
            drain(row)
        if not row['eof']:
            error = (error or '') + '; exited root left its output pipe open'
            selector.unregister(row['process'].stdout)
            row['eof'] = True

    def finish(pid, row):
        process = row['process']
        # poll/wait reaps even a naturally exited root; pipes are drained first.
        code = process.wait(timeout=5)
        data = row['log'].bytes()
        (output / f'{row["run"]:03d}.log').write_bytes(data)
        text = data.decode('utf-8', errors='replace')
        executed = ('running 1 test' in text
                    and re.search(r'^test ' + re.escape(TEST_NAME) + r' \.\.\. (ok|FAILED)$', text, re.M)
                    is not None
                    and re.search(r'test result: (ok|FAILED)\. (1 passed; 0 failed|0 passed; 1 failed); 0 ignored', text)
                    is not None)
        one_test = ('running 1 test' in text
                    and re.search(r'^test ' + re.escape(TEST_NAME) + r' \.\.\. ok$', text, re.M)
                    is not None
                    and '1 passed; 0 failed; 0 ignored' in text)
        results.append({'run': row['run'], 'pid': pid, 'identity': row['identity'],
                        'exit': code, 'reaped': True, 'timeout': row['timeout'],
                        'duration': round(time.monotonic() - row['started'], 3),
                        'one_test': one_test, 'executed': executed, 'log_bytes': row['log'].size,
                        'log_overflow': row['log'].size > log_limit,
                        'affinity': row['affinity']})
        process.stdout.close()
        del active[pid]
        write_json(output / 'progress.json', {'completed': len(results),
                   'elapsed': round(time.monotonic() - started, 3)})
        if len(results) % 16 == 0:
            print(f'{output.name}: {len(results)}/{runs} completed', flush=True)

    try:
        if pin_cpu:
            if sys.platform != 'linux':
                raise RuntimeError('native qualification requires Linux')
            os.sched_setaffinity(0, {cpu})
            load = subprocess.Popen([sys.executable, '-c', 'while True: pass'],
                                    start_new_session=True, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, env=fixture_environment(fixtures))
            load_identity = identity(load.pid)
            groups.add(load.pid)
            if os.sched_getaffinity(load.pid) != {cpu}:
                raise RuntimeError('load worker affinity mismatch')
        write_json(output / 'before.json', {'driver': identity(os.getpid()) if pin_cpu else None,
                   'original_affinity': original_affinity, 'load': load_identity})
        admitted = 0
        while active or (admitted < runs and not cancelled):
            if time.monotonic() - started >= phase_seconds:
                cancelled = cancelled or 'phase deadline'
            if error:
                cancelled = cancelled or 'driver error'
            if load and load.poll() is not None:
                cancelled = cancelled or 'load worker exited'
            while not cancelled and admitted < runs and len(active) < parallelism:
                root = fixtures / str(admitted)
                root.mkdir()
                process = subprocess.Popen(command, env=fixture_environment(root),
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
                groups.add(process.pid)
                row = {'process': process, 'identity': identity(process.pid) if sys.platform == 'linux' else None,
                       'run': admitted, 'started': time.monotonic(), 'timeout': False,
                       'affinity': sorted(os.sched_getaffinity(process.pid)) if pin_cpu else [],
                       'log': BoundedLog(log_limit), 'eof': False}
                active[process.pid] = row
                os.set_blocking(process.stdout.fileno(), False)
                selector.register(process.stdout, selectors.EVENT_READ, row)
                admitted += 1
                if pin_cpu and (row['affinity'] != [cpu] or not row['identity']):
                    raise RuntimeError('test process affinity/identity unavailable')
                write_json(output / 'active.json', [{'pid': pid, 'identity': value['identity']}
                           for pid, value in active.items()])
            for key, _events in selector.select(timeout=.02):
                drain(key.data)
            for pid, row in list(active.items()):
                timed_out = time.monotonic() - row['started'] >= process_seconds
                if cancelled or timed_out or row['log'].size > log_limit:
                    row['timeout'] = timed_out
                    stop_owned(row['process'], row['identity'])
                if row['process'].poll() is not None:
                    # Drain until EOF, never wait on a pipe while a child can still write.
                    drain_exited(row)
                    finish(pid, row)
    except Exception as failure:
        error = str(failure)
        cancelled = cancelled or 'driver error'
    finally:
        for pid, row in list(active.items()):
            try:
                stop_owned(row['process'], row['identity'])
                drain_exited(row)
                finish(pid, row)
            except Exception as failure:
                error = (error or '') + f'; cleanup {pid}: {failure}'
        if load:
            try:
                stop_owned(load, load_identity)
                load_reaped = True
            except Exception as failure:
                error = (error or '') + f'; load cleanup: {failure}'
        survivors = group_survivors(groups)
        selector.close()
        if not survivors and not active:
            shutil.rmtree(fixtures)
        if pin_cpu and original_affinity:
            os.sched_setaffinity(0, original_affinity)
        for number, previous in previous_handlers.items():
            signal.signal(number, previous)
        report = {'test': TEST_NAME, 'runs': runs, 'completed': len(results),
                  'parallelism': parallelism, 'affinity_cpu': cpu, 'cpu_workers': int(pin_cpu),
                  'process_seconds': process_seconds, 'phase_seconds': phase_seconds,
                  'duration': round(time.monotonic() - started, 3), 'cancelled': cancelled,
                  'error': error, 'load_identity': load_identity, 'load_children_reaped': load_reaped,
                  'survivors': survivors, 'fixture_roots_removed': not fixtures.exists(),
                  'results': sorted(results, key=lambda row: row['run'])}
        report['passed'] = sum(row['exit'] == 0 and row['one_test']
                               and not row['timeout'] and not row['log_overflow'] for row in results)
        report['complete'] = (len(results) == runs and not cancelled and not error
                              and not survivors and not active and (load_reaped or not pin_cpu))
        write_json(output / 'results.json', report)
        write_json(output / 'after.json', {'survivors': survivors,
                   'load_reaped': load_reaped, 'fixture_roots_removed': not fixtures.exists()})
    return report


def select_artifact(path, target_name="rpc_liveness"):
    binaries = []
    for line in path.read_text().splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if (row.get('reason') == 'compiler-artifact'
                and row.get('target', {}).get('name') == target_name
                and row.get('profile', {}).get('test') and row.get('executable')):
            binaries.append(row['executable'])
    if len(binaries) != 1:
        raise ValueError(f'expected exactly one {target_name} executable, got {len(binaries)}')
    return binaries[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['artifact', 'run'])
    parser.add_argument('--build-json', type=Path)
    parser.add_argument('--target-name', default='rpc_liveness', choices=['rpc_liveness', 'bibcode_server'])
    parser.add_argument('--evidence-root', type=Path)
    parser.add_argument('--baseline-binary', type=Path)
    parser.add_argument('--fixed-binary', type=Path)
    args = parser.parse_args()
    if args.operation == 'artifact':
        print(select_artifact(args.build_json, args.target_name))
        return 0
    if sys.platform != 'linux':
        parser.error('qualification must execute on native Linux')
    root = args.evidence_root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    baseline_source = subprocess.check_output(['git', 'show', f'{BASELINE_SHA}:{TEST_SOURCE}'])
    if hashlib.sha256(baseline_source).hexdigest() != BASELINE_TEST_HASH:
        raise ValueError('baseline test source differs from recorded Linux baseline')
    metadata = {'production_source_sha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
                'comparison': 'old vs fixed test logic against identical current production source; not old production snapshot',
                'baseline_test_source_sha': BASELINE_SHA, 'baseline_test_sha256': BASELINE_TEST_HASH,
                'fixed_test_sha256': digest(Path(TEST_SOURCE)), 'lock_sha256': digest(Path('Cargo.lock')),
                'driver_sha256': digest(Path(__file__)), 'uname': list(os.uname()),
                'rustc': subprocess.check_output(['rustc', '-Vv'], text=True),
                'os_release': Path('/etc/os-release').read_text(),
                'cpu_model': next((line for line in Path('/proc/cpuinfo').read_text().splitlines()
                                   if line.startswith('model name')), 'unavailable')}
    write_json(root / 'source.json', metadata)
    all_passed = True
    for phase, binary in [('baseline', args.baseline_binary), ('fixed', args.fixed_binary)]:
        listed = subprocess.check_output([str(binary), '--list'], text=True, timeout=30)
        if f'{TEST_NAME}: test' not in listed.splitlines():
            raise ValueError('selected test missing or ignored')
        report = run_phase([str(binary), TEST_NAME, '--exact', '--nocapture'], root / phase)
        report.update(phase=phase, binary_sha256=digest(binary))
        write_json(root / phase / 'results.json', report)
        all_passed &= (report['complete'] and report['fixture_roots_removed']
                       and all(row['executed'] and not row['timeout']
                               and not row['log_overflow'] for row in report['results'])
                       and (phase == 'baseline' or report['passed'] == 300))
        if report['cancelled'] or report['error'] or report['survivors']:
            break
    write_json(root / 'qualification.json', {'passed': all_passed,
               'note': 'A green natural baseline does not reproduce the original flake.'})
    return 0 if all_passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
