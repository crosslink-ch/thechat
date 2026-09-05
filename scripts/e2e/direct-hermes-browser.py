#!/usr/bin/env python3
"""Production-built actual chat view, dedicated authenticated E2E entry.

This is not Tauri/full-app navigation acceptance. No mock RPC/transport or auth
bypass: the entry signs in through real TheChat and the view obtains real tickets.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def build(stack):
    ui = stack.root / 'browser-app'
    ui.mkdir()
    (ui / 'node_modules').symlink_to(REPO / 'packages/desktop/node_modules', target_is_directory=True)
    source = (HERE / 'direct-hermes-browser-app.tsx').read_text()
    source = source.replace('__DIRECT_HERMES_COMPONENT__', str(REPO / 'packages/desktop/src/components/DirectHermesSessionsView.tsx'))
    source = source.replace('__DIRECT_HERMES_DESKTOP__', str(REPO / 'packages/desktop/src'))
    source = source.replace('__DIRECT_HERMES_CSS__', './harness.css')
    # Tailwind v4 scans the build root by default. Our dedicated entry lives in
    # scratch, so explicitly include the actual external production source tree;
    # otherwise the view renders mostly unstyled and geometry is meaningless.
    (ui / 'harness.css').write_text('@import ' + json.dumps(str(REPO / 'packages/desktop/src/App.css')) + ';\n@source ' + json.dumps(str(REPO / 'packages/desktop/src')) + ';\n')
    (ui / 'main.tsx').write_text(source)
    (ui / 'index.html').write_text('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Direct Hermes inference fixture acceptance</title></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>')
    bot = {'botId': stack.bot['id'], 'botName': stack.bot['name'], 'botUserId': stack.bot['userId'], 'workspaceId': stack.workspace['id']}
    (ui / 'vite.config.mjs').write_text("import {defineConfig} from 'vite';\nimport react from '@vitejs/plugin-react';\nimport tailwind from '@tailwindcss/vite';\nexport default defineConfig(" +
        '{plugins:[react(),tailwind()],envDir:false,define:' + json.dumps({'__BACKEND_URL__': json.dumps(stack.api), '__ACCEPTANCE_BOT__': json.dumps(bot)}) +
        ',build:{outDir:"dist",emptyOutDir:true}});\n')
    result = stack.run(['node', str(REPO / 'packages/desktop/node_modules/vite/bin/vite.js'), 'build', '--config', str(ui / 'vite.config.mjs')], cwd=ui, timeout=120)
    (stack.root / 'browser-build.log').write_text(result)
    css = '\n'.join(path.read_text() for path in (ui / 'dist/assets').glob('*.css'))
    for utility in ('.flex-col', '.min-w-0', '.overflow-y-auto', '.overflow-auto', '.whitespace-pre-wrap'):
        assert utility in css, f'Production utility missing from harness CSS: {utility}'
    stack.spawn('browser-static', [sys.executable, '-m', 'http.server', str(stack.ports['ui']), '--bind', '127.0.0.1', '--directory', str(ui / 'dist')])
    url = f"http://127.0.0.1:{stack.ports['ui']}/"
    from urllib.request import urlopen
    stack.wait('production browser entry', lambda: urlopen(url, timeout=2).status == 200)
    return url


def assert_geometry(page, width, height, require_tool=True):
    """Measure actual component bounds, including adversarial user/draft text."""
    measurements = page.evaluate('''() => {
      const rect = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
      const textarea = document.querySelector('textarea[aria-label="Message Hermes"]');
      const send = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Send');
      const chat = document.querySelector('section[aria-label="Hermes chat"]');
      const aside = document.querySelector('aside[aria-label="Sessions"]');
      const content = [...chat.querySelectorAll('article p, details pre')].map(el => ({
        rect:rect(el),clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,kind:el.tagName,
        overflowX:getComputedStyle(el).overflowX}));
      const chatStyle = getComputedStyle(chat);
      const pre = chat.querySelector('details pre');
      return {innerWidth,innerHeight,documentScrollWidth:document.documentElement.scrollWidth,
        textarea:rect(textarea),send:rect(send),chat:rect(chat),aside:rect(aside),
        styles:{chatDisplay:chatStyle.display,chatDirection:chatStyle.flexDirection,
          chatMinWidth:chatStyle.minWidth,preOverflowX:pre && getComputedStyle(pre).overflowX,
          preWhiteSpace:pre && getComputedStyle(pre).whiteSpace},
        chatClientWidth:chat.clientWidth,chatScrollWidth:chat.scrollWidth,content};
    }''')
    assert measurements['styles'] == {'chatDisplay': 'flex', 'chatDirection': 'column', 'chatMinWidth': '0px',
        'preOverflowX': 'auto' if require_tool else None, 'preWhiteSpace': 'pre-wrap' if require_tool else None}, ('production utilities not effective', measurements)
    assert measurements['innerWidth'] == width and measurements['innerHeight'] == height
    assert measurements['documentScrollWidth'] <= width, measurements
    assert measurements['chatScrollWidth'] <= measurements['chatClientWidth'] + 1, measurements
    for key in ('textarea', 'send', 'chat', 'aside'):
        rectangle = measurements[key]
        assert rectangle['width'] > 0 and rectangle['height'] > 0, (key, measurements)
        assert rectangle['x'] >= -1 and rectangle['right'] <= width + 1, (key, measurements)
        assert rectangle['y'] >= -1 and rectangle['bottom'] <= height + 1, (key, measurements)
        if key in ('textarea', 'send'):
            aside = measurements['aside']
            overlap_x = min(rectangle['right'], aside['right']) - max(rectangle['x'], aside['x'])
            overlap_y = min(rectangle['bottom'], aside['bottom']) - max(rectangle['y'], aside['y'])
            assert overlap_x <= 1 or overlap_y <= 1, ('sidebar overlaps control', key, measurements)
    for item in measurements['content']:
        assert item['scrollWidth'] <= item['clientWidth'] + 1, ('long content overflows element', item)
        assert item['rect']['x'] >= measurements['chat']['x'] - 1 and item['rect']['right'] <= measurements['chat']['right'] + 1, item
    return measurements


def verify(stack):
    os.environ['PLAYWRIGHT_BROWSERS_PATH'] = str(Path(stack.args.scratch).resolve() / 'browsers')
    from playwright.sync_api import sync_playwright, expect
    url = build(stack)
    extension_spec = importlib.util.spec_from_file_location('browser_settings', HERE / 'direct-hermes-browser-settings.py')
    extension = importlib.util.module_from_spec(extension_spec)
    extension_spec.loader.exec_module(extension)
    extension.settings.cipher(stack)
    errors = []
    requests = []
    frames = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script(path=str(HERE / 'direct-hermes-refresh-latency.js'))
        # Fixture browser must never reach external services either.
        context.route('**/*', lambda route: route.continue_() if urlparse(route.request.url).hostname in ('127.0.0.1', 'localhost') else route.abort())
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        response_violations = []
        def on_response(response):
            if urlparse(response.url).netloc != urlparse(stack.api).netloc:
                return
            path = urlparse(response.url).path
            record = {'path': path, 'status': response.status, 'method': response.request.method}
            if '/hermes-rpc/' in path:
                record['cacheControl'] = response.all_headers().get('cache-control')
                if record['cacheControl'] != 'no-store':
                    response_violations.append('Missing no-store: ' + path)
                body = response.text()
                if stack.gateway_token in body or any(value in body for value in [*getattr(stack, 'replacement_tokens', []), *stack.gateway_ciphertexts]):
                    response_violations.append('Gateway credential disclosed: ' + path)
            requests.append(record)
        page.on('response', on_response)
        def on_socket(ws):
            if urlparse(ws.url).path == '/hermes-proxy':
                if urlparse(ws.url).query or stack.gateway_token in ws.url:
                    response_violations.append('Proxy WebSocket URL contains credentials/query parameters')
                ws.on('framereceived', lambda data: frames.append({'direction': 'received', 'frame': json.loads(data)}) if isinstance(data, str) else None)
                ws.on('framesent', lambda data: frames.append({'direction': 'sent', 'frame': json.loads(data)}) if isinstance(data, str) else None)
        page.on('websocket', on_socket)
        try:
            page.goto(url, wait_until='networkidle')
            page.get_by_label('Email', exact=True).fill(stack.run_id + '-owner@example.test')
            page.get_by_label('Password', exact=True).fill('Disposable-direct-hermes-123!')
            page.get_by_role('button', name='Sign in to acceptance', exact=True).click()
            expect(page.get_by_role('heading', name=re.compile('Direct Hermes'))).to_be_visible(timeout=30000)
            # Selectors are the visible production view labels, not mocked state.
            page.get_by_role('button', name=re.compile('Acceptance session A')).click(timeout=30000)
            expect(page.get_by_text('Inference fixture verified the real Hermes terminal result for session A.', exact=True)).to_be_visible(timeout=30000)
            # The settings gate intentionally adds a grantee turn to this SAME
            # history, so more than one genuine followup is valid with --settings.
            expect(page.get_by_text('Inference fixture resumed session A with its saved terminal history.', exact=True).last).to_be_visible()
            page.locator('textarea').fill('DIRECT_HERMES_UI_FOLLOWUP')
            page.get_by_role('button', name='Send', exact=True).click()
            expect(page.get_by_text('Inference fixture browser followup completed with saved history.', exact=True)).to_be_visible(timeout=60000)
            page.get_by_role('button', name=re.compile('Acceptance session B')).click()
            expect(page.get_by_text('Inference fixture session B is isolated.', exact=True)).to_be_visible(timeout=30000)
            expect(page.get_by_text('Inference fixture browser followup completed with saved history.', exact=True)).not_to_be_visible()
            page.get_by_role('button', name=re.compile('Acceptance session A')).click()
            expect(page.get_by_text('Inference fixture browser followup completed with saved history.', exact=True)).to_be_visible(timeout=30000)
            page.screenshot(path=str(stack.root / 'browser-session-a.png'), full_page=True)
            # A full page reload must recover the saved Hermes messages with a fresh ticket.
            page.reload(wait_until='networkidle')
            page.get_by_role('button', name=re.compile('Acceptance session A')).click(timeout=30000)
            expect(page.get_by_text('Inference fixture browser followup completed with saved history.', exact=True)).to_be_visible(timeout=30000)
            # Force the browser-triggered terminal call to create fresh evidence.
            stack.marker.unlink()
            page.get_by_role('button', name='New session', exact=True).click()
            expect(page.get_by_text('Send a message to start this session.', exact=True)).to_be_visible(timeout=30000)
            page.get_by_label('Message Hermes', exact=True).fill('DIRECT_HERMES_TOOL_A: browser-created session; real terminal check. Long-content boundary: ' + 'x' * 800)
            expect(page.get_by_role('button', name='Send', exact=True)).to_be_enabled()
            page.get_by_role('button', name='Send', exact=True).click()
            tool_card = page.locator('details').filter(has=page.locator('summary', has_text='terminal')).last
            expect(tool_card).to_be_visible(timeout=60000)
            expect(tool_card.locator('summary')).to_contain_text('Running…')
            tool_card.locator('summary').click()
            expect(tool_card.locator('pre').first).to_contain_text('printf')
            rendered_args = json.loads(tool_card.locator('pre').first.inner_text())
            assert rendered_args == {'command': 'sleep 3; ' + stack.report['terminal']['command'], 'timeout': 10}, rendered_args
            page.screenshot(path=str(stack.root / 'browser-tool-running.png'), full_page=True)
            expect(page.get_by_text('Inference fixture verified the real Hermes terminal result for session A.', exact=True)).to_be_visible(timeout=60000)
            expect(tool_card.locator('summary')).to_contain_text('Finished')
            expect(tool_card.locator('pre').last).to_contain_text('DIRECT_HERMES_REAL_TERMINAL_OK')
            expect(tool_card.locator('pre').last).to_contain_text('"exit_code": 0')
            assert stack.marker.read_text().strip() == 'DIRECT_HERMES_REAL_TERMINAL_OK'
            geometry = []
            for width, height in ((1440, 1000), (390, 844)):
                page.set_viewport_size({'width': width, 'height': height})
                page.get_by_label('Message Hermes', exact=True).fill('Long unsent draft ' + 'z' * 1024)
                expect(page.get_by_role('button', name='Send', exact=True)).to_be_enabled()
                geometry.append(assert_geometry(page, width, height))
                page.screenshot(path=str(stack.root / f'browser-component-{width}.png'), full_page=True)
                if width == 390:
                    lower_row = page.get_by_role('button', name=re.compile('Acceptance session B'))
                    lower_row.scroll_into_view_if_needed()
                    lower_row.click()
                    expect(page.get_by_text('Inference fixture session B is isolated.', exact=True)).to_be_visible(timeout=30000)
                    expect(page.get_by_text('Inference fixture verified the real Hermes terminal result for session A.', exact=True)).not_to_be_visible()
                    expect(page.get_by_label('Message Hermes', exact=True)).to_be_visible()
                    expect(page.get_by_role('button', name='Send', exact=True)).to_be_visible()
                    mobile_navigation = {'lowerSessionBAccessible': True, 'isolatedHistory': True,
                        'geometry': assert_geometry(page, width, height, require_tool=False)}
                    page.screenshot(path=str(stack.root / 'browser-mobile-session-b.png'), full_page=True)
                    new_row = page.get_by_role('button', name=re.compile('DIRECT_HERMES_TOOL_A: browser-created session'))
                    new_row.scroll_into_view_if_needed()
                    new_row.click()
                    expect(page.get_by_text('Inference fixture verified the real Hermes terminal result for session A.', exact=True)).to_be_visible(timeout=30000)
                    expect(page.get_by_text('Inference fixture session B is isolated.', exact=True)).not_to_be_visible()
                    mobile_navigation['returnedToNewSession'] = True
            page.set_viewport_size({'width': 1440, 'height': 1000})
            page.get_by_label('Message Hermes', exact=True).fill('')
            page.screenshot(path=str(stack.root / 'browser-new-tool-turn.png'), full_page=True)
            body = page.locator('body').inner_text()
            (stack.root / 'browser-dom.txt').write_text(body)
            sent_methods = [f['frame'].get('method') for f in frames if f['direction'] == 'sent']
            received_events = [f['frame']['params']['type'] for f in frames if f['direction'] == 'received' and f['frame'].get('method') == 'event']
            assert {'session.list', 'session.resume', 'session.create', 'prompt.submit'} <= set(sent_methods), sent_methods
            assert {'gateway.ready', 'message.start', 'message.delta', 'tool.start', 'tool.complete', 'message.complete'} <= set(received_events), received_events
            assert any(req['path'] == '/auth/login' and req['status'] == 200 for req in requests), requests
            tickets = [r for r in requests if r['path'].endswith('/hermes-rpc/proxy-ticket')]
            assert len(tickets) >= 2 and all(r['status'] == 200 for r in tickets), tickets
            assert not errors, errors
            audit = json.loads((stack.root / 'fixture-audit.json').read_text())
            assert any(r['stage'] == 'browser_followup' for r in audit), audit
            assert sum(r['stage'] == 'verified_real_tool_result' for r in audit) >= 2, audit
            refresh_geometry = extension.verify_refresh(stack, page)
            settings_evidence = extension.verify_manage(stack, page, browser, url, errors) if stack.args.settings else {'status': 'not requested'}
            assert not errors, errors
            assert not response_violations, response_violations
            tickets = [r for r in requests if r['path'].endswith('/hermes-rpc/proxy-ticket')]
            sent_methods = [f['frame'].get('method') for f in frames if f['direction'] == 'sent']
            received_events = [f['frame']['params']['type'] for f in frames if f['direction'] == 'received' and f['frame'].get('method') == 'event']
            stack.report['browser'] = {'status': 'PASS', 'url': url,
                'surface': 'production-built actual DirectHermesSessionsView + BotsManageRoute in a dedicated real Eden auth/workspace entry; not full Tauri shell',
                'realLogin': True, 'proxyTicketRequests': len(tickets), 'pageErrors': errors,
                'savedSessionResumeFollowup': True, 'switchIsolation': True, 'pageReloadHistory': True,
                'newSessionRealTerminalTurn': True, 'renderedToolArgsAndResultVerified': True,
                'toolRunningStateCaptured': True, 'componentGeometry': geometry, 'mobileSessionNavigation': mobile_navigation,
                'refreshZeroShift': refresh_geometry, 'manageBots': settings_evidence,
                'hermesApiNoStoreCredentialRedaction': True,
                'rpcMethods': sorted(set(sent_methods)),
                'eventTypes': sorted(set(received_events)), 'screenshots': sorted(path.name for path in stack.root.glob('browser*.png'))}
        except Exception:
            stack.report['browser'] = {'status': 'FAIL', 'url': url, 'pageErrors': errors}
            (stack.root / 'browser-failure-dom.txt').write_text(page.locator('body').inner_text())
            page.screenshot(path=str(stack.root / 'browser-failure.png'), full_page=True)
            raise
        finally:
            (stack.root / 'browser-rpc-frames.json').write_text(json.dumps(frames, indent=2))
            (stack.root / 'browser-api-requests.json').write_text(json.dumps(requests, indent=2))
            context.close()
            browser.close()
