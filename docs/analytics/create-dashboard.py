#!/usr/bin/env python3
"""Create and validate the four Hansel SQL views using PostHog's typed query nodes. MIT."""
import json
import os
import subprocess
from pathlib import Path
os.umask(0o077)
project = json.loads(Path('watcher-projects-receipt.json').read_text())
sql_source = '\n'.join(line for line in Path('watcher-metrics.sql').read_text().splitlines() if not line.lstrip().startswith('--'))
queries = [q.strip() for q in sql_source.split(';') if q.strip()]
names = ['Active installations (DAU)', 'Active minutes', 'Recording minutes (N/A)', 'Feature usage', 'Feature outcomes', 'Version and platform cohorts']
assert len(queries) == len(names)
code = '''
import json
from django.apps import apps
from posthog.models import Team, User
from posthog.hogql.query import execute_hogql_query
from posthog.schema import DataTableNode, HogQLQuery
Dashboard = apps.get_model('dashboards', 'Dashboard')
DashboardTile = apps.get_model('dashboards', 'DashboardTile')
Insight = apps.get_model('product_analytics', 'Insight')
team = Team.objects.get(id=PROJECT_ID)
user = User.objects.get(email='admin@analytics.invalid')
dashboard, _ = Dashboard.objects.get_or_create(team=team, name='Watcher usage — opt-in installations', defaults={'created_by': user, 'pinned': True, 'description': 'UTC daily usage from consenting installations. No user content. Raw-event expiry: 30 days.'})
ids=[]
for name, sql in QUERIES:
    response=execute_hogql_query(query=sql, team=team)
    node=DataTableNode(source=HogQLQuery(query=sql))
    insight, _=Insight.objects.get_or_create(team=team, name=name, defaults={'created_by': user, 'saved': True})
    insight.query=node.model_dump(mode='json', exclude_none=True)
    insight.save()
    DashboardTile.objects.get_or_create(dashboard=dashboard, insight=insight, defaults={'team': team})
    ids.append(insight.id)
    print('Validated SQL view:', name)
print('DASHBOARD_JSON:'+json.dumps({'project_id': team.id, 'dashboard_id': dashboard.id, 'insight_ids': ids}))
'''.replace('PROJECT_ID', str(int(project['posthog_project_id']))).replace('QUERIES', repr(list(zip(names, queries))))
result = subprocess.run(['docker','compose','-f','stack.json','exec','-T','web','python','manage.py','shell'], input=code, text=True, capture_output=True)
Path('watcher-dashboard-provision.log').write_text(result.stdout + result.stderr)
result.check_returncode()
record = next(json.loads(line.split('DASHBOARD_JSON:',1)[1]) for line in result.stdout.splitlines() if line.startswith('DASHBOARD_JSON:'))
Path('watcher-dashboard.json').write_text(json.dumps(record, indent=2))
print('Created dashboard', record['dashboard_id'], 'with', len(record['insight_ids']), 'validated views')
