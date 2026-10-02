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
    def __init__(self):
        super().__init__('Contained qualification network setup refused.')

def require(condition):
    if not condition:
        raise NetworkRefused()

def setup(environment, run_owned, readlink=os.readlink, platform=sys.platform, clock=time.monotonic,
          read_owner=lambda: Path("/proc/1/cmdline").read_bytes()):
    started = clock()
    deadline = started + 20
    require(platform == 'linux' and environment.get('CI') == 'true')
    host = environment.get('BIBCODE_UPLOAD_HOST_NETNS', '')
    # Anchor the environment handoff to the visible, checked inner PID1 owner.
    try:
        owner = read_owner().decode('utf8').rstrip('\0').split('\0')
        require(len(owner) == 14 and owner[2] == 'inner')
        require(str(Path(owner[0]).resolve(strict=True)) == environment.get('BIBCODE_UPLOAD_PYTHON'))
        require(str(Path(owner[1]).resolve(strict=True)) == environment.get('BIBCODE_UPLOAD_NETWORK_HELPER'))
        require(owner[11] == host and str(Path(owner[13]).resolve(strict=True)) == environment.get('BIBCODE_UPLOAD_IP'))
    except (ValueError, OSError, UnicodeError):
        raise NetworkRefused() from None
    expected = {kind: environment.get(key, '') for kind, key in
                [('net', 'BIBCODE_UPLOAD_NETNS'), ('pid', 'BIBCODE_UPLOAD_PIDNS'), ('user', 'BIBCODE_UPLOAD_USERNS')]}
    require(re.fullmatch(r'net:\[\d+\]', host) is not None)
    for kind, identity in expected.items():
        require(re.fullmatch(kind + r':\[\d+\]', identity) is not None)
        require(readlink('/proc/self/ns/' + kind) == identity)
        require(readlink('/proc/1/ns/' + kind) == identity)
    require(expected['net'] != host)
    ip = environment.get('BIBCODE_UPLOAD_IP', '')
    require(Path(ip).is_absolute() and Path(ip).is_file() and str(Path(ip).resolve(strict=True)) == ip)

    def command(args, read=False):
        remaining = deadline - clock()
        require(remaining > 0)
        result, output = run_owned([ip, *args], timeout=min(2, remaining), grace=1)
        require(result.get('exitCode') == 0 and result.get('supervisorReaped') is True and
                result.get('timedOut') is False and result.get('cancelledSignal') is None)
        if not read:
            return None
        try:
            data = json.loads(output)
        except (ValueError, TypeError):
            raise NetworkRefused() from None
        require(isinstance(data, list) and all(isinstance(row, dict) for row in data))
        return data

    def observations():
        return (command(['-d', '-j', 'link', 'show'], True),
                command(['-j', 'address', 'show'], True),
                command(['-j', '-4', 'route', 'show', 'table', 'main'], True),
                command(['-j', '-6', 'route', 'show', 'table', 'main'], True))

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

    links, addresses, routes4, routes6 = observations()
    require(len(links) == 1 and links[0].get('ifname') == 'lo')
    require(all(loopback_route(row) for row in routes4 + routes6))
    check_addresses(addresses, False)
    loopback_index = links[0].get('ifindex')
    require(type(loopback_index) is int and loopback_index > 0)
    for args in MUTATIONS:
        command(args)
    links, addresses, routes4, routes6 = observations()
    require(len(links) == 3 and {row.get('ifname') for row in links} == {'lo', IN, PEER})
    owned = {row['ifname']: row for row in links}
    require(owned['lo'].get('ifindex') == loopback_index)
    for name, peer in [(IN, PEER), (PEER, IN)]:
        row = owned[name]
        require(type(row.get('ifindex')) is int and row['ifindex'] > 0)
        require(row.get('link_index') == owned[peer].get('ifindex'))
        require('link_netnsid' not in row and 'link-netnsid' not in row)
        require(row.get('linkinfo', {}).get('info_kind') == 'veth')
        require({'UP', 'LOWER_UP'}.issubset(row.get('flags', [])))
    require(len({row.get('ifindex') for row in links}) == 3)
    check_addresses(addresses, True)
    require(not any(row.get('dst') == 'default' for row in routes6))
    defaults = [row for row in routes4 if row.get('dst') == 'default']
    require(len(defaults) == 1 and defaults[0].get('gateway') == ADDRESSES[PEER] and defaults[0].get('dev') == IN)
    for row in routes4 + routes6:
        if row in defaults or loopback_route(row):
            continue
        require(row.get('dev') in ADDRESSES and 'gateway' not in row and row.get('protocol') == 'kernel')
        require(row.get('dst') in ['10.254.231.0/30', 'fe80::/64'])
        if 'prefsrc' in row:
            require(row['prefsrc'] == ADDRESSES[row['dev']])
    require(clock() <= deadline)
    # No delete/rollback: partial setup remains owned by existing PID1 namespace exit.
    return {'privateNet': True, 'pidOwnerMatches': True, 'userOwnerMatches': True,
            'loopbackOnlyBefore': True, 'linksContained': True, 'routeContained': True,
            'interfaceCount': 3, 'elapsedMs': max(0, int((clock() - started) * 1000))}
