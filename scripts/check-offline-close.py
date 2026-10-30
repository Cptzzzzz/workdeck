#!/usr/bin/env python3
"""Explicit deployed acceptance check. Restarts only the new Workdeck Agent."""
import http.cookiejar
import json
import pathlib
import subprocess
import time
import urllib.request
import urllib.error

BASE = 'https://work.example.com'
client = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
csrf = ''

def api(path, body=None, method=None):
    request = urllib.request.Request(BASE+'/api'+path, data=json.dumps(body).encode() if body is not None else None, method=method,
        headers={'Content-Type':'application/json','Origin':BASE,'X-Workdeck-CSRF':csrf})
    for attempt in range(3):
        try:
            with client.open(request, timeout=8) as response:
                return json.load(response)
        except (urllib.error.URLError,TimeoutError):
            if attempt==2 or (body is not None and method!='DELETE' and path!='/logout'):
                raise
            time.sleep(1)

def wait_for(fn, seconds=40):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        result=fn()
        if result:
            return result
        time.sleep(1)
    raise RuntimeError('Acceptance condition timed out')

password=(pathlib.Path(__file__).resolve().parent.parent/'.secrets/administrator.txt').read_text().strip()
csrf=api('/login',{'username':'admin','password':password})['csrf']
terminal=None
completed=False
try:
    node=next(n for n in api('/state')['nodes'] if n['hostname']=='worker-01' and n['online'])
    terminal=api('/terminals',{'node_id':node['id'],'name':'离线终止验收','cwd':node['home']})
    assert terminal['state']=='running',terminal
    unit='workdeck-session-'+terminal['id']+'.service'
    subprocess.run(['systemctl','--user','stop','workdeck-agent.service'],check=True)
    wait_for(lambda: not next(n for n in api('/state')['nodes'] if n['id']==node['id'])['online'])
    state=api('/terminals/'+terminal['id'],{},'DELETE')
    assert state['desired_state']=='closed' and state['state']=='running',state
    assert subprocess.run(['systemctl','--user','is-active','--quiet',unit]).returncode==0
    subprocess.run(['systemctl','--user','start','workdeck-agent.service'],check=True)
    wait_for(lambda: next(t for t in api('/state')['terminals'] if t['id']==terminal['id'])['state']=='closed')
    assert subprocess.run(['systemctl','--user','is-active','--quiet',unit]).returncode!=0
    completed=True
    print('PASS: offline termination persisted, live process continued while disconnected, and termination reconciled after reconnect')
finally:
    subprocess.run(['systemctl','--user','start','workdeck-agent.service'],check=True)
    if terminal and not completed:
        api('/terminals/'+terminal['id'],{},'DELETE')
    api('/logout',{},'POST')
