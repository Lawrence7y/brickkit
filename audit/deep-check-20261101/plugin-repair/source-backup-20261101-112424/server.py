"""DSH authenticated local RPC bridge and newline-delimited stdio MCP server."""
import argparse
import json
import os
from pathlib import Path
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


class BridgeError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class DshClient:
    def __init__(self, jar=None, timeout=20):
        self.jar = Path(jar or os.environ.get('DSH_COOKIE_JAR', str(Path.home() / '.dsh/lan/session.json')))
        self.timeout = timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def connection(self):
        try:
            saved = json.loads(self.jar.read_text(encoding='utf-8-sig'))
            base = os.environ.get('DSH_BASE', saved['base']).rstrip('/')
            cookie = saved['cookie']
        except (OSError, ValueError, KeyError) as exc:
            raise BridgeError('DSH 登录态缺失；使用 DSH 自带 LAN 客户端重新登录。') from exc
        parsed = urllib.parse.urlsplit(base)
        local = {'127.0.0.1', '::1', 'localhost'}
        try:
            local.update(socket.gethostbyname_ex(socket.gethostname())[2])
        except socket.gaierror:
            pass
        if (parsed.scheme != 'http' or parsed.hostname not in local or parsed.username
                or parsed.password or parsed.path or parsed.query or parsed.fragment):
            raise BridgeError('只允许连接本机 DSH HTTP 地址；登录态不能发往其他机器。')
        if not isinstance(cookie, str) or not cookie.startswith('dsh-auth-') or '\r' in cookie or '\n' in cookie:
            raise BridgeError('DSH cookie 格式无效。')
        return base, cookie

    def rpc(self, method, args):
        base, cookie = self.connection()
        rid = str(uuid.uuid4())
        body = {'type': 'client-request', 'rpcId': rid, 'method': method, 'payload': {'args': args}}
        request = urllib.request.Request(base + '/api/' + method,
            data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
            headers={'Content-Type': 'application/json', 'Cookie': cookie})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
                if len(raw) > 8 * 1024 * 1024:
                    raise BridgeError('DSH 响应超过 8 MiB；请缩小查询。')
            data = json.loads(raw)
        except urllib.error.HTTPError as exc:
            raise BridgeError(f'DSH HTTP {exc.code}；401 需更新登录态，404 表示版本不支持该接口。') from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise BridgeError('DSH 连接失败或超时；写操作结果可能不确定，不要自动重发。') from exc
        except (ValueError, UnicodeError) as exc:
            raise BridgeError('DSH 返回了无效 JSON。') from exc
        if not isinstance(data, dict) or data.get('rpcId') != rid or data.get('type') != 'server-response':
            raise BridgeError('DSH 响应关联 ID 或类型不匹配。')
        result = data.get('result')
        if not isinstance(result, dict) or result.get('ok') is not True:
            error = result.get('error', {}) if isinstance(result, dict) else {}
            raise BridgeError('DSH RPC 失败：' + str(error.get('code', 'invalid-response')))
        return result.get('value')

    def sessions(self):
        value = self.rpc('session/list', {'_request': {}})
        if not isinstance(value, dict) or not isinstance(value.get('items'), list):
            raise BridgeError('DSH 会话列表格式无效。')
        return value['items']

    def find(self, sid):
        item = next((s for s in self.sessions() if s.get('sessionId') == sid), None)
        if item is None:
            raise BridgeError('DSH 会话不存在或不可见。')
        return item


def schema(properties=None, required=None):
    return {'type': 'object', 'properties': properties or {}, 'required': required or [], 'additionalProperties': False}


