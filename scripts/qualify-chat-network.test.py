"""Contained-network guard tests use only fake namespace/ip observations."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location('network', Path(__file__).with_name('qualify-chat-network.py'))
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)

ENV = {'CI': 'true', 'BIBCODE_UPLOAD_HOST_NETNS': 'net:[1]', 'BIBCODE_UPLOAD_NETNS': 'net:[2]',
       'BIBCODE_UPLOAD_PIDNS': 'pid:[3]', 'BIBCODE_UPLOAD_USERNS': 'user:[4]',
       'BIBCODE_UPLOAD_IP': str(Path(sys.executable).resolve()),
       'BIBCODE_UPLOAD_PYTHON': str(Path(sys.executable).resolve()),
       'BIBCODE_UPLOAD_NETWORK_HELPER': str(Path(__file__).with_name('qualify-chat-uploads.py').resolve())}
OWNER = [sys.executable, ENV['BIBCODE_UPLOAD_NETWORK_HELPER'], 'inner', 'evidence', 'fixture', 'node', 'server', 'chrome', 'driver', 'git', 'dirname', 'net:[1]', 'source', ENV['BIBCODE_UPLOAD_IP']]
NAMESPACES = {f'/proc/{owner}/ns/{kind}': value for owner in ['self', '1']
              for kind, value in [('net', 'net:[2]'), ('pid', 'pid:[3]'), ('user', 'user:[4]')]}
LO = {'ifindex': 1, 'ifname': 'lo'}
PAIR = [LO, {'ifindex': 2, 'ifname': 'bcup-in', 'link_index': 3,
             'linkinfo': {'info_kind': 'veth'}, 'flags': ['UP', 'LOWER_UP']},
        {'ifindex': 3, 'ifname': 'bcup-peer', 'link_index': 2,
         'linkinfo': {'info_kind': 'veth'}, 'flags': ['UP', 'LOWER_UP']}]
ADDRESSES = [{'ifname': 'lo', 'addr_info': [{'family': 'inet', 'local': '127.0.0.1', 'prefixlen': 8}]},
             {'ifname': 'bcup-in', 'addr_info': [{'family': 'inet', 'local': '10.254.231.1', 'prefixlen': 30}]},
             {'ifname': 'bcup-peer', 'addr_info': [{'family': 'inet', 'local': '10.254.231.2', 'prefixlen': 30}]}]
ROUTES = [{'dst': 'default', 'gateway': '10.254.231.2', 'dev': 'bcup-in'},
          {'dst': '10.254.231.0/30', 'dev': 'bcup-in', 'protocol': 'kernel', 'prefsrc': '10.254.231.1'}]
MUTATIONS = [['link', 'add', 'bcup-in', 'type', 'veth', 'peer', 'name', 'bcup-peer'],
             ['address', 'add', '10.254.231.1/30', 'dev', 'bcup-in'],
             ['address', 'add', '10.254.231.2/30', 'dev', 'bcup-peer'],
             ['link', 'set', 'dev', 'bcup-in', 'up'], ['link', 'set', 'dev', 'bcup-peer', 'up'],
             ['route', 'add', 'default', 'via', '10.254.231.2', 'dev', 'bcup-in']]

class FakeIp:
    def __init__(self):
        self.calls = []
        self.mutations = []
        self.before_links = [LO]
        self.before_routes = []
        self.before_routes6 = []
        self.after_links = copy.deepcopy(PAIR)
        self.after_addresses = copy.deepcopy(ADDRESSES)
        self.after_routes = copy.deepcopy(ROUTES)
        self.fail_at = None
    def __call__(self, argv, **options):
        self.calls.append((argv, options))
        args = argv[1:]
        result = {'exitCode': 0, 'timedOut': False, 'cancelledSignal': None, 'supervisorReaped': True}
        if '-j' not in args:
            self.mutations.append(args)
            if len(self.mutations) == self.fail_at:
                result.update(exitCode=124, timedOut=True)
            return result, b''
        after = len(self.mutations) == len(MUTATIONS)
        if 'link' in args: value = self.after_links if after else self.before_links
        elif 'address' in args: value = self.after_addresses if after else ADDRESSES[:1]
        elif '-6' in args: value = [] if after else self.before_routes6
        else: value = self.after_routes if after else self.before_routes
        return result, json.dumps(value).encode()

class NetworkTests(unittest.TestCase):
    def setup_network(self, fake, env=None, namespaces=None, **kwargs):
        return network.setup(env or ENV, fake, readlink=(namespaces or NAMESPACES).__getitem__,
                             platform='linux', read_owner=lambda: '\0'.join(OWNER).encode(), **kwargs)
    def test_wrong_namespace_refuses_before_ip_mutations(self):
        for path, wrong in [('/proc/self/ns/net', 'net:[1]'), ('/proc/1/ns/net', 'net:[8]'),
                            ('/proc/self/ns/pid', 'pid:[8]'), ('/proc/1/ns/user', 'user:[8]')]:
            fake = FakeIp(); ns = {**NAMESPACES, path: wrong}
            with self.assertRaises(network.NetworkRefused): self.setup_network(fake, namespaces=ns)
            self.assertEqual(fake.calls, [])
        fake = FakeIp()
        with self.assertRaises(network.NetworkRefused): self.setup_network(fake, env={**ENV, 'CI': 'false'})
        self.assertEqual(fake.calls, [])
    def test_foreign_pid1_owner_refuses_before_ip_reads(self):
        fake = FakeIp()
        with self.assertRaises(network.NetworkRefused):
            network.setup(ENV, fake, readlink=NAMESPACES.__getitem__, platform='linux', read_owner=lambda: b'/sbin/init\0')
        self.assertEqual(fake.calls, [])

    def test_foreign_link_reserved_name_and_route_refuse_with_zero_mutations(self):
        for name in ['eth0', 'bcup-in', 'bcup-peer']:
            fake = FakeIp(); fake.before_links = [LO, {'ifindex': 2, 'ifname': name}]
            with self.assertRaises(network.NetworkRefused): self.setup_network(fake)
            self.assertEqual(fake.mutations, [])
        for route in [{'dst': 'default', 'dev': 'lo'}, {'dst': '10.0.0.0/8', 'dev': 'lo'}, {'dst': 'default', 'gateway': 'secret'}]:
            fake = FakeIp(); fake.before_routes = [route]
            with self.assertRaises(network.NetworkRefused): self.setup_network(fake)
            self.assertEqual(fake.mutations, [])
    def test_foreign_ipv6_route_refuses_with_zero_mutations(self):
        fake = FakeIp(); fake.before_routes6 = [{'dst': 'default', 'dev': 'lo'}]
        with self.assertRaises(network.NetworkRefused): self.setup_network(fake)
        self.assertEqual(fake.mutations, [])

    def test_literal_setup_order_and_closed_postcondition_evidence(self):
        fake = FakeIp(); proof = self.setup_network(fake)
        self.assertEqual(fake.mutations, MUTATIONS)
        self.assertTrue(proof['privateNet']); self.assertTrue(proof['linksContained']); self.assertTrue(proof['routeContained'])
        self.assertEqual(proof['interfaceCount'], 3)
        self.assertTrue(all(type(v) in [bool, int] for v in proof.values()))
        self.assertTrue(all(0 < options['timeout'] <= 2 for _, options in fake.calls))
    def test_each_failed_step_stops_mutation_and_uses_namespace_exit_cleanup(self):
        for step in range(1, 7):
            fake = FakeIp(); fake.fail_at = step
            with self.assertRaises(network.NetworkRefused): self.setup_network(fake)
            self.assertEqual(fake.mutations, MUTATIONS[:step])
            self.assertFalse(any('delete' in args or 'replace' in args for args in fake.mutations))
    def test_foreign_peer_address_or_default_postcondition_refuses(self):
        for change in ['peer', 'netns', 'address', 'route']:
            fake = FakeIp()
            if change == 'peer': fake.after_links[1]['link_index'] = 8
            elif change == 'netns': fake.after_links[1]['link_netnsid'] = 0
            elif change == 'address': fake.after_addresses[1]['addr_info'][0]['local'] = '10.1.1.1'
            else: fake.after_routes.append({'dst': 'default', 'gateway': 'secret', 'dev': 'bcup-peer'})
            with self.assertRaises(network.NetworkRefused): self.setup_network(fake)
            self.assertEqual(fake.mutations, MUTATIONS)
    def test_deadline_or_unjoined_command_refuses(self):
        fake = FakeIp(); times = iter([0, 0, 21])
        with self.assertRaises(network.NetworkRefused): self.setup_network(fake, clock=lambda: next(times))
        self.assertEqual(fake.mutations, [])
        def unjoined(*_args, **_kwargs):
            return {'exitCode': 0, 'timedOut': False, 'cancelledSignal': None, 'supervisorReaped': False}, b'[]'
        with self.assertRaises(network.NetworkRefused): self.setup_network(unjoined)

if __name__ == '__main__': unittest.main()
