"""Add-only contained veth fixture. Called only by the already checked PID1 owner."""
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import time

IN = 'bcup-in'
PEER = 'bcup-peer'
ADDRESSES = {IN: '10.254.231.1', PEER: '10.254.231.2'}
MUTATIONS = [
    ['link', 'add', IN, 'type', 'veth', 'peer', 'name', PEER],
    ['address', 'add', ADDRESSES[IN] + '/30', 'dev', IN],
    ['address', 'add', ADDRESSES[PEER] + '/30', 'dev', PEER],
    ['link', 'set', 'dev', IN, 'up'], ['link', 'set', 'dev', PEER, 'up'],
    ['route', 'add', 'default', 'via', ADDRESSES[PEER], 'dev', IN],
]

class NetworkRefused(Exception):
    def __init__(self, proof=None):
        super().__init__('Contained qualification network setup refused.')
        self.proof = proof

def require(condition):
    if not condition:
        raise NetworkRefused()

def capability_bytes():
    with Path('/proc/self/status').open('rb') as stream:
        return stream.read(8192)


class FailureContext:
    def __init__(self):
        self.stage = 'platform-check'
        self.attempted = 0
        self.completed = 0
        self.last_command = None
        self.net_admin = None

    def proof(self):
        return {'stage': self.stage, 'attemptedMutations': self.attempted,
                'completedMutations': self.completed, 'netAdminEffective': self.net_admin,
                'lastCommand': self.last_command}


def command_status(result):
    status = result if isinstance(result, dict) else {}
    code = status.get('exitCode')
    signal = status.get('cancelledSignal')
    cancelled = False if 'cancelledSignal' in status and signal is None else True if isinstance(signal, int) and not isinstance(signal, bool) and 1 <= signal <= 64 else None
    return {'exitCode': code if type(code) is int and -128 <= code <= 255 else None,
            'timedOut': status.get('timedOut') if type(status.get('timedOut')) is bool else None,
            'cancelled': cancelled,
            'reaped': status.get('supervisorReaped') if type(status.get('supervisorReaped')) is bool else None}


def setup(environment, run_owned, readlink=os.readlink, platform=sys.platform, clock=time.monotonic,
          read_owner=lambda: Path('/proc/1/cmdline').read_bytes(), read_capabilities=capability_bytes):
    context = FailureContext()
    try:
        return _setup(environment, run_owned, context, readlink, platform, clock, read_owner, read_capabilities)
    except Exception:
        # Exceptions and foreign source fields never enter the diagnostic receipt.
        raise NetworkRefused(context.proof()) from None