STRING = {'type': 'string', 'minLength': 1}
TOOLS = [
    ('dsh_status', '只读检查 DSH 连接、会话数量及默认模型，不返回凭据。', schema()),
    ('dsh_models', '读取 DSH 实际模型目录；身份与执行成功仍需单独核验。', schema()),
    ('dsh_sessions', '读取会话状态，可按工作区过滤，最多返回 100 条。', schema({'cwd': STRING, 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100}})),
    ('dsh_create_session', '创建独立 DSH 会话并选择指定模型，核对选择后返回；不发送提示词。', schema({'cwd': STRING, 'provider': STRING, 'model': STRING, 'reasoning_effort': STRING}, ['cwd', 'provider', 'model'])),
    ('dsh_send', '向用户授权的 DSH 会话发送一次提示词；request_id 用于本地防重，不自动重试。', schema({'session_id': STRING, 'prompt': STRING, 'request_id': STRING}, ['session_id', 'prompt', 'request_id'])),
    ('dsh_read', '读取指定 DSH 会话的状态和最近历史，区分运行、回复和错误。', schema({'session_id': STRING, 'max_messages': {'type': 'integer', 'minimum': 1, 'maximum': 100}}, ['session_id'])),
    ('dsh_cancel', '取消用户明确要求停止的 DSH 会话。', schema({'session_id': STRING}, ['session_id'])),
]


