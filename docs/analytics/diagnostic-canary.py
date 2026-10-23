"""Run on build-my: disposable Watcher-only duplicate error intake check."""
import datetime,json,uuid,urllib.request,os,subprocess
from pathlib import Path
os.umask(0o077)
event=str(uuid.uuid4()); marker='PRIVATE_CANARY_'+uuid.uuid4().hex
body={'api_key':'public-watcher-cli-v1','batch':[{'uuid':event,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'diagnostic':{'event':'error','category':'render_error','error_class':'TypeError','version':'0.0.1','frames':[],'message':marker,'path':marker}}]}
for _ in range(2):
 req=urllib.request.Request('https://data.odd.community/errors/',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'},method='POST')
 with urllib.request.urlopen(req,timeout=15) as response: assert response.status==200
fixture=Path('/opt/odd-sentry/sentry/watcher-canary-fixture.json');fixture.write_text(json.dumps({'event_id':event.replace('-',''),'marker':marker}));os.chown(fixture,999,999)
print('Duplicate diagnostic accepted; verify exact fixture in Sentry and clean it up.')
