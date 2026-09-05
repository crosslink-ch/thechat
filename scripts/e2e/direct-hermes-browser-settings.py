#!/usr/bin/env python3
"""Actual Manage bots UI and zero-shift acceptance helpers (no fake API/RPC)."""
import importlib.util
import json
from pathlib import Path
import re
import time
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('settings_contract', HERE / 'direct-hermes-settings.py')
settings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(settings)


def snapshot_rows(page):
    return page.evaluate('''() => {
      const aside = document.querySelector('aside[aria-label="Sessions"]');
      const rows = [...aside.querySelectorAll('button[aria-pressed]')];
      const list = rows[0]?.parentElement;
      if (!list) throw new Error('Refresh requires existing real session rows');
      const rect = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
      const refresh = aside.querySelector('button[aria-busy]') || [...aside.querySelectorAll('button')].find(el => /Refresh/.test(el.textContent));
      return {rows: rows.map(row => ({text:row.innerText,rect:rect(row)})),
        childCount:list.children.length,scrollTop:list.scrollTop,scrollLeft:list.scrollLeft,
        documentScrollY:scrollY,list:rect(list),refresh:rect(refresh),
        busy:refresh.getAttribute('aria-busy'),loadingRow: /Loading sessions/.test(list.innerText),
        scrollHeight:list.scrollHeight,clientHeight:list.clientHeight};
    }''')


def assert_unshifted(before, sample):
    assert len(sample['rows']) == len(before['rows']) and sample['childCount'] == before['childCount'], ('row inserted during refresh', before, sample)
    assert not sample['loadingRow'], 'Loading sessions row reinserted above existing rows'
    for key in ('scrollTop', 'scrollLeft', 'documentScrollY'):
        assert abs(sample[key] - before[key]) <= 1, (key, before, sample)
    for key in ('list', 'refresh'):
        for axis, value in before[key].items():
            assert abs(sample[key][axis] - value) <= 1, (key, axis, before, sample)
    for previous, current in zip(before['rows'], sample['rows']):
        assert previous['text'] == current['text'], ('existing rows changed/reordered', previous, current)
        for axis, value in previous['rect'].items():
            assert abs(current['rect'][axis] - value) <= 1, (axis, previous, current)


def verify_refresh(stack, page):
    from playwright.sync_api import expect
    samples = []
    for width, height in ((1440, 1000), (390, 844)):
        page.set_viewport_size({'width': width, 'height': height})
        refresh = page.get_by_role('button', name='Refresh', exact=True)
        expect(refresh).to_be_enabled()
        # First settle legitimate post-turn title/preview changes from real data.
        refresh.click()
        expect(refresh).to_be_enabled(timeout=30000)
        page.evaluate('''() => {
          const row = document.querySelector('aside[aria-label="Sessions"] button[aria-pressed]');
          row.parentElement.scrollTop = Math.min(23, row.parentElement.scrollHeight - row.parentElement.clientHeight);
        }''')
        before = snapshot_rows(page)
        if width == 390:
            assert before['scrollTop'] > 0, 'Mobile fixture must exercise a nonzero session-list scroll position'
        page.screenshot(path=str(stack.root / f'browser-refresh-{width}-before.png'), full_page=True)
        page.evaluate('window.__directHermesRefreshProbe.arm = true')
        refresh.click()
        page.wait_for_function('window.__directHermesRefreshProbe.held === true', timeout=10000)
        during = snapshot_rows(page)
        # Signal must exist inside the fixed-size header/button, not in the list.
        expect(page.get_by_role('button', name='Refreshing sessions', exact=True)).to_be_disabled()
        assert during['busy'] == 'true'
        assert_unshifted(before, during)
        page.screenshot(path=str(stack.root / f'browser-refresh-{width}-during.png'), full_page=True)
        page.evaluate('window.__directHermesRefreshProbe.release()')
        expect(refresh).to_be_enabled(timeout=10000)
        after = snapshot_rows(page)
        assert_unshifted(before, after)
        page.screenshot(path=str(stack.root / f'browser-refresh-{width}-after.png'), full_page=True)
        samples.append({'width': width, 'height': height, 'before': before, 'during': during, 'after': after})
    probe = page.evaluate('({received:window.__directHermesRefreshProbe.received,released:window.__directHermesRefreshProbe.released,held:window.__directHermesRefreshProbe.held})')
    assert probe == {'received': 2, 'released': 2, 'held': False}, probe
    result = {'status': 'PASS', 'maxAllowedMovementPx': 1,
        'delay': 'Held delivery of two real native-WebSocket session.list results; unchanged network bytes in fresh event envelopes, no fake data or production changes',
        'probe': probe, 'viewports': samples}
    (stack.root / 'browser-refresh-geometry.json').write_text(json.dumps(result, indent=2))
    return result


