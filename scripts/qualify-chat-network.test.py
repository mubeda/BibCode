"""Contained-network guard tests use only fake namespace/ip observations."""
import copy
import ast
import importlib.util
import json
from pathlib import Path
import inspect
import sys
import tempfile
import types
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
PAIR = [LO, {'ifindex': 2, 'ifname': 'bcup-in', 'link': 'bcup-peer',
             'linkinfo': {'info_kind': 'veth'}, 'flags': ['UP', 'LOWER_UP']},
        {'ifindex': 3, 'ifname': 'bcup-peer', 'link': 'bcup-in',
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

def actual_owner_handoff(root, scenario, matrix='core'):
    """Use actual producer/environment expressions without admitting a real process."""
    source = Path(__file__).with_name('qualify-chat-uploads.py')
    spec = importlib.util.spec_from_file_location('owner_qualification', source)
    qualifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(qualifier)
    module = ast.parse(source.read_text())
    outer = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'outer')
    command = next(node for node in outer.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'command' for target in node.targets))
    selection = next(node for node in outer.body if isinstance(node, ast.If) and any(isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name) and call.func.value.id == 'command' and call.func.attr == 'extend' for call in ast.walk(node)))
    fake = root / 'fake-host'; fake.write_bytes(b'owned inert file')
    web = root / 'web'; web.mkdir(); (web / 'index.html').write_text('owned inert web')
    scope = {**qualifier.__dict__, 'scenario': scenario, 'ui_matrix': matrix,
             'programs': {key: sys.executable for key in ['google-chrome', 'chromedriver', 'git', 'dirname', 'ip']} | {'unshare': '/owned/unshare'},
             'evidence': root / 'evidence', 'fixture': root, 'node': sys.executable, 'server': sys.executable,
             'namespace': 'net:[1]', 'provenance': {},
             'os': types.SimpleNamespace(environ={'GITHUB_SHA': 'a' * 40,
                 'BIBCODE_RELEASE_UI_FAKE_HOST': str(fake), 'BIBCODE_RELEASE_UI_WEB': str(web),
                 'BIBCODE_DELIVERY_UI_WEB': str(web)})}
    exec(compile(ast.Module(body=[command, selection], type_ignores=[]), 'actual-owner-command', 'exec'), scope)
    command = scope['command']
    owner = command[command.index('inner') - 2:]
    arguments = inspect.signature(qualifier.inner).bind(Path(owner[3]), Path(owner[4]), *owner[5:])
    arguments.apply_defaults()
    inner = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'inner')
    resources = next(node for node in inner.body if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == 'inner_resources')
    environment = next(node for node in ast.walk(inner) if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'environment' for target in node.targets))
    selected_environment = next(node for node in ast.walk(inner) if isinstance(node, ast.If) and any(isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name) and call.func.value.id == 'environment' and call.func.attr == 'update' for call in ast.walk(node)))
    scope = {**qualifier.__dict__, **arguments.arguments, 'private_namespace': 'net:[2]',
             'trusted_network': ENV, 'os': types.SimpleNamespace(environ={'PATH': '/owned/tools'}, pathsep=':')}
    exec(compile(ast.Module(body=[resources, environment, selected_environment], type_ignores=[]), 'actual-owner-environment', 'exec'), scope)
    return owner, scope['environment']

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
    def setup_network(self, fake, env=None, namespaces=None, owner=None, **kwargs):
        return network.setup(env or ENV, fake, readlink=(namespaces or NAMESPACES).__getitem__,
                             platform='linux', read_owner=lambda: ('\0'.join(OWNER if owner is None else owner) + '\0').encode(), read_capabilities=kwargs.pop('read_capabilities', lambda: b'CapEff:\t0000000000001000\n'), **kwargs)

    def test_actual_chat_and_both_ui_producers_satisfy_the_existing_containment_contract(self):
        for scenario, matrix, length in [('chat-upload', 'core', 14), ('remote-updates-ui', 'core', 18), ('remote-updates-ui', 'full', 18), ('delivery-retry-ui', 'core', 16), ('release-visual-core', 'core', 16), ('release-visual-settings', 'core', 16), ('release-visual-git-project', 'core', 16)]:
            with self.subTest(scenario=scenario, matrix=matrix), tempfile.TemporaryDirectory(prefix='bibcode-owner-contract-') as directory:
                owner, env = actual_owner_handoff(Path(directory), scenario, matrix)
                self.assertEqual(len(owner), length)
                fake = FakeIp(); proof = self.setup_network(fake, env=env, owner=owner)
                self.assertEqual(fake.mutations, MUTATIONS)
                self.assertTrue(proof['linksContained'])

    def test_owner_argument_forms_refuse_extra_empty_and_truncated_arguments(self):
        for scenario in ['chat-upload', 'remote-updates-ui', 'delivery-retry-ui', 'release-visual-core', 'release-visual-settings', 'release-visual-git-project']:
            with tempfile.TemporaryDirectory(prefix='bibcode-owner-arity-') as directory:
                owner, env = actual_owner_handoff(Path(directory), scenario)
                for invalid in [owner + [''], owner + ['unexpected'], owner[:-1]]:
                    fake = FakeIp()
                    with self.assertRaises(network.NetworkRefused): self.setup_network(fake, env=env, owner=invalid)
                    self.assertEqual(fake.calls, [])

    def test_ui_selector_and_every_declared_input_identity_refuse_before_ip_reads(self):
        with tempfile.TemporaryDirectory(prefix='bibcode-owner-identity-') as directory:
            owner, env = actual_owner_handoff(Path(directory), 'remote-updates-ui')
            other_file = Path(directory) / 'other-host'; other_file.write_bytes(b'owned')
            other_web = Path(directory) / 'other-web'; other_web.mkdir()
            cases = []
            for index, value in [(14, 'chat-upload'), (14, '../arbitrary'), (15, str(other_file.resolve())), (16, str(other_web.resolve())), (17, 'full'), (17, 'unknown')]:
                changed = list(owner); changed[index] = value; cases.append((changed, env))
            for key in ['BIBCODE_RELEASE_UI_FAKE_HOST', 'BIBCODE_RELEASE_UI_WEB', 'BIBCODE_RELEASE_UI_MATRIX']:
                changed = dict(env); changed.pop(key); cases.append((owner, changed))
            # A matched declaration still must have the exact canonical path and kind.
            alias = Path(directory) / 'alias-host'; alias.symlink_to(Path(owner[15]))
            for index, key, value in [(15, 'BIBCODE_RELEASE_UI_FAKE_HOST', owner[16]),
                                      (16, 'BIBCODE_RELEASE_UI_WEB', owner[15]),
                                      (15, 'BIBCODE_RELEASE_UI_FAKE_HOST', str(alias))]:
                changed = list(owner); changed[index] = value
                cases.append((changed, {**env, key: value}))
            cases.append((owner[:14], env))
            for invalid, environment in cases:
                fake = FakeIp()
                with self.assertRaises(network.NetworkRefused): self.setup_network(fake, env=environment, owner=invalid)
                self.assertEqual(fake.calls, [])

    def test_delivery_assets_and_selector_are_bound_to_the_exact_owner_before_ip_reads(self):
        with tempfile.TemporaryDirectory(prefix='delivery-owner-identity-') as directory:
            owner, env = actual_owner_handoff(Path(directory), 'delivery-retry-ui')
            other = Path(directory) / 'other-web'; other.mkdir()
            alias = Path(directory) / 'alias-web'; alias.symlink_to(Path(owner[15]))
            cases = []
            for index, value in [(14, 'remote-updates-ui'), (14, '../arbitrary'), (15, str(other.resolve()))]:
                changed = list(owner); changed[index] = value; cases.append((changed, env))
            missing = dict(env); missing.pop('BIBCODE_DELIVERY_UI_WEB'); cases.append((owner, missing))
            for value in ['relative-web', str(alias), sys.executable]:
                changed = list(owner); changed[15] = value
                cases.append((changed, {**env, 'BIBCODE_DELIVERY_UI_WEB': value}))
            cases.append((owner, {**env, 'BIBCODE_RELEASE_UI_MATRIX': 'core'}))
            cases.append((owner[:14], env))
            for invalid, environment in cases:
                fake = FakeIp()
                with self.assertRaises(network.NetworkRefused): self.setup_network(fake, env=environment, owner=invalid)
                self.assertEqual(fake.calls, [])

    def test_visual_selector_cannot_be_forged_or_downgraded_before_ip_reads(self):
        with tempfile.TemporaryDirectory(prefix='visual-owner-identity-') as directory:
            owner, env = actual_owner_handoff(Path(directory), 'release-visual-core')
            self.assertEqual(env.get('BIBCODE_DELIVERY_UI_SELECTION'), 'release-visual-core')
            cases = []
            for value in ['delivery-retry-ui', 'remote-updates-ui', 'release-visual-full', 'release-visual-settings']:
                changed = list(owner); changed[14] = value; cases.append((changed, env))
            for value in ['', 'full', 'delivery-retry-ui']:
                cases.append((owner, {**env, 'BIBCODE_DELIVERY_UI_SELECTION': value}))
            missing = dict(env); missing.pop('BIBCODE_DELIVERY_UI_SELECTION'); cases.append((owner, missing))
            missing_web = dict(env); missing_web.pop('BIBCODE_DELIVERY_UI_WEB'); cases.append((owner, missing_web))
            cases.append((owner[:14], env))
            for invalid, environment in cases:
                fake = FakeIp()
                with self.assertRaises(network.NetworkRefused): self.setup_network(fake, env=environment, owner=invalid)
                self.assertEqual(fake.calls, [])

    def test_settings_selector_and_assets_remain_exactly_bound_before_ip_reads(self):
        with tempfile.TemporaryDirectory(prefix='settings-owner-identity-') as directory:
            owner, env = actual_owner_handoff(Path(directory), 'release-visual-settings')
            self.assertEqual(env.get('BIBCODE_DELIVERY_UI_SELECTION'), 'release-visual-settings')
            alias = Path(directory) / 'alias-web'; alias.symlink_to(Path(owner[15]))
            cases = []
            for value in ['release-visual-core', 'delivery-retry-ui', 'remote-updates-ui', 'release-visual-full', '../arbitrary']:
                changed = list(owner); changed[14] = value; cases.append((changed, env))
                cases.append((owner, {**env, 'BIBCODE_DELIVERY_UI_SELECTION': value}))
            for key in ['BIBCODE_DELIVERY_UI_SELECTION', 'BIBCODE_DELIVERY_UI_WEB']:
                missing = dict(env); missing.pop(key); cases.append((owner, missing))
            for value in [str(alias), 'relative-web', sys.executable]:
                changed = list(owner); changed[15] = value
                cases.append((changed, {**env, 'BIBCODE_DELIVERY_UI_WEB': value}))
            cases.append((owner, {**env, 'BIBCODE_RELEASE_UI_MATRIX': 'core'}))
            for invalid, environment in cases:
                fake = FakeIp()
                with self.assertRaises(network.NetworkRefused): self.setup_network(fake, env=environment, owner=invalid)
                self.assertEqual(fake.calls, [])

    def test_git_project_selector_and_assets_remain_exactly_bound_before_ip_reads(self):
        with tempfile.TemporaryDirectory(prefix='git-project-owner-identity-') as directory:
            owner, env = actual_owner_handoff(Path(directory), 'release-visual-git-project')
            self.assertEqual(env.get('BIBCODE_DELIVERY_UI_SELECTION'), 'release-visual-git-project')
            alias = Path(directory) / 'alias-web'; alias.symlink_to(Path(owner[15]))
            cases = []
            for value in ['release-visual-core', 'release-visual-settings', 'delivery-retry-ui', 'remote-updates-ui', 'release-visual-full', '../arbitrary']:
                changed = list(owner); changed[14] = value; cases.append((changed, env))
                cases.append((owner, {**env, 'BIBCODE_DELIVERY_UI_SELECTION': value}))
            for key in ['BIBCODE_DELIVERY_UI_SELECTION', 'BIBCODE_DELIVERY_UI_WEB']:
                missing = dict(env); missing.pop(key); cases.append((owner, missing))
            for value in [str(alias), 'relative-web', sys.executable]:
                changed = list(owner); changed[15] = value
                cases.append((changed, {**env, 'BIBCODE_DELIVERY_UI_WEB': value}))
            cases.append((owner, {**env, 'BIBCODE_RELEASE_UI_MATRIX': 'core'}))
            for invalid, environment in cases:
                fake = FakeIp()
                with self.assertRaises(network.NetworkRefused): self.setup_network(fake, env=environment, owner=invalid)
                self.assertEqual(fake.calls, [])

    def test_original_owner_anchors_remain_required_for_both_forms(self):
        for scenario in ['chat-upload', 'remote-updates-ui', 'delivery-retry-ui', 'release-visual-core', 'release-visual-settings', 'release-visual-git-project']:
            with tempfile.TemporaryDirectory(prefix='bibcode-owner-anchor-') as directory:
                owner, env = actual_owner_handoff(Path(directory), scenario)
                for index, value in [(0, '/missing-python'), (1, '/missing-helper'), (2, 'outer'), (11, 'net:[99]'), (13, '/missing-ip')]:
                    invalid = list(owner); invalid[index] = value; fake = FakeIp()
                    with self.assertRaises(network.NetworkRefused): self.setup_network(fake, env=env, owner=invalid)
                    self.assertEqual(fake.calls, [])
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
            if change == 'peer': fake.after_links[1]['link'] = 'wrong-peer'
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


    def test_failure_receipt_counts_each_attempt_and_joined_completion(self):
        stages = ['mutation-pair', 'mutation-address-in', 'mutation-address-peer', 'mutation-up-in', 'mutation-up-peer', 'mutation-default']
        for step, stage in enumerate(stages, 1):
            fake = FakeIp(); fake.fail_at = step
            with self.assertRaises(network.NetworkRefused) as failure: self.setup_network(fake)
            self.assertEqual(failure.exception.proof, {'stage': stage, 'attemptedMutations': step, 'completedMutations': step - 1, 'netAdminEffective': True,
                'lastCommand': {'exitCode': 124, 'timedOut': True, 'cancelled': False, 'reaped': True}})
    def test_guard_and_postcondition_failure_stages_preserve_accurate_counts(self):
        fake = FakeIp(); ns = {**NAMESPACES, '/proc/self/ns/net': 'net:[9]'}
        with self.assertRaises(network.NetworkRefused) as failure: self.setup_network(fake, namespaces=ns)
        self.assertEqual(failure.exception.proof['stage'], 'namespace-net')
        self.assertEqual(failure.exception.proof['attemptedMutations'], 0)
        self.assertIsNone(failure.exception.proof['lastCommand'])
        fake = FakeIp(); fake.after_links[1]['link'] = 'wrong-peer'
        with self.assertRaises(network.NetworkRefused) as failure: self.setup_network(fake)
        self.assertEqual(failure.exception.proof['stage'], 'after-peer-relation-check')
        self.assertEqual(failure.exception.proof['completedMutations'], 6)
    def test_status_projection_never_retains_foreign_fields_or_raw_exceptions(self):
        secret = 'foreign-route-namespace-path-error-secret'
        def malformed(*_args, **_kwargs):
            return {'exitCode': secret, 'timedOut': secret, 'cancelledSignal': secret, 'supervisorReaped': secret, 'argv': secret, 'stderr': secret}, secret.encode()
        with self.assertRaises(network.NetworkRefused) as failure: self.setup_network(malformed)
        self.assertNotIn(secret, json.dumps(failure.exception.proof))
        self.assertEqual(failure.exception.proof['lastCommand'], {'exitCode': None, 'timedOut': None, 'cancelled': None, 'reaped': None})
        def raised(*_args, **_kwargs): raise RuntimeError(secret)
        with self.assertRaises(network.NetworkRefused) as failure: self.setup_network(raised)
        self.assertNotIn(secret, json.dumps(failure.exception.proof))
        self.assertEqual(failure.exception.proof['stage'], 'before-links-read')


    def test_capability_observation_is_boolean_or_unknown_without_altering_guard(self):
        for raw, expected in [(b'CapEff:\t0000000000000000\n', False), (b'CapEff:\t0000000000001000\n', True), (b'foreign-secret', None)]:
            fake = FakeIp(); fake.fail_at = 1
            with self.assertRaises(network.NetworkRefused) as failure: self.setup_network(fake, read_capabilities=lambda: raw)
            self.assertIs(failure.exception.proof['netAdminEffective'], expected)
            self.assertEqual(fake.mutations, MUTATIONS[:1])
            self.assertNotIn('foreign-secret', json.dumps(failure.exception.proof))


    def test_documented_reciprocal_local_names_accept_different_unique_indices(self):
        fake = FakeIp(); fake.after_links[1]['ifindex'] = 23; fake.after_links[2]['ifindex'] = 29
        self.assertTrue(self.setup_network(fake)['linksContained'])
        self.assertEqual(fake.mutations, MUTATIONS)

    def test_peer_representation_refusal_matrix_has_closed_predicate_stages(self):
        cases = ['missing', 'null', 'wrong', 'self', 'lo', 'asymmetric', 'numeric', 'numeric-only', 'mixed', 'foreign', 'foreign-negative', 'foreign-hyphen', 'duplicate', 'invalid-index']
        for case in cases:
            with self.subTest(case=case):
                fake = FakeIp(); row = fake.after_links[1]; stage = 'after-peer-relation-check'
                if case == 'missing': row.pop('link')
                elif case == 'null': row['link'] = None
                elif case == 'wrong': row['link'] = 'foreign-name-secret'
                elif case == 'self': row['link'] = 'bcup-in'
                elif case == 'lo': row['link'] = 'lo'
                elif case == 'asymmetric': fake.after_links[2]['link'] = 'bcup-peer'
                elif case == 'numeric': row['link'] = 3
                elif case == 'numeric-only': row.pop('link'); row['link_index'] = 3
                elif case == 'mixed': row['link_index'] = 3; stage = 'after-peer-format-check'
                elif case.startswith('foreign'):
                    key = 'link-netnsid' if case == 'foreign-hyphen' else 'link_netnsid'
                    row[key] = -1 if case == 'foreign-negative' else 0; stage = 'after-peer-namespace-check'
                elif case == 'duplicate': fake.after_links[2]['ifindex'] = 2; stage = 'after-indices-check'
                else: row['ifindex'] = True; stage = 'after-ifindex-check'
                with self.assertRaises(network.NetworkRefused) as failure: self.setup_network(fake)
                self.assertEqual(failure.exception.proof['stage'], stage)
                self.assertEqual(failure.exception.proof['completedMutations'], 6)
                self.assertNotIn('secret', json.dumps(failure.exception.proof))

    def test_loopback_veth_carrier_address_and_route_checks_remain_required(self):
        for case, stage in [('loopback', 'after-loopback-check'), ('veth', 'after-veth-check'), ('carrier', 'after-carrier-check'), ('address', 'after-addresses-check'), ('route', 'after-routes-check')]:
            with self.subTest(case=case):
                fake = FakeIp()
                if case == 'loopback': fake.after_links[0]['ifindex'] = 99
                elif case == 'veth': fake.after_links[1]['linkinfo']['info_kind'] = 'dummy'
                elif case == 'carrier': fake.after_links[1]['flags'] = ['UP']
                elif case == 'address': fake.after_addresses[1]['addr_info'][0]['prefixlen'] = 31
                else: fake.after_routes.append({'dst': '10.1.0.0/16', 'dev': 'bcup-in', 'protocol': 'kernel'})
                with self.assertRaises(network.NetworkRefused) as failure: self.setup_network(fake)
                self.assertEqual(failure.exception.proof['stage'], stage)
                self.assertEqual(fake.mutations, MUTATIONS)

if __name__ == '__main__': unittest.main()