class Bridge:
    def __init__(self, client=None, state=None):
        self.client = client or DshClient()
        self.state = Path(state or os.environ.get('DSH_BRIDGE_STATE', str(Path.home() / '.codex/dsh-bridge/requests')))

    def selection(self, provider, model, effort=None):
        if provider in {'deepseek-official', 'deepseek-account'}:
            raise BridgeError('用户禁止使用两个官方 DeepSeek 供应商；请使用 opencode-go 的 deepseek-v4.1-flash。')
        catalog = self.client.rpc('session/modelCatalog', {})
        group = next((g for g in catalog['groups'] if g['id'] == provider), None)
        found = next((m for m in group['models'] if m['id'] == model), None) if group else None
        if found is None or provider not in catalog.get('routableProviders', []):
            raise BridgeError('指定 provider/model 未在 DSH 可路由模型目录中，未创建会话。')
        if effort and effort not in [e['id'] for e in found.get('reasoning', {}).get('efforts', [])]:
            raise BridgeError('该模型不支持指定 reasoning_effort。')
        return {'provider': provider, 'model': model, **({'reasoningEffort': effort} if effort else {})}

    def call(self, name, args):
        entry = next((t for t in TOOLS if t[0] == name), None)
        if entry is None:
            raise BridgeError('未知工具。')
        self.validate(entry[2], args)
        c = self.client
        if name == 'dsh_status':
            base, _ = c.connection()
            return {'connected': True, 'base': base, 'session_count': len(c.sessions()),
                    'default_model': c.rpc('session/modelCatalog', {}).get('default'), 'protocol': 'typert-slash-rpc'}
        if name == 'dsh_models':
            return c.rpc('session/modelCatalog', {})
        if name == 'dsh_sessions':
            items = c.sessions()
            if 'cwd' in args:
                items = [s for s in items if os.path.normcase(s.get('cwd', '')) == os.path.normcase(args['cwd'])]
            limit = args.get('limit', 20)
            return {'total': len(items), 'items': items[:limit]}
        if name == 'dsh_create_session':
            cwd = Path(args['cwd'])
            if not cwd.is_absolute() or not cwd.is_dir():
                raise BridgeError('cwd 必须是本机现存绝对目录。')
            selected = self.selection(args['provider'], args['model'], args.get('reasoning_effort'))
            workspace = c.rpc('workspace/create', {'request': {'path': str(cwd)}}).get('workspace', {})
            wid = workspace.get('workspaceId')
            if not isinstance(wid, str) or not wid or os.path.normcase(os.path.normpath(workspace.get('path', ''))) != os.path.normcase(str(cwd.resolve())):
                raise BridgeError('DSH 工作区身份或路径读回不一致，未创建会话。')
            sid = 'session-' + str(uuid.uuid4())
            try:
                created = c.rpc('session/create', {'request': {'workspaceId': wid, 'sessionId': sid}})
                if created.get('sessionId') != sid:
                    raise BridgeError('DSH 创建会话返回了不同 ID。')
                attached = c.rpc('workspace/create', {'request': {'path': str(cwd)}}).get('workspace', {})
                if attached.get('workspaceId') != wid or sid not in attached.get('sessionIds', []):
                    raise BridgeError('DSH 会话未读回工作区成员关系；尚未发送提示词。')
                chosen = c.rpc('session/selectModel', {'request': {'sessionId': sid, **selected}})
                current = c.find(sid).get('projections', {}).get('values', {}).get('modelSelection', {}).get('next')
                if chosen.get('selected') != selected or current != selected:
                    raise BridgeError('DSH 模型选择读回不一致；尚未发送提示词。')
            except BridgeError as exc:
                raise BridgeError(f'会话 {sid}：{exc}') from exc
            return {'session_id': sid, 'workspace_id': wid, 'workspace_path': attached['path'],
                    'workspace_attached': True, 'selected': selected, 'verified_projection': current, 'prompt_sent': False}
        if name == 'dsh_send':
            sid = args['session_id']
            item = c.find(sid)
            selected = item.get('projections', {}).get('values', {}).get('modelSelection', {}).get('next')
            if selected is None:
                selected = c.rpc('session/modelCatalog', {}).get('default')
            if not isinstance(selected, dict) or selected.get('provider') in {'deepseek-official', 'deepseek-account'}:
                raise BridgeError('发送被拒绝：会话模型未确认或使用了用户禁止的官方 DeepSeek 供应商。')
            if item.get('running'):
                raise BridgeError('会话正在运行；请另建独立会话或等其完成。')
            self.state.mkdir(parents=True, exist_ok=True)
            key = uuid.uuid5(uuid.NAMESPACE_URL, args['request_id']).hex
            path = self.state / (key + '.json')
            import hashlib
            fingerprint = hashlib.sha256(json.dumps(args, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            record = {'session_id': sid, 'request_id': args['request_id'], 'fingerprint': fingerprint, 'state': 'pending'}
            try:
                with path.open('x', encoding='utf-8') as fh:
                    json.dump(record, fh)
            except FileExistsError:
                previous = json.loads(path.read_text(encoding='utf-8'))
                if previous.get('fingerprint') != fingerprint:
                    raise BridgeError('request_id 已用于不同输入，拒绝发送。')
                return {**previous, 'duplicate': True, 'note': '未重发；pending/uncertain 必须先核查会话历史。'}
            try:
                value = c.rpc('session/prompt', {'request': {'requestId': args['request_id'], 'sessionId': sid,
                              'mode': 'queue', 'content': [{'type': 'text', 'text': args['prompt']}]}})
                if value.get('accepted') is not True:
                    raise BridgeError('DSH 未确认提示词已接收。')
                record['state'] = 'accepted'
            except BridgeError:
                record['state'] = 'uncertain'
                path.write_text(json.dumps(record), encoding='utf-8')
                raise
            path.write_text(json.dumps(record), encoding='utf-8')
            return {**record, 'duplicate': False, 'note': '已接收不等于任务完成；用 dsh_read 核验。'}
        if name == 'dsh_read':
            item = c.find(args['session_id'])
            seq = item.get('projections', {}).get('asOfSeq')
            if not isinstance(seq, int):
                raise BridgeError('DSH 缺少 asOfSeq，不能安全读取当前历史。')
            page = c.rpc('session/page', {'request': {'address': {'kind': 'session', 'sessionId': args['session_id']},
                         'throughSeq': seq, 'maxMessages': args.get('max_messages', 12)}})
            texts, errors, last_end = [], [], None
            for record in page.get('records', []):
                event = record.get('event', {})
                if event.get('type') == 'turn/start':
                    texts, errors, last_end = [], [], None
                if event.get('type') == 'assistant/message':
                    content = event.get('data', {}).get('message', {}).get('content', [])
                    text = '\n'.join(p.get('text', '') for p in content if p.get('type') == 'text')
                    if text:
                        texts.append(text)
                if 'error' in event.get('type', '').lower():
                    errors.append(event)
                if event.get('type') == 'turn/end':
                    last_end = event.get('data', {}).get('reason')
            if isinstance(last_end, dict) and last_end.get('kind') == 'error':
                errors.append(last_end)
            return {'session_id': args['session_id'], 'running': item.get('running'), 'as_of_seq': seq,
                    'model_selection': item.get('projections', {}).get('values', {}).get('modelSelection'),
                    'assistant_text': (texts[-1] if texts else '')[:30000],
                    'text_truncated': bool(texts and len(texts[-1]) > 30000), 'errors': errors, 'last_turn_reason': last_end,
                    'history': page, 'note': 'running=false 或有回复不代表项目验收通过。'}
        c.find(args['session_id'])
        return c.rpc('session/cancel', {'request': {'sessionId': args['session_id']}})

    @staticmethod
    def validate(spec, args):
        if not isinstance(args, dict) or set(args) - set(spec['properties']):
            raise BridgeError('工具参数必须是对象且不能有未知字段。')
        if any(key not in args for key in spec['required']):
            raise BridgeError('缺少必填参数。')
        for key, value in args.items():
            prop = spec['properties'][key]
            if prop['type'] == 'string' and (not isinstance(value, str) or not value.strip() or '\0' in value):
                raise BridgeError(f'{key} 必须是非空字符串。')
            if prop['type'] == 'integer' and (type(value) is not int or not prop['minimum'] <= value <= prop['maximum']):
                raise BridgeError(f'{key} 超出整数范围。')


def handle(message, bridge):
    if 'id' not in message:
        return None
    ident = message['id']
    method = message.get('method')
    params = message.get('params', {})
    if method == 'initialize':
        version = params.get('protocolVersion', '2024-11-05')
        result = {'protocolVersion': version if version in ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'] else '2024-11-05',
                  'capabilities': {'tools': {}}, 'serverInfo': {'name': 'dsh-bridge', 'version': '0.1.2'}}
    elif method == 'ping':
        result = {}
    elif method == 'tools/list':
        result = {'tools': [{'name': n, 'description': d, 'inputSchema': s} for n, d, s in TOOLS]}
    elif method == 'tools/call':
        try:
            value = bridge.call(params.get('name'), params.get('arguments', {}))
            result = {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}], 'isError': False}
        except BridgeError as exc:
            result = {'content': [{'type': 'text', 'text': str(exc)}], 'isError': True}
    else:
        return {'jsonrpc': '2.0', 'id': ident, 'error': {'code': -32601, 'message': 'Method not found'}}
    return {'jsonrpc': '2.0', 'id': ident, 'result': result}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--call', choices=[t[0] for t in TOOLS])
    parser.add_argument('--args-file', type=Path)
    args = parser.parse_args()
    bridge = Bridge()
    if args.call:
        values = json.loads(args.args_file.read_text(encoding='utf-8-sig')) if args.args_file else {}
        response = handle({'id': 1, 'method': 'tools/call', 'params': {'name': args.call, 'arguments': values}}, bridge)
        print(json.dumps(response['result'], ensure_ascii=False))
        return 1 if response['result']['isError'] else 0
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError('object required')
            response = handle(message, bridge)
        except (ValueError, TypeError, KeyError, AttributeError):
            response = {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid request'}}
        except Exception:
            response = {'jsonrpc': '2.0', 'id': message.get('id'), 'error': {'code': -32603, 'message': 'Internal error; no request retried'}}
        if response is not None:
            print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stdin.reconfigure(encoding='utf-8')
    sys.exit(main())
