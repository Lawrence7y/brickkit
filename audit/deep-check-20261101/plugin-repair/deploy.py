from pathlib import Path
import json
import shutil
from datetime import datetime

here=Path(__file__).resolve().parent
source=Path('C:/Users/Administrator/dsh-bridge-marketplace/plugins/dsh-bridge')
stamp=datetime.now().strftime('%Y%m%d-%H%M%S')
backup=here/('source-backup-'+stamp)
files=['server.py','tests/test_endpoint.py','plugin.json','.codex-plugin/plugin.json','README.md','skills/dsh-bridge/SKILL.md']
for rel in files:
    src=source/rel
    if src.exists():
        dst=backup/rel;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
for rel in ['server.py','tests/test_endpoint.py']:
    shutil.copy2(here/'staged'/rel,source/rel)
for rel in ['plugin.json','.codex-plugin/plugin.json']:
    p=source/rel;data=json.loads(p.read_text(encoding='utf-8-sig'));data['version']='0.1.3'
    p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
p=source/'README.md'
p.write_text(p.read_text(encoding='utf-8')+'\n\n## 0.1.3 本机地址漂移修复\n\n保存的 RFC1918 私网地址会在发送前解析为同端口 127.0.0.1；不会联系旧地址，不扫描网络，不重试 RPC。显式 DSH_BASE 仍严格要求本机地址。登录文件不被自动修改；401 需要经 DSH 登录刷新。\n',encoding='utf-8')
p=source/'skills/dsh-bridge/SKILL.md';s=p.read_text(encoding='utf-8')
s=s.replace('本项目 cwd=D:\\Project\\ra2-campaign-forge，对应工作区 ra2-campaign-forge。','cwd 必须取用户当前授权项目的绝对路径，并核对返回的 workspace_path 与该路径一致。')
s+='\n8. 保存的私网地址可能随网络变化失效；0.1.3 仅转为同端口本机回环地址，不向旧私网地址发送凭据。401 表示登录态仍须刷新，不要将地址恢复误报为认证成功。\n'
p.write_text(s,encoding='utf-8')
print(json.dumps({'source':str(source),'backup':str(backup),'version':'0.1.3'},ensure_ascii=False))