def assert_settings_geometry(page, width):
    result = page.evaluate('''() => {
      const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
      const detail = document.querySelector('[data-testid="bot-management-detail"]');
      const form = detail.querySelector('form');
      return {width:innerWidth,documentScrollWidth:document.documentElement.scrollWidth,detail:rect(detail),form:rect(form),
        controls:[...form.querySelectorAll('input,button')].map(el => ({label:el.getAttribute('aria-label') || el.textContent || el.type,rect:rect(el)})),
        copy:[...form.querySelectorAll('p,[role="note"]')].map(el => ({rect:rect(el),clientWidth:el.clientWidth,scrollWidth:el.scrollWidth}))};
    }''')
    assert result['width'] == width and result['documentScrollWidth'] <= width, result
    for item in result['controls'] + result['copy']:
        rect = item['rect']
        assert rect['width'] > 0 and rect['height'] > 0 and rect['x'] >= -1 and rect['right'] <= width + 1, item
        assert rect['x'] >= result['form']['x'] - 1 and rect['right'] <= result['form']['right'] + 1, item
        if 'scrollWidth' in item:
            assert item['scrollWidth'] <= item['clientWidth'] + 1, item
    return result


def login(page, url, email):
    from playwright.sync_api import expect
    page.goto(url, wait_until='networkidle')
    page.get_by_label('Email', exact=True).fill(email)
    page.get_by_label('Password', exact=True).fill('Disposable-direct-hermes-123!')
    page.get_by_role('button', name='Sign in to acceptance', exact=True).click()
    expect(page.get_by_role('heading', name=re.compile('Direct Hermes'))).to_be_visible(timeout=30000)


