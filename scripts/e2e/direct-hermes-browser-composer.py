#!/usr/bin/env python3
"""Real browser composer acceptance. Only inference is deterministic, not Hermes.

Selected bytes travel through the real file input, core, proxy, RPC server and
agent. No renderer state injection, fake RPC replies, or TheChat file storage.
"""
import base64
import importlib.util
import json
from pathlib import Path
import re
import sqlite3
import time
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('composer_fixture', HERE / 'direct-hermes-composer-fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def history(db, sid):
    with sqlite3.connect(db) as connection:
        return connection.execute('SELECT role,content FROM messages WHERE session_id=? ORDER BY id', (sid,)).fetchall()


def assert_branch_storage(db, parent, child, original):
    assert child != parent, 'branch requires a different stored ID'
    assert history(db, parent) == original, 'parent history changed during branch'
    with sqlite3.connect(db) as connection:
        metadata = connection.execute('SELECT parent_session_id FROM sessions WHERE id=?', (child,)).fetchone()
    assert metadata == (parent,), 'durable branch parent ID differs'
    visible = [row for row in original if row[0] in ('user', 'assistant') and row[1] and str(row[1]).strip()]
    assert history(db, child) == visible, 'branch copied visible history differs from parent'
    return {'parentStoredId': parent, 'branchStoredId': child, 'copiedVisibleRows': len(visible), 'parentRowsUnchanged': len(original)}


def sent(frames, method=None, since=0):
    return [row['frame'] for row in frames[since:] if row['direction'] == 'sent' and (method is None or row['frame'].get('method') == method)]


def result(frames, request, since=0):
    replies = [row['frame'] for row in frames[since:] if row['direction'] == 'received' and row['frame'].get('id') == request['id']]
    assert len(replies) == 1, ('Expected one correlated real RPC reply', request, replies)
    assert 'error' not in replies[0], replies[0]
    return replies[0]['result']


def wait(page, predicate, label, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        page.wait_for_timeout(50)
    raise AssertionError('Timed out waiting for ' + label)


def audit(stack):
    # Live endpoint avoids a partially-written audit file during title helpers.
    with urlopen(stack.model[:-3] + '/state', timeout=5) as response:
        return json.load(response)['records']


def inference_count(stack):
    # All agent requests offer the configured real terminal tool; title helpers
    # do not. Count even an unrecognized agent prompt, not just known stages.
    return sum(bool(row['agentInference']) for row in audit(stack))


def active_id(page):
    return page.locator('section[aria-label="Hermes chat"] p[title]').first.get_attribute('title')


def assert_no_uploads(frames, since):
    forbidden = [row for row in sent(frames, since=since) if row.get('method') in ('file.attach', 'image.attach', 'image.attach_bytes', 'image.detach', 'prompt.submit')]
    assert not forbidden, ('Queued/removed/rejected files mutated Hermes before Send', forbidden)


def check_uploads(stack, frames, since, expected, sid):
    requests = sent(frames, 'file.attach', since)
    assert len(requests) == len(expected), (requests, expected.keys())
    evidence = []
    for request in requests:
        params = request['params']
        assert set(params) == {'session_id', 'name', 'data_url'}, 'client file paths must never be sent to Hermes'
        assert params['session_id'] == sid
        name = params['name']
        assert name in expected and params['data_url'].startswith('data:'), params.keys()
        raw = base64.b64decode(params['data_url'].split(',', 1)[1], validate=True)
        assert raw == expected[name], 'browser upload bytes differ from selected file'
        reply = result(frames, request, since)
        assert reply['attached'] is True and reply['uploaded'] is True and reply['ref_text'].startswith('@file:')
        path = Path(reply['path']).resolve()
        assert path.is_relative_to((stack.hermes_home / 'attachments').resolve()), path
        assert path.read_bytes() == raw, 'actual Hermes attachment directory bytes differ'
        evidence.append({'name': name, 'bytes': len(raw), 'sha256': fixture.sha256(raw), 'serverPath': str(path), 'refText': reply['ref_text']})
    return evidence


def verify(stack, page, frames, requests):
    from playwright.sync_api import expect
    evidence = {'status': 'RUNNING', 'inference': 'Deterministic loopback provider; real agent/tools/storage. PNG receipt is not a paid vision evaluation.', 'checks': {}}
    stack.report['composer'] = evidence
    page.set_viewport_size({'width': 1440, 'height': 1000})
    db = stack.hermes_home / 'state.db'
    local = stack.root / 'browser-local-files'
    local.mkdir()
    fixtures = {fixture.TEXT_NAME: fixture.TEXT_BYTES, fixture.IMAGE_NAME: fixture.IMAGE_BYTES, fixture.ONLY_NAME: fixture.ONLY_BYTES}
    for name, raw in fixtures.items():
        (local / name).write_bytes(raw)
    # Source filenames do not exist in the gateway cwd or home; only the real
    # file input is given these client paths. The RPC assertion forbids paths.
    oversize = local / 'direct-hermes-oversize.txt'
    oversize.write_bytes(b'x' * (2 * 1024 * 1024 + 1))
    count_files = [local / f'count-limit-{i}.txt' for i in range(6)]
    for file in count_files:
        file.write_bytes(b'Disposable unsent count-limit fixture.\n')
    textarea = page.get_by_label('Message Hermes', exact=True)
    send = page.get_by_role('button', name='Send', exact=True)
    picker = page.get_by_label('Choose attachments', exact=True)
    pending = page.get_by_role('list', name='Pending attachments', exact=True)
    chat = page.get_by_role('region', name='Hermes chat', exact=True)

    def submit(text, expected):
        textarea.fill(text)
        expect(send).to_be_enabled(timeout=30000)
        start = len(frames)
        send.click()
        expect(chat.get_by_text(expected, exact=True).last).to_be_visible(timeout=60000)
        expect(page.get_by_role('button', name='Attach files', exact=True)).to_be_enabled(timeout=30000)
        return start

    def new_seed():
        start = len(frames)
        page.get_by_role('button', name='New session', exact=True).click()
        expect(page.get_by_text('Send a message to start this session.', exact=True)).to_be_visible(timeout=30000)
        submit(fixture.SEED_MARKER, fixture.FINAL_SEED)
        created = sent(frames, 'session.create', start)
        assert len(created) == 1
        reply = result(frames, created[0], start)
        assert active_id(page) == reply['stored_session_id']
        return reply

    attachment_session = new_seed()
    refresh = page.get_by_role('button', name='Refresh', exact=True)
    expect(refresh).to_be_enabled(timeout=30000)
    refresh.click()
    expect(refresh).to_be_enabled(timeout=30000)
    attachment_title = page.locator('aside[aria-label="Sessions"] button[aria-pressed="true"] span').first.inner_text()
    start = len(frames)
    before_files = sorted(str(p) for p in (stack.hermes_home / 'attachments').rglob('*') if p.is_file())
    before_model = inference_count(stack)
    picker.set_input_files([str(local / fixture.TEXT_NAME), str(local / fixture.IMAGE_NAME)])
    expect(pending.get_by_role('listitem')).to_have_count(2)
    expect(pending).to_contain_text('Queued')
    page.get_by_role('button', name='Remove ' + fixture.TEXT_NAME, exact=True).click()
    page.get_by_role('button', name='Remove ' + fixture.IMAGE_NAME, exact=True).click()
    expect(pending).not_to_be_visible()
    expect(send).to_be_disabled()
    assert_no_uploads(frames, start)
    picker.set_input_files([str(local / fixture.TEXT_NAME), str(local / fixture.IMAGE_NAME)])
    expect(pending.get_by_role('listitem')).to_have_count(2)
    page.get_by_role('button', name=re.compile('Acceptance session B')).click()
    expect(chat.get_by_text('Inference fixture session B is isolated.', exact=True)).to_be_visible(timeout=30000)
    expect(pending).not_to_be_visible()
    expect(send).to_be_disabled()
    page.get_by_role('button', name=re.compile('^' + re.escape(attachment_title))).click()
    expect(pending.get_by_role('listitem')).to_have_count(2)
    assert active_id(page) == attachment_session['stored_session_id']
    assert_no_uploads(frames, start)
    assert before_model == inference_count(stack)
    assert before_files == sorted(str(p) for p in (stack.hermes_home / 'attachments').rglob('*') if p.is_file())
    page.screenshot(path=str(stack.root / 'browser-composer-queued.png'), full_page=True)
    evidence['checks']['selectionRemovalSessionIsolationNoMutationBeforeSend'] = True
    page.get_by_role('button', name='Remove ' + fixture.IMAGE_NAME, exact=True).click()
    start = submit(fixture.TEXT_MARKER + ': read the uploaded TXT contents.', fixture.FINAL_TEXT)
    uploads = check_uploads(stack, frames, start, {fixture.TEXT_NAME: fixture.TEXT_BYTES}, attachment_session['session_id'])
    expect(pending).not_to_be_visible()
    prompt = sent(frames, 'prompt.submit', start)
    assert len(prompt) == 1 and uploads[0]['refText'] in prompt[0]['params']['text']
    assert str(local) not in json.dumps(prompt)
    page.screenshot(path=str(stack.root / 'browser-composer-text-receipt.png'), full_page=True)

    # PNG is classified by the current core, then file.attach -> image.attach
    # with the server-returned path, not a client path. Pin source contract here
    # only after inspecting the implementing core (no mock image RPC).
    picker.set_input_files(str(local / fixture.IMAGE_NAME))
    start = submit(fixture.IMAGE_MARKER + ': verify these attached pixels.', fixture.FINAL_IMAGE)
    image_upload = check_uploads(stack, frames, start, {fixture.IMAGE_NAME: fixture.IMAGE_BYTES}, attachment_session['session_id'])
    image_calls = sent(frames, 'image.attach', start)
    assert len(image_calls) == 1 and image_calls[0]['params'] == {'session_id': attachment_session['session_id'], 'path': image_upload[0]['serverPath']}
    assert result(frames, image_calls[0], start)['attached'] is True
    assert len(sent(frames, 'prompt.submit', start)) == 1
    uploads += image_upload
    page.screenshot(path=str(stack.root / 'browser-composer-image-receipt.png'), full_page=True)

    picker.set_input_files(str(local / fixture.ONLY_NAME))
    expect(textarea).to_have_value('')
    expect(send).to_be_enabled()
    start = submit('', fixture.FINAL_ONLY)
    uploads += check_uploads(stack, frames, start, {fixture.ONLY_NAME: fixture.ONLY_BYTES}, attachment_session['session_id'])
    assert not sent(frames, 'image.attach', start), 'previous image was accidentally queued again'
    expect(pending).not_to_be_visible()
    evidence['uploads'] = uploads
    evidence['checks']['textFileImageAndAttachmentOnlySentToActualHermes'] = True

    start = len(frames)
    before_model = inference_count(stack)
    picker.set_input_files(str(oversize))
    expect(page.get_by_role('alert').filter(has_text='2 MiB')).to_be_visible()
    expect(pending).not_to_be_visible()
    expect(send).to_be_disabled()
    assert_no_uploads(frames, start)
    page.screenshot(path=str(stack.root / 'browser-composer-oversize-rejected.png'), full_page=True)
    picker.set_input_files([str(file) for file in count_files])
    expect(page.get_by_role('alert').filter(has_text=re.compile('5 pending|5 files|at most 5'))).to_be_visible()
    expect(pending).not_to_be_visible()
    expect(send).to_be_disabled()
    assert_no_uploads(frames, start)
    page.get_by_role('button', name='Sync session', exact=True).click()
    wait(page, lambda: bool(sent(frames, 'session.activate', start)), 'same live connection sync')
    sync = sent(frames, 'session.activate', start)[-1]
    wait(page, lambda: any(f['direction'] == 'received' and f['frame'].get('id') == sync['id'] for f in frames[start:]), 'real sync reply')
    result(frames, sync, start)
    expect(page.get_by_role('status').filter(has_text=re.compile('^Connected$'))).to_be_visible()
    assert_no_uploads(frames, start)
    assert inference_count(stack) == before_model
    evidence['checks']['oversizeAndCountLimitRejectedWithConnectionAliveNoInference'] = True

    parent = new_seed()
    original = history(db, parent['stored_session_id'])
    assert ('user', fixture.SEED_MARKER) in original and ('assistant', fixture.FINAL_SEED) in original
    commands = []

    def command(text, output=None, error=False):
        start = len(frames)
        before = inference_count(stack)
        old_system = chat.locator('article').filter(has=page.get_by_text('System', exact=True)).count()
        textarea.fill(text)
        expect(send).to_be_enabled()
        send.click()
        if error:
            expect(page.get_by_role('alert').filter(has_text=re.compile('unknown|unsupported|not supported', re.I))).to_be_visible(timeout=30000)
        elif output:
            expect(chat.get_by_text(re.compile(output)).last).to_be_visible(timeout=30000)
        else:
            wait(page, lambda: chat.locator('article').filter(has=page.get_by_text('System', exact=True)).count() > old_system, 'readable control result')
        if not error:
            expect(page.get_by_role('button', name='Attach files', exact=True)).to_be_enabled(timeout=30000)
        # A real correlated read fences earlier socket work; no synthetic delays.
        sync_start = len(frames)
        refresh.click()
        expect(refresh).to_be_enabled(timeout=30000)
        assert sent(frames, 'session.list', sync_start)
        assert not sent(frames, 'prompt.submit', start), 'slash command was sent as model prompt'
        after = inference_count(stack)
        assert before == after, ('control command unexpectedly called agent inference', text, before, after)
        record = {'command': text, 'agentInferenceBefore': before, 'agentInferenceAfter': after, 'rpcMethods': [r['method'] for r in sent(frames, since=start)]}
        commands.append(record)
        return start

    command('/title Composer branch parent', r'Composer branch parent')
    with sqlite3.connect(db) as connection:
        assert connection.execute('SELECT title FROM sessions WHERE id=?', (parent['stored_session_id'],)).fetchone() == ('Composer branch parent',)
    command('/status')
    command('/help')
    start = command('/branch Composer acceptance branch', r'branch|Branch')
    branches = sent(frames, 'session.branch', start)
    assert len(branches) == 1 and branches[0]['params'] == {'session_id': parent['session_id'], 'name': 'Composer acceptance branch'}
    child = result(frames, branches[0], start)
    assert child['session_id'] != parent['session_id'] and child['parent'] == parent['stored_session_id']
    assert active_id(page) == child['stored_session_id'], 'active session did not switch to branch'
    branch_evidence = assert_branch_storage(db, parent['stored_session_id'], child['stored_session_id'], original)
    branch_evidence.update({'parentRuntimeId': parent['session_id'], 'branchRuntimeId': child['session_id']})
    expect(chat.get_by_text(fixture.FINAL_SEED, exact=True)).to_be_visible()
    start = submit(fixture.BRANCH_MARKER, fixture.FINAL_BRANCH)
    follow = sent(frames, 'prompt.submit', start)
    assert len(follow) == 1 and follow[0]['params']['session_id'] == child['session_id']
    child_history = history(db, child['stored_session_id'])
    assert history(db, parent['stored_session_id']) == original
    assert ('user', fixture.BRANCH_MARKER) in child_history and ('assistant', fixture.FINAL_BRANCH) in child_history
    page.get_by_role('button', name=re.compile('^Composer branch parent')).click()
    expect(chat.get_by_text(fixture.FINAL_SEED, exact=True)).to_be_visible()
    expect(chat.get_by_text(fixture.FINAL_BRANCH, exact=True)).not_to_be_visible()
    page.get_by_role('button', name=re.compile('^Composer acceptance branch')).click()
    expect(chat.get_by_text(fixture.FINAL_BRANCH, exact=True)).to_be_visible()
    page.reload(wait_until='networkidle')
    page.get_by_role('button', name=re.compile('^Composer acceptance branch')).click(timeout=30000)
    expect(chat.get_by_text(fixture.FINAL_BRANCH, exact=True)).to_be_visible(timeout=30000)
    assert active_id(page) == child['stored_session_id']
    page.screenshot(path=str(stack.root / 'browser-composer-branch-reloaded.png'), full_page=True)
    evidence['checks']['branchRealRuntimeStoredIdsParentUnchangedHistoryCopiedFollowupIsolatedReloaded'] = True
    evidence['branch'] = branch_evidence

    # /fork alias must also create a durable, named child and not prompt a model.
    original_child = history(db, child['stored_session_id'])
    start = command('/fork Composer named fork', r'fork|Fork|branch|Branch')
    fork_calls = sent(frames, 'session.branch', start)
    assert len(fork_calls) == 1 and fork_calls[0]['params']['name'] == 'Composer named fork'
    fork = result(frames, fork_calls[0], start)
    assert fork['session_id'] != child['session_id']
    assert active_id(page) == fork['stored_session_id']
    evidence['fork'] = assert_branch_storage(db, child['stored_session_id'], fork['stored_session_id'], original_child)
    command('/not-a-hermes-command-fixture', error=True)
    assert history(db, parent['stored_session_id']) == original
    assert history(db, child['stored_session_id']) == original_child
    evidence['commands'] = commands
    evidence['checks']['titleStatusHelpForkUnknownAreControlNotInference'] = True
    stages = [row['stage'] for row in audit(stack)]
    required = {'attachment_text', 'attachment_only', 'attachment_image', 'branch_seed', 'branch_followup'}
    assert required <= set(stages), ('Missing actual provider receipt stages', required - set(stages))
    evidence['providerReceipts'] = [row['composer'] for row in audit(stack) if row['stage'] in required]
    assert not (stack.root / 'fixture-audit.error').exists(), 'inference receipt assertion failed'
    count = stack.run(stack.docker + ['exec', stack.containers[0], 'psql', '-U', 'thechat', '-d', 'thechat', '-Atc', 'SELECT count(*) FROM messages;']).strip()
    assert count == '0', 'TheChat stored composer transcript rows'
    assert not any('/attachments' in row['path'] or '/messages' in row['path'] for row in requests), 'composer used TheChat message/attachment storage'
    evidence['thechatMessageRows'] = int(count)
    # The pinned real server has a 2-second trailing sessions.changed broadcast
    # floor. Wait for observed socket activity to become quiet before taking
    # fixed-row geometry snapshots; never hold/suppress those real events.
    settled = {'frames': len(frames), 'since': time.monotonic()}
    def quiescent():
        if len(frames) != settled['frames']:
            settled.update(frames=len(frames), since=time.monotonic())
        return time.monotonic() - settled['since'] >= 3 and refresh.is_enabled()
    wait(page, quiescent, 'post-mutation session watcher quiescence', seconds=20)
    evidence['sessionWatchQuiescenceSeconds'] = 3
    evidence['screenshots'] = sorted(p.name for p in stack.root.glob('browser-composer-*.png'))
    evidence['truthBoundaries'] = ['Real production-built component, real authentication/API/Redis/Postgres/proxy/Hermes/SQLite and file tools; not full Tauri shell.', 'Only listed safe control commands are exercised, not every native Hermes UI-only command.', 'PNG hashes prove multimodal provider receipt, not semantic vision quality or paid inference.', 'Local Chromium and Hermes share an isolated host; uploaded bytes/path assertions exercise remote-path semantics, not a separate physical client machine.']
    evidence['status'] = 'PASS'
    (stack.root / 'browser-composer-evidence.json').write_text(json.dumps(evidence, indent=2))
    return evidence
