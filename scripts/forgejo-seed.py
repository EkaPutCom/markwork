#!/usr/bin/env python3
"""Seeds a fresh Forgejo (or Gitea) for the live tests: the users, their tokens, the repository, and the pull requests the
read-only checks expect. Standard library only. Prints one JSON object with the two tokens; everything else goes to stderr.

  forgejo-seed.py <base-url> <owner> <owner-password>

The owner must already exist and be an administrator (scripts/forgejo.sh creates it with the server's own command line).
Safe to run again: what exists is kept; the seeded pull requests are only made when the repository has none open.
"""
import base64
import json
import secrets
import sys
import time
import urllib.error
import urllib.request

BASE, OWNER, PASSWORD = sys.argv[1].rstrip('/'), sys.argv[2], sys.argv[3]
CONTRIBUTOR = 'contributor'
REPO = 'notes'


def log(message):
    print(message, file=sys.stderr)


def call(method, path, body=None, auth=None, ok=(200, 201, 204)):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f'{BASE}/api/v1{path}', data=data, method=method)
    request.add_header('Content-Type', 'application/json')
    request.add_header('Authorization', auth)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode()
            return response.status, json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        if e.code in ok:
            return e.code, None
        raise SystemExit(f'{method} {path}: HTTP {e.code} {text[:300]}')


def basic(user, password):
    return 'Basic ' + base64.b64encode(f'{user}:{password}'.encode()).decode()


def token_for(user, password):
    name = f'markwork-{int(time.time())}-{secrets.token_hex(2)}'
    _, made = call('POST', f'/users/{user}/tokens', {'name': name, 'scopes': ['all']}, basic(user, password))
    return made['sha1']


def put(token, path, text, message, branch='main'):
    """Creates the file, or updates it if it exists."""
    auth = f'token {token}'
    code, existing = call('GET', f'/repos/{OWNER}/{REPO}/contents/{path}?ref={branch}', auth=auth, ok=(404,))
    body = {'content': base64.b64encode(text.encode()).decode(), 'message': message, 'branch': branch}
    if code == 200 and existing:
        body['sha'] = existing['sha']
        call('PUT', f'/repos/{OWNER}/{REPO}/contents/{path}', body, auth)
    else:
        call('POST', f'/repos/{OWNER}/{REPO}/contents/{path}', body, auth)


owner_token = token_for(OWNER, PASSWORD)
auth = f'token {owner_token}'
log(f'owner {OWNER}: token made')

# The contributor: another user, who sends changes through a fork or AGit.
contributor_password = secrets.token_urlsafe(18)
code, _ = call('GET', f'/users/{CONTRIBUTOR}', auth=auth, ok=(404,))
if code == 404:
    call('POST', '/admin/users', {'username': CONTRIBUTOR, 'email': f'{CONTRIBUTOR}@example.invalid', 'password': contributor_password, 'must_change_password': False}, auth)
    log(f'user {CONTRIBUTOR}: created')
    contributor_token = token_for(CONTRIBUTOR, contributor_password)
else:
    # A user that exists from an earlier run: its password is not known, so reset it to one that is.
    call('PATCH', f'/admin/users/{CONTRIBUTOR}', {'login_name': CONTRIBUTOR, 'source_id': 0, 'password': contributor_password, 'must_change_password': False}, auth)
    contributor_token = token_for(CONTRIBUTOR, contributor_password)
log(f'user {CONTRIBUTOR}: token made')

code, _ = call('GET', f'/repos/{OWNER}/{REPO}', auth=auth, ok=(404,))
if code == 404:
    call('POST', '/user/repos', {'name': REPO, 'auto_init': True, 'default_branch': 'main', 'private': False, 'readme': 'Default', 'description': 'Notes for the Markwork live tests'}, auth)
    log(f'repository {OWNER}/{REPO}: created')

# What the tests read and edit. agenda/rapat.md has the word the conflict tests rewrite ("Bahas").
put(owner_token, 'agenda/rapat.md', '---\ntitle: Rapat mingguan\n---\n# Rapat mingguan\n\nBahas anggaran kuartal ini.\n', 'Add the weekly meeting')
put(owner_token, 'ide.md', '# Ide\n\n- Satu\n- Dua\n', 'Add ideas')
put(owner_token, 'catatan.md', '# Catatan\n\nCatatan awal.\n', 'Add notes')
put(owner_token, 'journal.md', '# Journal\n', 'Add the journal')

_, pulls = call('GET', f'/repos/{OWNER}/{REPO}/pulls?state=open', auth=auth)
if not pulls:
    def branch(name):
        call('POST', f'/repos/{OWNER}/{REPO}/branches', {'new_branch_name': name, 'old_branch_name': 'main'}, auth)

    # A clean one: edits a file nothing else touches.
    branch('seed-clean')
    put(owner_token, 'ide.md', '# Ide\n\n- Satu\n- Dua\n- Tiga, dari seed\n', 'Add an idea', 'seed-clean')
    call('POST', f'/repos/{OWNER}/{REPO}/pulls', {'head': 'seed-clean', 'base': 'main', 'title': 'Seed: a clean change', 'body': 'Merges without conflicts.'}, auth)

    # One that conflicts: the branch and main change the same line of catatan.md differently.
    branch('seed-conflict')
    put(owner_token, 'catatan.md', '# Catatan\n\nCatatan dari cabang.\n', 'Edit on the branch', 'seed-conflict')
    put(owner_token, 'catatan.md', '# Catatan\n\nCatatan dari main.\n', 'Edit on main')
    call('POST', f'/repos/{OWNER}/{REPO}/pulls', {'head': 'seed-conflict', 'base': 'main', 'title': 'Seed: a change that conflicts', 'body': 'Conflicts with main.'}, auth)
    log('pull requests: one clean, one conflicting')
else:
    log(f'pull requests: {len(pulls)} already open, none added')

# The server works out "mergeable" in the background; wait until the two are told apart.
for _ in range(60):
    _, pulls = call('GET', f'/repos/{OWNER}/{REPO}/pulls?state=open', auth=auth)
    seen = {p['mergeable'] for p in pulls}
    if True in seen and False in seen:
        break
    time.sleep(1)
else:
    log('warning: the server did not report both a clean and a conflicting pull request')

print(json.dumps({'owner_token': owner_token, 'contributor_token': contributor_token, 'repo': f'{OWNER}/{REPO}'}))
