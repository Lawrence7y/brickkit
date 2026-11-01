"""Explicit one-shot dispatch through the installed bridge; no credential output."""
from pathlib import Path
import importlib.util
import json
import uuid

here=Path(__file__).resolve().parent
installed=Path('C:/Users/Administrator/.codex/plugins/cache/dsh-local-bridge/dsh-bridge/0.1.3/server.py')
spec=importlib.util.spec_from_file_location('dsh_bridge_installed',installed)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
b=m.Bridge()
receipt=here/'dispatch-receipt.json'
def save(data): receipt.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
def compact_read(sid):
    data=b.call('dsh_read',{'session_id':sid,'max_messages':8})
    return {k:v for k,v in data.items() if k!='history'}
try:
    status=b.call('dsh_status',{})
    print(json.dumps({'status':status},ensure_ascii=False))
    catalog=b.call('dsh_models',{})
    selection={'provider':'opencode-go','model':'deepseek-v4.1-flash'}
    group=next((g for g in catalog['groups'] if g['id']==selection['provider']),None)
    if not group or not any(x['id']==selection['model'] for x in group['models']):
        raise m.BridgeError('授权路由当前不在目录，未切换模型、未创建会话。')
    if receipt.exists():
        record=json.loads(receipt.read_text(encoding='utf-8'))
        print(json.dumps({'previous_dispatch':record,'current':compact_read(record['session_id'])},ensure_ascii=False))
    else:
        created=b.call('dsh_create_session',{'cwd':'D:/Project/brickkit',**selection})
        record={**created,'request_id':'brickkit-fixes-'+str(uuid.uuid4()),'state':'created'}
        save(record)
        print(json.dumps(created,ensure_ascii=False))
        text=(here.parent/'DSH-REPAIR-TASK.md').read_text(encoding='utf-8')
        text=text.replace('状态：待派发，尚未被 Harness 接收。','状态：本消息即正式授权任务。')
        sent=b.call('dsh_send',{'session_id':created['session_id'],'request_id':record['request_id'],'prompt':text})
        record['send']=sent;record['state']=sent['state'];save(record)
        print(json.dumps({'send':sent,'current':compact_read(created['session_id'])},ensure_ascii=False))
except m.BridgeError as e:
    print(json.dumps({'error':str(e),'automatic_retry':False},ensure_ascii=False))
    raise SystemExit(1)
