#!/usr/bin/env python3
"""Run on build-my. Add only Watcher projects/maps; no credentials leave the server."""
import json, os, subprocess
from pathlib import Path
os.umask(0o077)
def run(args, code, marker):
    result = subprocess.run(args, input=code, text=True, capture_output=True)
    if result.returncode:
        Path('/opt/odd-analytics/watcher-provision-private.log').write_text(result.stdout + result.stderr)
        raise RuntimeError('Provisioning failed; inspect /opt/odd-analytics/watcher-provision-private.log')
    return next(json.loads(s.split(marker, 1)[1]) for s in result.stdout.splitlines() if s.startswith(marker))
base = Path('/opt/odd-analytics')
code = '''
import json
from posthog.models import Organization, Team, User
org=Organization.objects.get(name='Odd Community Analytics')
team=org.teams.filter(name='Watcher').first()
if team is None:
    Project=Team._meta.get_field('project').related_model
    project,team=Project.objects.create_with_team(organization=org,name='Watcher',initiating_user=User.objects.get(email='admin@analytics.invalid'),team_fields={'anonymize_ips':True})
print('WATCHER:'+json.dumps({'project_id':team.id, 'token':team.api_token}))
'''
posthog = run(['docker','compose','-f',str(base/'stack.json'),'exec','-T','web','python','manage.py','shell'], code, 'WATCHER:')
sentry_code = '''
import json
from pathlib import Path
from click.testing import CliRunner
from sentry.models.organization import Organization
from sentry.models.team import Team
from sentry.models.project import Project
from sentry.models.projectkey import ProjectKey
from sentry.runner.commands.createproject import createproject
org=Organization.objects.get(slug='odd-community')
team,_=Team.objects.get_or_create(organization=org,slug='watcher',defaults={'name':'Watcher'})
projects={}
for slug,name,platform in [('watcher-cli','Watcher CLI','node'),('watcher-macos','Watcher macOS','cocoa')]:
    if not Project.objects.filter(organization=org,slug=slug).exists():
        result=CliRunner().invoke(createproject,['--name',name,'--platform',platform,'--organization',org.slug,'--team',team.slug])
        if result.exit_code: raise RuntimeError('Project creation failed')
    p=Project.objects.get(organization=org,slug=slug)
    p.update_option('sentry:sensitive_fields',['prompt','session','path','project','spend','authorization','cookie','token','password','email'])
    key=ProjectKey.get_default(p)
    projects[slug]={'project_id':p.id,'public_key':key.public_key}
Path('/etc/sentry/private-watcher-projects.json').write_text(json.dumps(projects))
print('WATCHER:'+json.dumps(projects))
'''
private_file = Path('/opt/odd-sentry/sentry/private-watcher-projects.json')
if not private_file.exists(): private_file.touch(mode=0o600)
os.chown(private_file, 999, 999)
script = Path('/opt/odd-sentry/sentry/provision-watcher.py')
script.write_text(sentry_code); script.chmod(0o644)
sentry = run(['docker','compose','--env-file','/opt/odd-sentry/.env.custom','--project-directory','/opt/odd-sentry','exec','-T','--user','999','web','sentry','exec','/etc/sentry/provision-watcher.py'], '', 'WATCHER:')
tokens=json.loads((base/'project-tokens.json').read_text())
diagnostics=json.loads((base/'sentry-projects.json').read_text())
for surface,slug,features in [('cli','watcher-cli',['cli_'+x.replace('-','_') for x in ['status','report','optimize','compare','export','menubar','plan','currency','agent-status']]),('mac','watcher-macos',['mac_menu','mac_report','mac_period','mac_provider'])]:
    alias='public-watcher-'+surface+'-v1'
    tokens[alias]={'app':'watcher','token':posthog['token'],'features':features,'events':['app_active','app_usage','app_feature','app_result']}
    diagnostics[alias]={'app':slug,**sentry[slug],'platform':'javascript' if surface=='cli' else 'other','frames':[]}
for filename,value in [('project-tokens.json',tokens),('sentry-projects.json',diagnostics)]:
    p=base/filename
    backup=base/(filename+'.before-watcher')
    if not backup.exists(): backup.write_bytes(p.read_bytes())
    # Keep existing bind-mounted inode; gateway restart reloads both maps.
    p.write_text(json.dumps(value)); p.chmod(0o600)
receipt={'posthog_project_id':posthog['project_id'],'sentry_projects':{k:v['project_id'] for k,v in sentry.items()},'aliases':['public-watcher-cli-v1','public-watcher-mac-v1']}
(base/'watcher-projects-receipt.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps(receipt))
