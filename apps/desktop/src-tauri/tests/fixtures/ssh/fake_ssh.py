#!/usr/bin/env python3
"""BIBCODE-SSH-FIXTURE fake OpenSSH client.

Used only by apps/desktop/src-tauri/tests/ssh_environment.rs, which starts it
through a generated wrapper that sets the SSH_FIXTURE_* variables below. It
never connects to another machine: the "remote host" is the private directory
$SSH_FIXTURE_ROOT/<alias>/remote-home, and remote commands run locally with that
directory as HOME and a clean, login-like environment.

Remote commands follow OpenSSH semantics: ssh(1) joins the remote argv with
single spaces and sshd(8) runs the joined string with `$SHELL -c` (/bin/sh
here). `-N -L LOCAL:HOST:PORT` (the desktop tunnel) runs a local TCP forwarder
that stays alive until it is killed, like a live `ssh -N` session.

Destination aliases starting with `hang-pairing` make the remote `bibcode`
wrapper hang on `pairing issue`, to exercise the desktop's pairing deadline.

Environment:
  SSH_FIXTURE_ROOT              per-run state directory (required)
  SSH_FIXTURE_BIBCODE           the real `bibcode` binary (required)
  SSH_FIXTURE_REMOTE_BIN        directory holding the remote `bibcode` wrapper
                                (required)
  SSH_FIXTURE_REMOTE_PORT_START first remote port the launch script scans
                                (keeps the fake remote server away from 3773)
"""

import json
import os
import socket
import sys
import threading
import time


def fail(message):
    sys.stderr.write(message + "\n")
    return 255


def classify(remote, script):
    if remote[:3] == ["sh", "-s", "--"]:
        if "nohup" in script:
            return "launch"
        if '{"stopped":true}' in script:
            return "stop"
        if "pairing issue" in script:
            return "pairing"
        return "script"
    return "other"


def pump(source, sink):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            sink.sendall(data)
    except OSError:
        pass
    finally:
        try:
            sink.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def serve_connection(client, host, port):
    try:
        upstream = socket.create_connection((host, port), timeout=10)
        upstream.settimeout(None)
    except OSError:
        client.close()
        return
    forward = threading.Thread(target=pump, args=(client, upstream), daemon=True)
    backward = threading.Thread(target=pump, args=(upstream, client), daemon=True)
    forward.start()
    backward.start()
    forward.join()
    backward.join()
    client.close()
    upstream.close()


def run_tunnel(state, forward):
    if forward is None:
        return fail("fake ssh: -N without -L is not supported")
    parts = forward.split(":")
    if len(parts) != 3:
        return fail("fake ssh: unsupported -L specification " + forward)
    local_port, host, port = int(parts[0]), parts[1], int(parts[2])
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listener.bind(("127.0.0.1", local_port))
    except OSError:
        # ExitOnForwardFailure=yes
        return fail(
            "bind [127.0.0.1]:%d: Address already in use\n"
            "Could not request local forwarding." % local_port
        )
    listener.listen(64)
    with open(os.path.join(state, "tunnels.jsonl"), "a") as log:
        log.write(json.dumps({"pid": os.getpid(), "local": local_port, "remote": port}) + "\n")
    while True:
        client, _ = listener.accept()
        threading.Thread(target=serve_connection, args=(client, host, port), daemon=True).start()


def seed_port(remote_home, state_key, start):
    # The launch script treats an existing port file as the start of its
    # free-port scan and still verifies that the port is free.
    if not start:
        return
    state_dir = os.path.join(remote_home, ".bibcode-ssh-launch", state_key)
    port_file = os.path.join(state_dir, "port")
    if not os.path.exists(port_file):
        os.makedirs(state_dir, exist_ok=True)
        with open(port_file, "w") as handle:
            handle.write(start + "\n")


def main():
    root = os.environ.get("SSH_FIXTURE_ROOT")
    real = os.environ.get("SSH_FIXTURE_BIBCODE")
    remote_bin = os.environ.get("SSH_FIXTURE_REMOTE_BIN")
    if not root or not real or not remote_bin:
        return fail(
            "fake ssh: SSH_FIXTURE_ROOT, SSH_FIXTURE_BIBCODE and SSH_FIXTURE_REMOTE_BIN must be set"
        )

    args = sys.argv[1:]
    options = []
    forward = None
    no_command = False
    host = None
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in ("-o", "-p", "-L"):
            if index + 1 >= len(args):
                return fail("fake ssh: %s requires a value" % arg)
            options.append([arg, args[index + 1]])
            if arg == "-L":
                forward = args[index + 1]
            index += 2
            continue
        if arg in ("-n", "-N", "-T"):
            options.append([arg])
            if arg == "-N":
                no_command = True
            index += 1
            continue
        if arg.startswith("-"):
            return fail("fake ssh: unsupported option " + arg)
        host = arg
        index += 1
        break
    remote = args[index:]
    if host is None:
        return fail("fake ssh: missing destination")

    alias = host.split("@", 1)[-1]
    state = os.path.join(root, alias)
    remote_home = os.path.join(state, "remote-home")
    os.makedirs(remote_home, exist_ok=True)

    script = ""
    if not no_command and remote[:3] == ["sh", "-s", "--"]:
        # The desktop writes the remote script to stdin and closes it. Keep a
        # copy so the invocation can be classified, then replay it as stdin.
        script = sys.stdin.read()
    kind = "tunnel" if no_command else classify(remote, script)
    record = {
        "time": time.time(),
        "pid": os.getpid(),
        "kind": kind,
        "host": host,
        "options": options,
        "remote": remote,
    }
    with open(os.path.join(state, "ssh-invocations.jsonl"), "a") as log:
        log.write(json.dumps(record) + "\n")

    if no_command:
        return run_tunnel(state, forward)

    if kind == "launch" and len(remote) >= 4:
        start = os.environ.get("SSH_FIXTURE_REMOTE_PORT_START")
        if start:
            # Spread aliases over the scan window so scenarios never race for a port.
            start = str(int(start) + (sum(alias.encode()) % 40) * 5)
        seed_port(remote_home, remote[3], start)

    if script:
        script_path = os.path.join(state, "stdin-%d.sh" % os.getpid())
        with open(script_path, "w") as handle:
            handle.write(script)
        replay = os.open(script_path, os.O_RDONLY)
        os.dup2(replay, 0)
        os.close(replay)

    user = os.environ.get("USER", "fixture")
    environment = {
        "HOME": remote_home,
        "USER": user,
        "LOGNAME": os.environ.get("LOGNAME", user),
        "SHELL": "/bin/sh",
        "LANG": "C.UTF-8",
        "PATH": remote_bin + ":/usr/local/bin:/usr/bin:/bin",
        "SSH_FIXTURE_STATE": state,
        "SSH_FIXTURE_BIBCODE": real,
        "SSH_FIXTURE_HANG_PAIRING": "1" if alias.startswith("hang-pairing") else "0",
    }
    if not remote:
        return fail("fake ssh: interactive sessions are not supported")
    os.chdir(remote_home)
    os.execvpe("/bin/sh", ["/bin/sh", "-c", " ".join(remote)], environment)
    return 255


if __name__ == "__main__":
    sys.exit(main())