def verify_manage(stack, page, browser, url, errors):
    from playwright.sync_api import expect
    path = settings.settings_path(stack)
    grantee, denied = stack.people['grantee'], stack.people['denied']
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.get_by_role('button', name='Manage bots', exact=True).click()
    endpoint = page.get_by_label('Gateway endpoint', exact=True)
    token = page.get_by_label('Replacement gateway token', exact=True)
    save = page.get_by_role('button', name='Save Direct Hermes settings', exact=True)
    expect(endpoint).to_be_visible(timeout=30000)
    current = settings.get_settings(stack)
    expect(endpoint).to_have_value(current['endpoint'])
    expect(token).to_have_value('')
    expect(token).to_have_attribute('type', 'password')
    expect(page.get_by_text('Gateway token configured', exact=True)).to_be_visible()
    warning = page.get_by_role('note', name='Shared gateway access warning')
    expect(warning).to_contain_text('same Hermes gateway and all its sessions and runtime controls')
    expect(warning).to_contain_text('not isolated private-chat access')
    expect(page.get_by_text('Only you (the owner). No one else has access by default.', exact=True)).to_be_visible()
    assert stack.gateway_token not in page.content() and settings.cipher(stack) not in page.content()
    selected = page.get_by_role('checkbox', name=grantee['user']['name'], exact=True)
    other = page.get_by_role('checkbox', name=denied['user']['name'], exact=True)
    expect(selected).not_to_be_checked()
    expect(other).not_to_be_checked()
    expect(page.get_by_role('checkbox', name=stack.outsider['user']['name'], exact=True)).to_have_count(0)
    selected.check()
    expect(save).to_be_disabled()
    acknowledgment = page.get_by_role('checkbox', name=re.compile('I understand that sharing'))
    acknowledgment.check()
    expect(save).to_be_enabled()
    patches = []

    def save_and_roundtrip(expected_ids=None, replacement=False):
        with page.expect_response(lambda response: urlparse(response.url).path == path and response.request.method == 'PATCH') as pending:
            save.click()
        response = pending.value
        assert response.status == 200, response.status
        value = settings.public_settings(stack, response.json(), response.all_headers())
        assert settings.get_settings(stack) == value
        payload = response.request.post_data_json
        assert payload['revision']
        if expected_ids is not None:
            assert value['allowedUserIds'] == expected_ids and payload['allowedUserIds'] == expected_ids
        if replacement:
            assert payload['gatewayToken'] == stack.gateway_token
        else:
            assert not payload.get('gatewayToken'), 'Access-only save must not send a stored gateway token'
        patches.append({'status': response.status, 'requestKeys': sorted(payload),
            'allowedUserIds': value['allowedUserIds'], 'acknowledgeSharedAccess': payload.get('acknowledgeSharedAccess', False),
            'replacementTokenSubmitted': bool(payload.get('gatewayToken')), 'endpoint': value['endpoint'],
            'noStore': response.all_headers().get('cache-control') == 'no-store'})
        expect(page.get_by_text(re.compile('Direct Hermes settings saved'))).to_be_visible()
        expect(token).to_have_value('')
        return value

    current = save_and_roundtrip([grantee['user']['id']])
    assert patches[-1]['acknowledgeSharedAccess'] is True
    page.get_by_role('button', name='Direct Hermes chat', exact=True).click()
    page.get_by_role('button', name='Manage bots', exact=True).click()
    expect(selected).to_be_checked(timeout=30000)
    expect(token).to_have_value('')
    geometry = []
    for width, height in ((1440, 1000), (390, 844)):
        page.set_viewport_size({'width': width, 'height': height})
        endpoint.scroll_into_view_if_needed()
        geometry.append(assert_settings_geometry(page, width))
        page.screenshot(path=str(stack.root / f'browser-manage-bots-{width}.png'), full_page=True)
    # Edit endpoint + replacement through actual production Eden controls. No
    # second gateway: an unserved path proves persistence, then restore validity.
    endpoint.fill(stack.upstream + '/browser-change')
    expect(save).to_be_disabled()
    token.fill(stack.gateway_token)
    expect(save).to_be_enabled()
    changed = save_and_roundtrip(replacement=True)
    assert changed['endpoint'].endswith('/browser-change/api/ws')
    endpoint.fill(stack.upstream)
    token.fill(stack.gateway_token)
    expect(save).to_be_enabled()
    current = save_and_roundtrip(replacement=True)
    assert current['endpoint'] == stack.upstream.replace('http:', 'ws:') + '/api/ws'

    contexts = []
    role_requests = []
    role_frames = []
    closed = []
    try:
        def persona_page(persona):
            context = browser.new_context(viewport={'width': 390, 'height': 844})
            contexts.append(context)
            context.route('**/*', lambda route: route.continue_() if urlparse(route.request.url).hostname in ('127.0.0.1', 'localhost') else route.abort())
            tab = context.new_page()
            tab.on('pageerror', lambda error: errors.append(str(error)))
            def on_socket(ws):
                if urlparse(ws.url).path != '/hermes-proxy':
                    return
                ws.on('close', lambda: closed.append(time.monotonic()))
                for event, direction in (('framereceived', 'received'), ('framesent', 'sent')):
                    ws.on(event, lambda data, direction=direction: role_frames.append({'role': persona['user']['name'],
                        'direction': direction, 'frame': json.loads(data)}) if isinstance(data, str) else None)
            tab.on('websocket', on_socket)
            tab.on('response', lambda response: role_requests.append({'role': persona['user']['name'], 'path': urlparse(response.url).path,
                'status': response.status}) if urlparse(response.url).netloc == urlparse(stack.api).netloc else None)
            login(tab, url, persona['user']['email'])
            return tab
        grantee_page = persona_page(grantee)
        grantee_page.get_by_role('button', name=re.compile('Acceptance session A')).click(timeout=30000)
        expect(grantee_page.get_by_text('Inference fixture verified the real Hermes terminal result for session A.', exact=True)).to_be_visible(timeout=30000)
        replies = grantee_page.get_by_text('Inference fixture browser followup completed with saved history.', exact=True)
        previous_replies = replies.count()
        grantee_page.get_by_label('Message Hermes', exact=True).fill('DIRECT_HERMES_UI_FOLLOWUP')
        grantee_page.get_by_role('button', name='Send', exact=True).click()
        expect(replies).to_have_count(previous_replies + 1, timeout=60000)
        grantee_page.screenshot(path=str(stack.root / 'browser-grantee-shared-session.png'), full_page=True)
        selected.uncheck()
        started = time.monotonic()
        save_and_roundtrip([])
        expect(grantee_page.get_by_text('Disconnected', exact=True)).to_be_visible(timeout=5000)
        revoked_seconds = time.monotonic() - started
        assert revoked_seconds <= settings.REVOKE_BOUND_SECONDS, revoked_seconds
        assert closed and closed[-1] >= started, 'Active browser WebSocket close event was not observed'
        settings.ticket_for(stack, grantee, expected=403)
        grantee_page.get_by_role('button', name='Manage bots', exact=True).click()
        expect(grantee_page.get_by_role('heading', name='No bots yet', exact=True)).to_be_visible(timeout=30000)
        expect(grantee_page.get_by_label('Gateway endpoint', exact=True)).to_have_count(0)
        denied_page = persona_page(denied)
        expect(denied_page.get_by_role('alert')).to_be_visible(timeout=30000)
        assert any(item['role'] == denied['user']['name'] and item['path'].endswith('/hermes-rpc/proxy-ticket') and item['status'] == 403 for item in role_requests), role_requests
        expect(denied_page.locator('aside[aria-label="Sessions"] button[aria-pressed]')).to_have_count(0)
        denied_page.screenshot(path=str(stack.root / 'browser-denied-human.png'), full_page=True)
        assert not errors, errors
        grantee_frames = [item for item in role_frames if item['role'] == grantee['user']['name']]
        methods = {item['frame'].get('method') for item in grantee_frames if item['direction'] == 'sent'}
        events = {item['frame']['params']['type'] for item in grantee_frames if item['direction'] == 'received' and item['frame'].get('method') == 'event'}
        assert {'session.list', 'session.resume', 'prompt.submit'} <= methods, methods
        assert {'gateway.ready', 'message.complete'} <= events, events
        result = {'status': 'PASS', 'surface': 'Actual BotsManageRoute and DirectHermesSessionsView; actual Eden auth/workspaces/own-DM; native KV only bridged',
            'settingsPatches': patches, 'ownerOnlyMetadataRoundTrips': True, 'configuredTokenNeverRevealed': True,
            'explicitSharedGatewayWarning': True, 'requiresGrantAcknowledgment': True, 'granteeSharedHistoryPrompt': True,
            'revokedBrowserDisconnectedSeconds': revoked_seconds, 'granteeCannotManageBots': True, 'deniedHumanFreshTicket403': True,
            'geometry': geometry, 'roleRequests': role_requests, 'granteeRpcMethods': sorted(methods),
            'granteeEventTypes': sorted(events), 'unexpectedPageErrors': errors}
        (stack.root / 'browser-settings-evidence.json').write_text(json.dumps(result, indent=2))
        return result
    finally:
        (stack.root / 'browser-role-rpc-frames.json').write_text(json.dumps(role_frames, indent=2))
        for context in contexts:
            context.close()
