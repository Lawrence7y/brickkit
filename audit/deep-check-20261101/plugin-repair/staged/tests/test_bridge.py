import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('dsh_bridge', Path(__file__).resolve().parents[1] / 'server.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FakeClient:
    def __init__(self):
        self.calls = []
        self.rows = [{'sessionId': 's', 'running': False, 'projections': {'asOfSeq': 4,
            'values': {'modelSelection': {'next': {'provider': 'p', 'model': 'model'}}}}}]
        self.fail = False
        self.poison = False
        self.workspace = None
        self.omit_attachment = False

    def sessions(self):
        return self.rows

    def find(self, sid):
        return next(x for x in self.rows if x['sessionId'] == sid)

    def rpc(self, method, args):
        self.calls.append((method, args))
        if method == 'session/modelCatalog':
            return {'groups': [{'id': 'p', 'models': [{'id': 'model'}]}], 'routableProviders': ['p']}
        if method == 'workspace/create':
            if self.workspace is None:
                self.workspace = {'workspaceId': 'w', 'path': args['request']['path'], 'sessionIds': []}
            return {'workspace': self.workspace}
        if method == 'session/create':
            sid = args['request']['sessionId']
            if 'workspaceId' in args['request'] and not self.omit_attachment:
                self.workspace['sessionIds'].append(sid)
            self.rows.append({'sessionId': sid, 'running': False, 'projections': {'values': {}}})
            return {'sessionId': sid}
        if method == 'session/selectModel':
            selected = {k: v for k, v in args['request'].items() if k != 'sessionId'}
            self.find(args['request']['sessionId'])['projections']['values']['modelSelection'] = {'next': selected if not self.poison else {}}
            return {'selected': selected}
        if method == 'session/prompt':
            if self.fail:
                raise m.BridgeError('uncertain')
            return {'accepted': True}
        if method == 'session/page':
            return {'records': [{'event': {'type': 'assistant/message', 'data': {'message': {'content': [{'type': 'text', 'text': 'OK'}]}}}}]}
        return {'accepted': True}


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.client = FakeClient()
        self.bridge = m.Bridge(self.client, self.temp.name)

    def send(self, **extra):
        return self.bridge.call('dsh_send', {'session_id': 's', 'prompt': 'hello', 'request_id': 'r', **extra})

    def test_duplicate_not_resent(self):
        self.assertEqual(self.send()['state'], 'accepted')
        self.assertTrue(self.send()['duplicate'])
        self.assertEqual(sum(n == 'session/prompt' for n, _ in self.client.calls), 1)

    def test_id_reused_for_other_input_rejected(self):
        self.send()
        with self.assertRaises(m.BridgeError):
            self.send(prompt='other')

    def test_uncertain_write_not_retried(self):
        self.client.fail = True
        with self.assertRaises(m.BridgeError):
            self.send()
        self.assertEqual(self.send()['state'], 'uncertain')
        self.assertEqual(sum(n == 'session/prompt' for n, _ in self.client.calls), 1)

    def test_busy_session_not_written(self):
        self.client.rows[0]['running'] = True
        with self.assertRaises(m.BridgeError):
            self.send()
        self.assertFalse(self.client.calls)

    def test_model_not_found_no_create(self):
        with self.assertRaises(m.BridgeError):
            self.bridge.call('dsh_create_session', {'cwd': self.temp.name, 'provider': 'p', 'model': 'bad'})
        self.assertFalse(any(n == 'session/create' for n, _ in self.client.calls))

    def test_official_providers_never_created_or_prompted(self):
        for provider in ['deepseek-official', 'deepseek-account']:
            with self.assertRaises(m.BridgeError):
                self.bridge.call('dsh_create_session', {'cwd': self.temp.name, 'provider': provider, 'model': 'deepseek-flash'})
            self.client.rows[0]['projections']['values']['modelSelection']['next']['provider'] = provider
            with self.assertRaises(m.BridgeError):
                self.send()
        self.assertFalse(self.client.calls)

    def test_create_reads_back_selection(self):
        result = self.bridge.call('dsh_create_session', {'cwd': self.temp.name, 'provider': 'p', 'model': 'model'})
        self.assertFalse(result['prompt_sent'])
        self.assertEqual(result['selected'], result['verified_projection'])
        self.assertTrue(result['workspace_attached'])
        request = next(a['request'] for n, a in self.client.calls if n == 'session/create')
        self.assertEqual(request['workspaceId'], 'w')
        self.assertNotIn('cwd', request)

    def test_missing_workspace_attachment_rejected_before_selection(self):
        self.client.omit_attachment = True
        with self.assertRaisesRegex(m.BridgeError, '成员关系'):
            self.bridge.call('dsh_create_session', {'cwd': self.temp.name, 'provider': 'p', 'model': 'model'})
        self.assertFalse(any(n == 'session/selectModel' for n, _ in self.client.calls))

    def test_wrong_workspace_path_rejected_before_session_create(self):
        self.client.workspace = {'workspaceId': 'w', 'path': str(Path(self.temp.name) / 'other'), 'sessionIds': []}
        with self.assertRaises(m.BridgeError):
            self.bridge.call('dsh_create_session', {'cwd': self.temp.name, 'provider': 'p', 'model': 'model'})
        self.assertFalse(any(n == 'session/create' for n, _ in self.client.calls))

    def test_wrong_model_projection_rejected(self):
        self.client.poison = True
        with self.assertRaisesRegex(m.BridgeError, '读回不一致'):
            self.bridge.call('dsh_create_session', {'cwd': self.temp.name, 'provider': 'p', 'model': 'model'})

    def test_read_keeps_running_distinct_from_reply(self):
        self.client.rows[0]['running'] = True
        result = self.bridge.call('dsh_read', {'session_id': 's'})
        self.assertTrue(result['running'])
        self.assertEqual(result['assistant_text'], 'OK')

    def test_invalid_arguments(self):
        for args in [{'session_id': 's', 'max_messages': True}, {'session_id': 's', 'max_messages': 101}, {'session_id': 's', 'unknown': 'x'}]:
            with self.assertRaises(m.BridgeError):
                self.bridge.call('dsh_read', args)

    def test_failed_turn_is_reported_without_assistant_text(self):
        original = self.client.rpc
        def failing_page(method, args):
            if method == 'session/page':
                return {'records': [{'event': {'type': 'turn/end', 'data': {'reason': {'kind': 'error', 'error': {'code': 'AUTH'}}}}}]}
            return original(method, args)
        self.client.rpc = failing_page
        value = self.bridge.call('dsh_read', {'session_id': 's'})
        self.assertEqual(value['assistant_text'], '')
        self.assertEqual(value['errors'][0]['error']['code'], 'AUTH')

    def test_new_turn_does_not_inherit_previous_completion(self):
        original = self.client.rpc
        def new_page(method, args):
            if method == 'session/page':
                return {'records': [{'event': {'type': 'turn/end', 'data': {'reason': {'kind': 'completed'}}}},
                                    {'event': {'type': 'turn/start', 'data': {'turn': 2}}}]}
            return original(method, args)
        self.client.rpc = new_page
        value = self.bridge.call('dsh_read', {'session_id': 's'})
        self.assertIsNone(value['last_turn_reason'])

    def test_remote_cookie_exfiltration_rejected(self):
        jar = Path(self.temp.name) / 'cookie.json'
        jar.write_text(json.dumps({'base': 'http://example.com:4200', 'cookie': 'dsh-auth-test=secret'}))
        with patch.dict('os.environ', {}, clear=True):
            with self.assertRaises(m.BridgeError):
                m.DshClient(jar).connection()

    def test_rpc_correlation_and_redacted_error(self):
        jar = Path(self.temp.name) / 'cookie.json'
        jar.write_text(json.dumps({'base': 'http://127.0.0.1:4200', 'cookie': 'dsh-auth-test=secret'}))
        client = m.DshClient(jar)
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return json.dumps({'type': 'server-response', 'rpcId': 'wrong', 'result': {'ok': True, 'value': {}}}).encode()
        with patch.dict('os.environ', {}, clear=True), patch.object(client.opener, 'open', return_value=Response()):
            with self.assertRaises(m.BridgeError) as error:
                client.rpc('session/list', {'_request': {}})
            self.assertNotIn('secret', str(error.exception))

    def test_mcp_initialize_list_and_error(self):
        init = m.handle({'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26'}}, self.bridge)
        self.assertEqual(init['result']['protocolVersion'], '2025-03-26')
        tools = m.handle({'id': 2, 'method': 'tools/list'}, self.bridge)
        self.assertEqual(len(tools['result']['tools']), 7)
        bad = m.handle({'id': 3, 'method': 'tools/call', 'params': {'name': 'bad'}}, self.bridge)
        self.assertTrue(bad['result']['isError'])
        self.assertIsNone(m.handle({'method': 'notifications/initialized'}, self.bridge))


if __name__ == '__main__':
    unittest.main()
