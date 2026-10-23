#!/usr/bin/env python3
"""Verify private gateway -> PostHog -> ClickHouse with disposable owned UUIDs. MIT."""
import argparse
import datetime
import json
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('--endpoint', choices=['http://127.0.0.1:18081/batch/', 'https://data.odd.community/batch/'], default='http://127.0.0.1:18081/batch/')
endpoint = parser.parse_args().endpoint
project = json.loads(Path('watcher-projects-receipt.json').read_text())
team = int(project['posthog_project_id'])
identity = str(uuid.uuid4())
rows = []
for event, metric in [('app_active', {}), ('app_usage', {'active_ms': 60000}), ('app_feature', {'feature': 'cli_status'}), ('app_result', {'feature': 'cli_status', 'outcome': 'success'})]:
    rows.append({'event': event, 'uuid': str(uuid.uuid4()), 'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'properties': {'distinct_id': identity, 'app': 'watcher', 'app_version': '0.2.67', 'app_platform': 'macos', **metric}})
body = json.dumps({'api_key': 'public-watcher-cli-v1', 'batch': rows}).encode()
base = ['docker', 'compose', '-f', 'stack.json', 'exec', '-T', 'clickhouse', 'clickhouse-client', '--database', 'posthog']
def query(sql):
    return subprocess.check_output(base + ['--query', sql], text=True)
# Inspect consumed inventory before choosing the event table.
assert query("SELECT count() FROM system.tables WHERE database='posthog' AND name='sharded_events'").strip() == '1'
try:
    for _ in range(2):
        req = urllib.request.Request(endpoint, data=body, headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=10) as result:
            assert result.status == 200
    sql = f"SELECT count() AS events, uniqExact(distinct_id) AS dau, sum(JSONExtractInt(properties, 'active_ms')) AS active_ms, sum(JSONExtractInt(properties, 'recording_ms')) AS recording_ms, countIf(event='app_feature') AS features, countIf(event='app_result') AS results, countIf(JSONExtractString(properties, 'outcome')='success') AS successes, countIf(JSONExtractString(properties, 'app_version')='0.2.67' AND JSONExtractString(properties, 'app_platform')='macos') AS metadata FROM sharded_events FINAL WHERE team_id={team} AND distinct_id='{identity}' FORMAT JSONEachRow"
    for _ in range(10):
        result = json.loads(query(sql))
        if int(result['events']) >= 4:
            break
        time.sleep(2)
    expected = {'events': 4, 'dau': 1, 'active_ms': 60000, 'recording_ms': 0, 'features': 1, 'results': 1, 'successes': 1, 'metadata': 4}
    assert {k: int(result[k]) for k in expected} == expected, result
    Path('watcher-canary-receipt.public.json' if endpoint.startswith('https:') else 'watcher-canary-receipt.json').write_text(json.dumps({'project_id': team, 'synthetic_only': True, 'duplicate_batches_sent': 2, 'observed': result, 'endpoint': endpoint}, indent=2))
    print('Canary passed: one active installation, one active minute, recording N/A (zero events), one feature use, one success, version/platform retained, duplicate batch deduplicated.')
finally:
    query(f"ALTER TABLE sharded_events DELETE WHERE team_id={team} AND distinct_id='{identity}' SETTINGS mutations_sync=2")
    assert query(f"SELECT count() FROM sharded_events WHERE team_id={team} AND distinct_id='{identity}'").strip() == '0'
    print('Disposable canary events removed.')
