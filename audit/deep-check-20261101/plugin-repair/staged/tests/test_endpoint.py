import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge_endpoint', Path(__file__).parents[1] / 'server.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class EndpointTests(unittest.TestCase):
    def endpoint(self, base, env=None):
        with tempfile.TemporaryDirectory() as td:
            jar = Path(td) / 'session.json'
            jar.write_text(json.dumps({'base': base, 'cookie': 'dsh-auth-test=fixture'}))
            with patch.dict('os.environ', env or {}, clear=True), patch.object(m.socket, 'gethostbyname_ex', return_value=('local', [], ['192.168.1.30'])):
                return m.DshClient(jar).connection()[0]

    def test_saved_stale_lan_is_never_contacted(self):
        self.assertEqual(self.endpoint('http://192.168.124.5:4200'), 'http://127.0.0.1:4200')

    def test_current_lan_also_uses_stable_loopback(self):
        self.assertEqual(self.endpoint('http://192.168.1.30:4200'), 'http://127.0.0.1:4200')

    def test_remote_explicit_override_not_rewritten(self):
        with self.assertRaises(m.BridgeError):
            self.endpoint('http://127.0.0.1:4200', {'DSH_BASE':'http://192.168.124.5:4200'})

    def test_remote_public_and_dns_rejected(self):
        for base in ['http://8.8.8.8:4200','http://example.com:4200','http://192.168.124.5']:
            with self.subTest(base=base), self.assertRaises(m.BridgeError):
                self.endpoint(base)

    def test_malformed_remote_never_falls_back(self):
        for base in ['http://user:pw@192.168.124.5:4200','http://192.168.124.5:4200/api','http://192.168.124.5:4200?q=1','http://192.168.124.5:4200#x','http://192.168.124.5:no','https://192.168.124.5:4200']:
            with self.subTest(base=base), self.assertRaises(m.BridgeError):
                self.endpoint(base)

    def test_loopback_preserved(self):
        for base in ['http://127.0.0.1:4200','http://[::1]:4200','http://localhost:4200']:
            self.assertEqual(self.endpoint(base),base)
