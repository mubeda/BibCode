#!/usr/bin/env python3
"""CI-only native Arch layout and published fallback-artifact qualification."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import psutil
from PIL import Image

ROOT = Path('/tmp/issue41-owned')
EVIDENCE = Path('/tmp/issue41-evidence')
APP_URL = 'https://github.com/mubeda/BibCode/releases/download/v0.7.2/BiBCode_0.7.2_amd64.AppImage'
APP_HASH = '554bfbbe2bcce04ff045e5950726f71ba6e1b6ff0c3126f1679969de8c792a18'
APP_SIZE = 100235768
processes = []
observed_processes = {}
cancelled = None
ownership_established = False


def cancel(number, _frame):
    global cancelled
    # Record only: every wait below is bounded, and ownership publication cannot
    # be interrupted between Popen returning and its handle entering processes.
    cancelled = number


def check_cancelled():
    if cancelled is not None:
        raise RuntimeError('qualification_cancelled')


def write_json(name, value):
    (EVIDENCE / name).write_text(json.dumps(value, indent=2) + '\n')


def command(args, environment=None, timeout=10):
    check_cancelled()
    try:
        result = subprocess.run(args, env=environment, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError('qualification_command_timeout') from None
    if result.returncode != 0:
        # In particular, never expose the private X authentication cookie in
        # CalledProcessError's default command-line rendering.
        raise RuntimeError('qualification_command_failed:' + Path(args[0]).name)
    return result.stdout


def download(url, path, expected_hash, maximum):
    digest = hashlib.sha256()
    total = 0
    deadline = time.monotonic() + 120
    with urllib.request.urlopen(url, timeout=20) as response, path.open('xb') as output:
        while True:
            check_cancelled()
            block = response.read(1024 * 1024)
            if not block:
                break
            total += len(block)
            if total > maximum or time.monotonic() > deadline:
                raise RuntimeError('download_bound_exceeded')
            digest.update(block)
            output.write(block)
    if digest.hexdigest() != expected_hash:
        raise RuntimeError('download_digest_mismatch')
    return total


def start(args, log, environment):
    check_cancelled()
    process = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT,
                               env=environment, start_new_session=True)
    processes.append(process)
    observe_owned_processes()
    return process


def observe_owned_processes():
    # This account is newly created for this one container job. Scanning its
    # members also finds a child whose original parent exited before sampling.
    for record in psutil.process_iter(['pid', 'uids']):
        uids = record.info['uids']
        if record.pid == os.getpid() or uids is None or uids.real != os.getuid():
            continue
        try:
            process = psutil.Process(record.pid)
            created = process.create_time()
            if process.uids().real == os.getuid():
                observed_processes[(process.pid, created)] = process
        except psutil.NoSuchProcess:
            pass


def reap_adopted_children():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0:
                return
        except ChildProcessError:
            return


def cleanup():
    if not ownership_established:
        write_json('cleanup.json', {'skipped': 'dedicated_account_ownership_not_established',
                                   'ownedDirectPids': [], 'signalsSent': False})
        return
    for number in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(number, signal.SIG_IGN)
    observe_owned_processes()
    for child in reversed(processes):
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for child in reversed(processes):
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=5)
    # Direct Popen handles have now been joined; this process is a subreaper,
    # so its adopted descendants can also be reaped without stealing a Popen wait.
    for sig in [signal.SIGTERM, signal.SIGKILL]:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            observe_owned_processes()
            for process in observed_processes.values():
                try:
                    if process.is_running():
                        process.send_signal(sig)  # Creation-aware PID-reuse check.
                except psutil.NoSuchProcess:
                    pass
            reap_adopted_children()
            if not any(p.is_running() for p in observed_processes.values()):
                break
            time.sleep(.1)
    observe_owned_processes()
    reap_adopted_children()
    survivors = [p.pid for p in observed_processes.values() if p.is_running()]
    result = {'ownedDirectPids': [p.pid for p in processes],
              'directChildrenReaped': all(p.poll() is not None for p in processes),
              'observedOwnedPids': sorted({p.pid for p in observed_processes.values()}),
              'survivors': survivors, 'ownership': 'new dedicated container account and creation identity'}
    write_json('cleanup.json', result)
    if survivors:
        raise RuntimeError('owned_descendant_survived')


def establish_ownership():
    global ownership_established
    if sys.platform != 'linux' or os.getuid() != 14841 or ROOT.stat().st_uid != 14841:
        raise RuntimeError('dedicated_container_account_required')
    if 'ID=arch' not in Path('/etc/os-release').read_text():
        raise RuntimeError('real_arch_userspace_required')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER, this process only.
        raise RuntimeError('owned_child_subreaper_unavailable')
    observe_owned_processes()
    if observed_processes:
        raise RuntimeError('dedicated_account_already_has_processes')
    ownership_established = True
    for number in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(number, cancel)


def self_test():
    establish_ownership()
    with tempfile.TemporaryDirectory(prefix='orphan-test-', dir=ROOT) as temporary:
        pid_file = Path(temporary) / 'child.pid'
        child_code = ('import os,signal,time;from pathlib import Path;'
                      'signal.signal(signal.SIGTERM,signal.SIG_IGN);'
                      'Path(' + repr(str(pid_file)) + ').write_text(str(os.getpid()));'
                      'time.sleep(60)')
        parent_code = ('import subprocess,sys,time;from pathlib import Path;'
                       'subprocess.Popen([sys.executable,"-c",' + repr(child_code) + '],start_new_session=True);'
                       '\nwhile not Path(' + repr(str(pid_file)) + ').exists(): time.sleep(.01)\n')
        with (ROOT / 'selftest.private.log').open('wb') as log:
            parent = start([sys.executable, '-c', parent_code], log, {'PATH': '/usr/bin:/bin'})
            parent.wait(timeout=5)
            child_pid = int(pid_file.read_text())
            child = psutil.Process(child_pid)
            assert child.is_running() and child.ppid() == os.getpid()
            # No new observation was made after start until the original parent
            # exited. The orphan also escaped its parent's process group.
            cleanup()
            assert not child.is_running()
            write_json('selftest.json', {'passed': True, 'originalParentExited': True,
                       'escapedGroupOrphanReaped': True, 'childPid': child_pid})


def qualify():
    establish_ownership()
    packages = command(['pacman', '-Q', 'gdk-pixbuf2', 'glycin', 'librsvg', 'gtk3', 'webkit2gtk-4.1'])
    loader = command(['pkg-config', '--variable=gdk_pixbuf_moduledir', 'gdk-pixbuf-2.0']).strip()
    write_json('host.json', {'source': os.environ.get('BIBCODE_ISSUE41_SOURCE'),
               'osRelease': Path('/etc/os-release').read_text(), 'kernel': os.uname().release,
               'packages': packages.splitlines(), 'advertisedLoaderPath': loader,
               'legacyDirectoryPresent': Path(loader).is_dir() if loader else False})
    if not loader or Path(loader).is_dir():
        raise RuntimeError('reported_missing_loader_layout_not_reproduced')
    tools = ROOT / 'tools'
    tools.mkdir()
    source = Path('scripts/prepare-tauri-appimage-tools.ts').read_text()
    pin_url = re.search(r'url: "(https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/[^\"]+)"', source)
    pin_hash = re.search(r'sha256: "([0-9a-f]{64})"', source)
    if pin_url is None or pin_hash is None:
        raise RuntimeError('pinned_plugin_definition_changed')
    upstream = tools / 'bibcode-linuxdeploy-gtk-upstream.sh'
    download(pin_url.group(1), upstream, pin_hash.group(1), 1024 * 1024)
    upstream.chmod(0o700)
    wrapper = tools / 'linuxdeploy-plugin-gtk.sh'
    wrapper.write_bytes(Path('scripts/tauri/linuxdeploy-plugin-gtk.sh').read_bytes())
    wrapper.chmod(0o700)
    appdir = ROOT / 'empty-appdir'
    appdir.mkdir()
    (appdir / 'sentinel').write_text('untouched')
    diagnostic = subprocess.run([str(wrapper), '--appdir', str(appdir)],
                                text=True, capture_output=True, timeout=15)
    text = diagnostic.stdout + diagnostic.stderr
    (EVIDENCE / 'diagnostic.txt').write_text(text[:65536])
    assert diagnostic.returncode != 0
    assert 'missing path' in text and 'Ubuntu 22.04' in text and 'official release AppImage' in text
    assert [p.name for p in appdir.iterdir()] == ['sentinel']
    assert (appdir / 'sentinel').read_text() == 'untouched'
    write_json('diagnostic.json', {'passed': True, 'exitCode': diagnostic.returncode,
               'appdirUnchanged': True, 'upstreamSha256': pin_hash.group(1)})

    app = ROOT / 'BiBCode_0.7.2_amd64.AppImage'
    assert download(APP_URL, app, APP_HASH, APP_SIZE) == APP_SIZE
    app.chmod(0o700)
    for name in ['home', 'state/userdata', 'config', 'cache', 'data', 'runtime', 'tmp']:
        (ROOT / name).mkdir(parents=True, mode=0o700, exist_ok=True)
    missing = str(ROOT / 'no-provider-executable')
    settings = {'enableProviderUpdateChecks': False,
                'providers': {name: {'enabled': False, 'binaryPath': missing}
                              for name in ['codex', 'claudeAgent', 'cursor', 'grok', 'opencode']},
                'providerInstances': {name: {'driver': name, 'enabled': False,
                                             'config': {'binaryPath': missing}}
                                      for name in ['codex', 'claudeAgent', 'cursor', 'grok', 'opencode']}}
    (ROOT / 'state/userdata/settings.json').write_text(json.dumps(settings))
    environment = {'PATH': '/usr/bin:/bin', 'HOME': str(ROOT / 'home'), 'USER': 'appcheck',
                   'ZDOTDIR': str(ROOT / 'home'), 'XDG_CONFIG_HOME': str(ROOT / 'config'),
                   'XDG_CACHE_HOME': str(ROOT / 'cache'), 'XDG_DATA_HOME': str(ROOT / 'data'),
                   'XDG_RUNTIME_DIR': str(ROOT / 'runtime'), 'TMPDIR': str(ROOT / 'tmp'),
                   'BIBCODE_HOME': str(ROOT / 'state'), 'BIBCODE_PORT': '14841',
                   'BIBCODE_GDK_BACKEND': 'x11', 'WAYLAND_DISPLAY': 'no-wayland',
                   'APPIMAGE_EXTRACT_AND_RUN': '1', 'LANG': 'C.UTF-8', 'RUST_LOG': 'warn',
                   'DISPLAY': ':88', 'XAUTHORITY': str(ROOT / 'xauthority')}
    with socket.socket() as port:
        port.bind(('127.0.0.1', 14841))
    if Path('/tmp/.X11-unix/X88').exists():
        raise RuntimeError('owned_display_number_busy')
    command(['xauth', '-f', str(ROOT / 'xauthority'), 'add', ':88', 'MIT-MAGIC-COOKIE-1',
             os.urandom(16).hex()], environment)
    with (ROOT / 'xvfb.private.log').open('wb') as display_log, (ROOT / 'app.private.log').open('wb') as app_log:
        display = start(['Xvfb', ':88', '-screen', '0', '1280x960x24', '-nolisten', 'tcp',
                         '-auth', str(ROOT / 'xauthority')], display_log, environment)
        deadline = time.monotonic() + 10
        while not Path('/tmp/.X11-unix/X88').exists():
            check_cancelled()
            observe_owned_processes()
            if display.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError('owned_display_unavailable')
            time.sleep(.1)
        application = start([str(app)], app_log, environment)
        deadline = time.monotonic() + 60
        window = None
        descriptor = None
        while time.monotonic() < deadline:
            check_cancelled()
            observe_owned_processes()
            if application.poll() is not None:
                raise RuntimeError('published_appimage_exited_before_ready')
            found = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', 'BiBCode'],
                                   env=environment, capture_output=True, text=True, timeout=5)
            if found.returncode == 0 and found.stdout.strip():
                window = found.stdout.splitlines()[0]
            try:
                with urllib.request.urlopen('http://127.0.0.1:14841/.well-known/bibcode/environment', timeout=1) as response:
                    descriptor = json.load(response)
            except (OSError, ValueError):
                pass
            if window and isinstance(descriptor, dict) and descriptor.get('serverVersion') == '0.7.2':
                break
            time.sleep(.2)
        if not window or not isinstance(descriptor, dict) or descriptor.get('serverVersion') != '0.7.2':
            raise RuntimeError('window_and_native_descriptor_not_ready')
        # Allow the actual first window to finish rendering; image review remains required.
        time.sleep(3)
        screenshot = EVIDENCE / 'published-appimage-arch.png'
        command(['import', '-window', window, str(screenshot)], environment)
        with Image.open(screenshot) as image:
            assert image.width >= 600 and image.height >= 400
            assert len(image.convert('RGB').resize((128, 96)).getcolors(128 * 96) or []) > 20
        write_json('runtime.json', {'passed': True, 'appImageSha256': APP_HASH,
                   'artifactUrl': APP_URL, 'version': descriptor['serverVersion'],
                   'windowId': window, 'serverPort': 14841, 'uid': os.getuid(),
                   'executionMode': 'supported extraction fallback', 'visualReviewPending': True})


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--self-test']:
            self_test()
        else:
            qualify()
    finally:
        cleanup()