def _setup(environment, run_owned, context, readlink, platform, clock, read_owner, read_capabilities):
    started = clock()
    deadline = started + 20
    require(platform == 'linux' and environment.get('CI') == 'true')
    try:
        match = re.search(rb'^CapEff:\s*([0-9a-fA-F]{1,16})$', read_capabilities(), re.MULTILINE)
        context.net_admin = bool(int(match[1], 16) & (1 << 12)) if match else None
    except Exception:
        pass  # Optional observation; it does not alter capability or any guard.
    host = environment.get('BIBCODE_UPLOAD_HOST_NETNS', '')
    context.stage = 'owner-shape'
    # Anchor the environment handoff to the visible, checked inner PID1 owner.
    try:
        # /proc terminates argv once; stripping all NULs would hide an extra empty argument.
        owner = read_owner().decode('utf8').removesuffix('\0').split('\0')
        require(len(owner) in [14, 16, 18] and owner[2] == 'inner')
        ui_keys = ['BIBCODE_RELEASE_UI_FAKE_HOST', 'BIBCODE_RELEASE_UI_WEB', 'BIBCODE_RELEASE_UI_MATRIX']
        delivery_key = 'BIBCODE_DELIVERY_UI_WEB'
        delivery_selection = 'BIBCODE_DELIVERY_UI_SELECTION'
        native_key = 'BIBCODE_NATIVE_SHARING_APP'
        if len(owner) == 14:
            require(not any(key in environment for key in ui_keys + [delivery_key, delivery_selection, native_key]))
        elif len(owner) == 16 and owner[14] == 'release-visual-native-sharing':
            require(not any(key in environment for key in ui_keys + [delivery_key, delivery_selection]))
            app = Path(owner[15])
            require(app.is_absolute() and app.suffix == '.AppImage' and not app.is_symlink())
            canonical = app.resolve(strict=True)
            require(canonical.is_file() and str(canonical) == owner[15] == environment.get(native_key))
        elif len(owner) == 16:
            require(native_key not in environment)
            require(owner[14] in ['delivery-retry-ui', 'release-visual-core', 'release-visual-settings', 'release-visual-git-project', 'release-visual-cursor-question', 'release-visual-workspace-substates', 'release-visual-provider-chat', 'release-visual-project-lifecycle', 'release-visual-settings-followups', 'release-visual-pull-requests'] and not any(key in environment for key in ui_keys))
            require(environment.get(delivery_selection) == owner[14])
            web = Path(owner[15])
            require(web.is_absolute())
            canonical = web.resolve(strict=True)
            require(canonical.is_dir() and str(canonical) == owner[15] == environment.get(delivery_key))
        else:
            require(delivery_key not in environment and delivery_selection not in environment and native_key not in environment)
            require(owner[14] == 'remote-updates-ui')
            require(owner[17] in ['core', 'full'] and owner[17] == environment.get(ui_keys[2]))
            for index, key, directory in [(15, ui_keys[0], False), (16, ui_keys[1], True)]:
                path = Path(owner[index])
                require(path.is_absolute())
                canonical = path.resolve(strict=True)
                require(str(canonical) == owner[index] == environment.get(key))
                require(canonical.is_dir() if directory else canonical.is_file())
        context.stage = 'owner-python'
        require(str(Path(owner[0]).resolve(strict=True)) == environment.get('BIBCODE_UPLOAD_PYTHON'))
        context.stage = 'owner-helper'
        require(str(Path(owner[1]).resolve(strict=True)) == environment.get('BIBCODE_UPLOAD_NETWORK_HELPER'))
        context.stage = 'owner-host-ip'
        require(owner[11] == host and str(Path(owner[13]).resolve(strict=True)) == environment.get('BIBCODE_UPLOAD_IP'))
    except (ValueError, OSError, UnicodeError):
        raise NetworkRefused() from None
    expected = {kind: environment.get(key, '') for kind, key in
                [('net', 'BIBCODE_UPLOAD_NETNS'), ('pid', 'BIBCODE_UPLOAD_PIDNS'), ('user', 'BIBCODE_UPLOAD_USERNS')]}
    context.stage = 'namespace-host'
    require(re.fullmatch(r'net:\[\d+\]', host) is not None)
    for kind, identity in expected.items():
        context.stage = 'namespace-' + kind
        require(re.fullmatch(kind + r':\[\d+\]', identity) is not None)
        require(readlink('/proc/self/ns/' + kind) == identity)
        require(readlink('/proc/1/ns/' + kind) == identity)
    context.stage = 'namespace-private'
    require(expected['net'] != host)
    context.stage = 'ip-executable'
    ip = environment.get('BIBCODE_UPLOAD_IP', '')
    require(Path(ip).is_absolute() and Path(ip).is_file() and str(Path(ip).resolve(strict=True)) == ip)

    def command(args, stage, read=False, mutation=False):
        context.stage = stage
        context.last_command = None
        remaining = deadline - clock()
        require(remaining > 0)
        if mutation:
            context.attempted += 1
        result, output = run_owned([ip, *args], timeout=min(2, remaining), grace=1)
        context.last_command = command_status(result)
        require(result.get('exitCode') == 0 and result.get('supervisorReaped') is True and
                result.get('timedOut') is False and result.get('cancelledSignal') is None)
        if mutation:
            context.completed += 1
        if not read:
            return None
        try:
            data = json.loads(output)
        except (ValueError, TypeError):
            raise NetworkRefused() from None
        require(isinstance(data, list) and all(isinstance(row, dict) for row in data))
        return data

    def observations(prefix):
        return (command(['-d', '-j', 'link', 'show'], prefix + '-links-read', True),
                command(['-j', 'address', 'show'], prefix + '-addresses-read', True),
                command(['-j', '-4', 'route', 'show', 'table', 'main'], prefix + '-ipv4-routes-read', True),
                command(['-j', '-6', 'route', 'show', 'table', 'main'], prefix + '-ipv6-routes-read', True))

    def loopback_route(row):
        return (row.get('dev') == 'lo' and row.get('dst') in ['127.0.0.0/8', '::1', '::1/128']
                and 'gateway' not in row and row.get('protocol') == 'kernel')

    def check_addresses(rows, after):
        names = [row.get('ifname') for row in rows]
        require(len(names) == len(set(names)) and set(names) == ({'lo', IN, PEER} if after else {'lo'}))
        for row in rows:
            infos = row.get('addr_info')
            require(isinstance(infos, list))
            ipv4 = []
            for address in infos:
                require(isinstance(address, dict))
                local = address.get('local')
                if row['ifname'] == 'lo':
                    require((address.get('family'), local, address.get('prefixlen')) in
                            [('inet', '127.0.0.1', 8), ('inet6', '::1', 128)])
                elif address.get('family') == 'inet':
                    require(local == ADDRESSES[row['ifname']] and address.get('prefixlen') == 30)
                    ipv4.append(local)
                else:
                    try:
                        valid = (address.get('family') == 'inet6' and
                                 ipaddress.IPv6Address(local).is_link_local and address.get('prefixlen') == 64)
                    except (ValueError, TypeError):
                        valid = False
                    require(valid)
            if row['ifname'] != 'lo':
                require(ipv4 == [ADDRESSES[row['ifname']]])

    links, addresses, routes4, routes6 = observations('before')
    context.stage = 'before-links-check'
    require(len(links) == 1 and links[0].get('ifname') == 'lo')
    context.stage = 'before-routes-check'
    require(all(loopback_route(row) for row in routes4 + routes6))
    context.stage = 'before-addresses-check'
    check_addresses(addresses, False)
    context.stage = 'before-loopback-check'
    loopback_index = links[0].get('ifindex')
    require(type(loopback_index) is int and loopback_index > 0)
    stages = ['mutation-pair', 'mutation-address-in', 'mutation-address-peer', 'mutation-up-in', 'mutation-up-peer', 'mutation-default']
    for args, stage in zip(MUTATIONS, stages):
        command(args, stage, mutation=True)
    links, addresses, routes4, routes6 = observations('after')
    context.stage = 'after-links-check'
    require(len(links) == 3 and {row.get('ifname') for row in links} == {'lo', IN, PEER})
    owned = {row['ifname']: row for row in links}
    context.stage = 'after-loopback-check'
    require(owned['lo'].get('ifindex') == loopback_index)
    for name, peer in [(IN, PEER), (PEER, IN)]:
        row = owned[name]
        context.stage = 'after-ifindex-check'
        require(type(row.get('ifindex')) is int and row['ifindex'] > 0)
        context.stage = 'after-peer-relation-check'
        require(row.get('link') == peer)
        context.stage = 'after-peer-format-check'
        require('link_index' not in row)
        context.stage = 'after-peer-namespace-check'
        require('link_netnsid' not in row and 'link-netnsid' not in row)
        context.stage = 'after-veth-check'
        require(row.get('linkinfo', {}).get('info_kind') == 'veth')
        context.stage = 'after-carrier-check'
        require({'UP', 'LOWER_UP'}.issubset(row.get('flags', [])))
    context.stage = 'after-indices-check'
    require(len({row.get('ifindex') for row in links}) == 3)
    context.stage = 'after-addresses-check'
    check_addresses(addresses, True)
    context.stage = 'after-default-check'
    require(not any(row.get('dst') == 'default' for row in routes6))
    defaults = [row for row in routes4 if row.get('dst') == 'default']
    require(len(defaults) == 1 and defaults[0].get('gateway') == ADDRESSES[PEER] and defaults[0].get('dev') == IN)
    context.stage = 'after-routes-check'
    for row in routes4 + routes6:
        if row in defaults or loopback_route(row):
            continue
        require(row.get('dev') in ADDRESSES and 'gateway' not in row and row.get('protocol') == 'kernel')
        require(row.get('dst') in ['10.254.231.0/30', 'fe80::/64'])
        if 'prefsrc' in row:
            require(row['prefsrc'] == ADDRESSES[row['dev']])
    context.stage = 'deadline'
    require(clock() <= deadline)
    # No delete/rollback: partial setup remains owned by existing PID1 namespace exit.
    return {'privateNet': True, 'pidOwnerMatches': True, 'userOwnerMatches': True,
            'loopbackOnlyBefore': True, 'linksContained': True, 'routeContained': True,
            'interfaceCount': 3, 'elapsedMs': max(0, int((clock() - started) * 1000))}
