#!/usr/bin/env python3
"""Negative controls for acceptance assertions, NOT replacement E2E evidence."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest
import websockets

spec = importlib.util.spec_from_file_location('browser_settings', Path(__file__).with_name('direct-hermes-browser-settings.py'))
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


class RefreshAssertionTest(unittest.TestCase):
    def setUp(self):
        rect = {'x': 8, 'y': 120, 'width': 240, 'height': 70}
        self.before = {'rows': [{'text': 'Saved session', 'rect': rect}],
            'childCount': 1, 'loadingRow': False, 'scrollTop': 23, 'scrollLeft': 0,
            'documentScrollY': 0, 'list': dict(rect), 'refresh': {'x': 168, 'y': 32, 'width': 72, 'height': 32}}

    def test_identical_measurements_pass(self):
        checks.assert_unshifted(self.before, copy.deepcopy(self.before))

    def test_loading_row_insertion_fails(self):
        sample = copy.deepcopy(self.before)
        sample['childCount'] += 1
        sample['loadingRow'] = True
        with self.assertRaisesRegex(AssertionError, 'row inserted'):
            checks.assert_unshifted(self.before, sample)

    def test_legacy_loading_text_fails_even_without_extra_child(self):
        sample = copy.deepcopy(self.before)
        sample['loadingRow'] = True
        with self.assertRaisesRegex(AssertionError, 'Loading sessions row'):
            checks.assert_unshifted(self.before, sample)

    def test_existing_row_movement_fails(self):
        sample = copy.deepcopy(self.before)
        sample['rows'][0]['rect']['y'] += 2
        with self.assertRaises(AssertionError):
            checks.assert_unshifted(self.before, sample)

    def test_list_scroll_reset_fails(self):
        sample = copy.deepcopy(self.before)
        sample['scrollTop'] = 0
        with self.assertRaises(AssertionError):
            checks.assert_unshifted(self.before, sample)

    def test_refresh_button_resize_fails(self):
        sample = copy.deepcopy(self.before)
        sample['refresh']['width'] += 20
        with self.assertRaises(AssertionError):
            checks.assert_unshifted(self.before, sample)

    def test_row_reordering_or_content_change_fails(self):
        sample = copy.deepcopy(self.before)
        sample['rows'][0]['text'] = 'Different session'
        with self.assertRaises(AssertionError):
            checks.assert_unshifted(self.before, sample)


@unittest.skipUnless(os.environ.get('DIRECT_HERMES_LATENCY_BROWSER_TEST') == '1', 'Opt-in real-browser probe plumbing test')
class LatencyDeliveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_held_network_bytes_reach_application_after_release(self):
        from playwright.async_api import async_playwright
        os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', '/workspace/direct-hermes-e2e/browsers')
        # A tiny socket peer tests ONLY delay plumbing, not Hermes behavior. The
        # final acceptance uses the exact same probe with the real Hermes process.
        payload = {'jsonrpc': '2.0', 'id': 'probe-only', 'result': {'sessions': []}}
        async def respond(socket):
            request = json.loads(await socket.recv())
            self.assertEqual(request['method'], 'session.list')
            await socket.send(json.dumps(payload))
            await socket.wait_closed()
        async with websockets.serve(respond, '127.0.0.1', 0) as server:
            port = server.sockets[0].getsockname()[1]
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(args=['--no-sandbox'])
                try:
                    page = await browser.new_page()
                    await page.add_init_script(path=str(Path(__file__).with_name('direct-hermes-refresh-latency.js')))
                    await page.goto('about:blank')
                    await page.evaluate('''url => {
                        window.deliveries = [];
                        const socket = new WebSocket(url);
                        socket.addEventListener('message', event => deliveries.push(JSON.parse(event.data)));
                        socket.addEventListener('open', () => {
                            __directHermesRefreshProbe.arm = true;
                            socket.send(JSON.stringify({jsonrpc:'2.0',id:'probe-only',method:'session.list'}));
                        });
                    }''', f'ws://127.0.0.1:{port}')
                    await page.wait_for_function('__directHermesRefreshProbe.held')
                    self.assertEqual(await page.evaluate('deliveries.length'), 0)
                    await page.evaluate('__directHermesRefreshProbe.release()')
                    await page.wait_for_function('deliveries.length === 1', timeout=1000)
                    self.assertEqual(await page.evaluate('deliveries[0]'), payload)
                finally:
                    await browser.close()


if __name__ == '__main__':
    unittest.main()
