"""sentry exec: inspect and delete only the owned disposable Watcher canary."""
import json,time
from pathlib import Path
from sentry import deletions,eventstore
from sentry.models.group import Group
fixture=json.loads(Path('/etc/sentry/watcher-canary-fixture.json').read_text())
project=json.loads(Path('/etc/sentry/private-watcher-projects.json').read_text())['watcher-cli']['project_id']
event=None
for _ in range(20):
 event=eventstore.backend.get_event_by_id(project,fixture['event_id'])
 if event: break
 time.sleep(2)
assert event is not None,'No canary event retained'
data=dict(event.data); serialized=json.dumps(data)
assert fixture['marker'] not in serialized and not data.get('user',{}).get('ip_address')
assert data['release']=='watcher-cli@0.0.1'
group=Group.objects.get(id=event.group_id,project_id=project)
assert group.times_seen==1,'Duplicate UUID was counted more than once'
assert data['exception']['values'][0]['type']=='TypeError'
assert not (data['exception']['values'][0].get('stacktrace') or {}).get('frames')
group_id=group.id;deletions.exec_sync(group)
assert not Group.objects.filter(id=group_id,project_id=project).exists()
print(json.dumps({'project_id':project,'duplicate_deliveries':2,'stored_events':1,'sanitized':True,'owned_issue_removed':True}))
