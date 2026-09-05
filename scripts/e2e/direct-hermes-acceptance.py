#!/usr/bin/env python3
"""Real Hermes + TheChat owner-only raw-proxy acceptance, INFERENCE FIXTURE.

Run with Hermes' prepared .venv Python. Own disposable PostgreSQL/Redis,
API/proxy/Hermes processes, browser, HOME and HERMES_HOME. No paid LLM/keys.
All resources are loopback-only and cleaned up, including on bounded failure.
"""
from __future__ import annotations
import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shlex
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import websockets

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PIN = '0825c35d9faa42b166101ffc448ef9acb46012ef'
PROTOCOL = 'thechat-hermes-proxy-v1'
spec = importlib.util.spec_from_file_location('inference_fixture', HERE / 'direct-hermes-inference-fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def request(base, method, path, body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = Request(base + path, method=method, headers=headers,
        data=None if body is None else json.dumps(body).encode())
    try:
        response = urlopen(req, timeout=10)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read().decode()
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = raw
        return response.status, parsed, {k.lower(): v for k, v in response.headers.items()}


class Stack:
    def __init__(self, args):
        self.args = args
        self.run_id = 'direct-hermes-' + secrets.token_hex(6)
        self.root = Path(args.scratch).resolve() / self.run_id
        self.root.mkdir(parents=True, mode=0o700)
        self.home = self.root / 'home'
        self.home.mkdir(mode=0o700)
        self.hermes_home = self.root / 'hermes-home'
        self.hermes_home.mkdir(mode=0o700)
        self.source = Path(args.hermes_source).resolve()
        self.ports = {name: port() for name in ('pg', 'redis', 'api', 'proxy', 'hermes', 'model', 'ui')}
        assert len(set(self.ports.values())) == len(self.ports)
        self.api = f"http://127.0.0.1:{self.ports['api']}"
        self.upstream = f"http://127.0.0.1:{self.ports['hermes']}"
        self.model = f"http://127.0.0.1:{self.ports['model']}/v1"
        self.marker = self.root / 'terminal-marker.txt'
        self.gateway_token = secrets.token_urlsafe(32)
        self.processes = []
        self.containers = []
        self.docker = shlex.split(args.docker)
        self.env = {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
            'HOME': str(self.home), 'LANG': 'C.UTF-8', 'TERM': 'dumb',
            'NODE_ENV': 'test', 'CI': '1',
            'THECHAT_E2E_LOOPBACK_ONLY': '1', 'THECHAT_E2E_RUN_ID': self.run_id,
            'DATABASE_URL': f"postgres://thechat:disposable-fixture-db@127.0.0.1:{self.ports['pg']}/thechat",
            'REDIS_URL': f"redis://127.0.0.1:{self.ports['redis']}",
            'REDIS_KEY_PREFIX': self.run_id + ':',
            'BETTER_AUTH_SECRET': secrets.token_urlsafe(48),
            'THECHAT_BACKEND_HOST': '127.0.0.1', 'THECHAT_BACKEND_PORT': str(self.ports['api']),
            'THECHAT_BACKEND_URL': self.api, 'BETTER_AUTH_URL': self.api,
            'THECHAT_HERMES_PROXY_HOST': '127.0.0.1', 'THECHAT_HERMES_PROXY_PORT': str(self.ports['proxy']),
            'THECHAT_HERMES_PROXY_URL': f"ws://127.0.0.1:{self.ports['proxy']}/hermes-proxy",
            'THECHAT_HERMES_PROXY_ALLOW_LOOPBACK': 'true',
            'THECHAT_HERMES_PROXY_ALLOWED_ORIGINS': '', 'BETTER_AUTH_RATE_LIMIT_ENABLED': 'false'}
        self.report = {'inference': 'deterministic loopback OpenAI-compatible inference fixture; NOT a paid LLM',
            'hermesSourceCommit': PIN, 'runDirectory': str(self.root), 'ports': self.ports,
            'browser': {'status': 'not requested'}, 'checks': {}}

    def run(self, command, cwd=None, timeout=90, env=None):
        done = subprocess.run(command, cwd=cwd or self.root, env=env or self.env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)
        if done.returncode:
            raise RuntimeError(f'Command failed ({done.returncode}): {command[0:3]}\n{done.stdout[-6000:]}')
        return done.stdout

    def spawn(self, name, command, cwd=None, env=None):
        logfile = self.root / f'{name}.log'
        with logfile.open('w') as log:
            process = subprocess.Popen(command, cwd=cwd or self.root, env=env or self.env,
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.processes.append((name, process))
        return process

    def wait(self, label, predicate, seconds=90):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            for name, process in self.processes:
                if process.poll() is not None:
                    raise RuntimeError(f'{name} exited: {(self.root / (name + ".log")).read_text()[-5000:]}')
            try:
                if predicate():
                    return
            except (OSError, HTTPError):
                pass
            time.sleep(0.25)
        raise TimeoutError(f'{label} not ready after {seconds}s')

    def start(self):
        # Source archive is pinned by the supplied parent; record critical byte hashes.
        import hashlib
        self.report['hermesSourceHashes'] = {name: hashlib.sha256((self.source / name).read_bytes()).hexdigest()
            for name in ('tui_gateway/methods_prompt.py', 'tui_gateway/methods_session.py', 'tui_gateway/server.py', 'tui_gateway/ws.py')}
        expected_hashes = {
            'tui_gateway/methods_prompt.py': 'bd3c5858f7abe84cbc38fec319b1c9f747e52a2fdae49f024e1b05ab545c0335',
            'tui_gateway/methods_session.py': '539dae7bca0402c892627be6cd285a31b03d204cdb4da6139eefeeae460b6d00',
            'tui_gateway/server.py': '1862df4fed726c9cb019488e0ebdda978f4ef6e44a63800490e8023903f33c7d',
            'tui_gateway/ws.py': 'a816b8cc609219246c96887c7dc08e32a849fdc37dbc3b05e7c1aa8e10fb0ab5'}
        assert self.report['hermesSourceHashes'] == expected_hashes, 'Hermes RPC source bytes differ from audited pin'
        for kind, image, target, extra in (
            ('pg', self.args.postgres_image, 5432, ['-e', 'POSTGRES_USER=thechat', '-e', 'POSTGRES_PASSWORD=disposable-fixture-db', '-e', 'POSTGRES_DB=thechat']),
            ('redis', self.args.redis_image, 6379, [])):
            name = self.run_id + '-' + kind
            self.run(self.docker + ['run', '-d', '--rm', '--name', name,
                '--label', 'thechat.direct-hermes-e2e=' + self.run_id,
                '-p', f'127.0.0.1:{self.ports[kind]}:{target}', *extra, image])
            self.containers.append(name)
        self.wait('Postgres', lambda: subprocess.run(self.docker + ['exec', self.containers[0], 'pg_isready', '-U', 'thechat'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0)
        self.wait('Redis', lambda: subprocess.run(self.docker + ['exec', self.containers[1], 'redis-cli', 'ping'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0)
        migration = self.run(['bun', '--no-env-file', 'run', 'drizzle-kit', 'migrate'], cwd=REPO / 'packages/api')
        (self.root / 'migration.log').write_text(migration)
        self.spawn('api', ['bun', '--no-env-file', 'run', str(REPO / 'packages/api/src/index.ts')], cwd=REPO / 'packages/api')
        proxy_env = dict(self.env)
        proxy_env.pop('DATABASE_URL')
        self.spawn('proxy', ['bun', '--no-env-file', 'run', str(REPO / 'packages/hermes-proxy/src/server.ts')], env=proxy_env)
        self.spawn('inference-fixture', [sys.executable, str(HERE / 'direct-hermes-inference-fixture.py'),
            '--port', str(self.ports['model']), '--marker', str(self.marker), '--audit', str(self.root / 'fixture-audit.json')])
        # This is a freshly created test config, not a mutation of user settings.
        (self.hermes_home / 'config.yaml').write_text(
            f'model:\n  provider: custom\n  default: {fixture.MODEL}\n  base_url: {self.model}\n  api_mode: chat_completions\n'
            'terminal:\n  backend: local\n  timeout: 15\n'
            'agent:\n  max_turns: 6\nstreaming:\n  enabled: true\n'
            'memory:\n  memory_enabled: false\n  user_profile_enabled: false\n'
            'display:\n  tool_progress: all\napprovals:\n  mode: manual\n'
            'dashboard:\n  turn_isolation: false\n')
        hermes_env = {key: self.env[key] for key in ('PATH', 'HOME', 'LANG', 'TERM')}
        hermes_env.update({'HERMES_HOME': str(self.hermes_home),
            'DIRECT_HERMES_SOURCE': str(self.source), 'DIRECT_HERMES_RPC_PORT': str(self.ports['hermes']),
            'DIRECT_HERMES_PROVIDER_EVIDENCE': str(self.root / 'provider-evidence.json'),
            'HERMES_MANAGED_DIR': str(self.root / 'managed-disabled'),
            'HERMES_DASHBOARD_SESSION_TOKEN': self.gateway_token,
            'OPENAI_API_KEY': 'direct-hermes-local-inference-fixture-only', 'OPENAI_BASE_URL': self.model,
            'CUSTOM_BASE_URL': self.model, 'HERMES_INFERENCE_PROVIDER': 'custom',
            'HERMES_INFERENCE_MODEL': fixture.MODEL, 'HERMES_TUI_TOOLSETS': 'terminal',
            'TERMINAL_ENV': 'local', 'TERMINAL_CWD': str(self.root), 'TIRITH_ENABLED': '0',
            'PYTHONUNBUFFERED': '1', 'HTTP_PROXY': 'http://127.0.0.1:9',
            'HTTPS_PROXY': 'http://127.0.0.1:9', 'ALL_PROXY': 'http://127.0.0.1:9',
            'NO_PROXY': 'localhost,127.0.0.1,::1'})
        self.spawn('hermes', [sys.executable, str(HERE / 'direct-hermes-runtime.py')], env=hermes_env)
        self.wait('TheChat API', lambda: request(self.api, 'GET', '/health')[0] == 200)
        self.wait('Hermes RPC', lambda: request(self.upstream, 'GET', '/api/status', token=self.gateway_token)[0] == 200)
        self.wait('Inference fixture', lambda: request(self.model[:-3], 'GET', '/health')[0] == 200)
        print('STACK_READY ' + str(self.root), flush=True)

    def api_ok(self, method, path, body=None, token=None, expected=200):
        status, data, headers = request(self.api, method, path, body, token)
        assert status == expected, (method, path, status, data)
        return data, headers

    def ticket(self):
        ticket, headers = self.api_ok('POST', f"/bots/{self.bot['id']}/hermes-rpc/proxy-ticket",
            {'conversationId': self.conversation['id']}, self.owner_token)
        assert headers.get('cache-control') == 'no-store'
        assert self.gateway_token not in json.dumps(ticket)
        return ticket

    def seed_auth(self):
        owner, _ = self.api_ok('POST', '/auth/register', {'name': 'Direct Hermes Fixture Owner',
            'email': self.run_id + '-owner@example.test', 'password': 'Disposable-direct-hermes-123!'})
        outsider, _ = self.api_ok('POST', '/auth/register', {'name': 'Direct Hermes Fixture Outsider',
            'email': self.run_id + '-outsider@example.test', 'password': 'Disposable-direct-hermes-123!'})
        self.owner_token = owner['accessToken']
        self.owner = owner['user']
        self.outsider = outsider
        self.workspace, _ = self.api_ok('POST', '/workspaces/create', {'name': 'Direct Hermes Inference Fixture'}, self.owner_token)
        self.bot, _ = self.api_ok('POST', '/bots/create', {'name': 'Real Hermes (inference fixture)',
            'kind': 'hermes-rpc', 'workspaceId': self.workspace['id'],
            'hermesRpc': {'endpoint': self.upstream, 'gatewayToken': self.gateway_token}}, self.owner_token)
        assert self.gateway_token not in json.dumps(self.bot)
        self.conversation, _ = self.api_ok('POST', '/conversations/dm',
            {'workspaceId': self.workspace['id'], 'otherUserId': self.bot['userId']}, self.owner_token)
        self.api_ok('POST', f"/bots/{self.bot['id']}/hermes-rpc/proxy-ticket",
            {'conversationId': self.conversation['id']}, outsider['accessToken'], expected=403)
        self.report['checks']['ownerAllowedOutsiderForbidden'] = True
        # Private runtime-only browser input, never committed or printed.
        (self.root / 'browser-input.json').write_text(json.dumps({'api': self.api,
            'botId': self.bot['id'], 'botName': self.bot['name'], 'conversationId': self.conversation['id'],
            'token': self.owner_token, 'workspaceId': self.workspace['id'], 'user': self.owner}))
        (self.root / 'browser-input.json').chmod(0o600)

    def verify_storage(self, session_a, session_b):
        connection = sqlite3.connect(self.hermes_home / 'state.db')
        rows_a = connection.execute('select role, content from messages where session_id=? order by id', (session_a,)).fetchall()
        rows_b = connection.execute('select role, content from messages where session_id=? order by id', (session_b,)).fetchall()
        connection.close()
        assert fixture.FINAL_A in [row[1] for row in rows_a], rows_a
        assert fixture.FINAL_FOLLOWUP in [row[1] for row in rows_a], rows_a
        assert fixture.FINAL_B in [row[1] for row in rows_b], rows_b
        assert any(role == 'tool' and fixture.MARKER in str(content) for role, content in rows_a)
        assert not any('DIRECT_HERMES_SESSION_B' in str(content) for _, content in rows_a)
        assert not any('DIRECT_HERMES_TOOL_A' in str(content) for _, content in rows_b)
        count = self.run(self.docker + ['exec', self.containers[0], 'psql', '-U', 'thechat', '-d', 'thechat', '-Atc', 'select count(*) from messages;']).strip()
        assert count == '0', f'TheChat unexpectedly persisted {count} history rows'
        self.report['storage'] = {'hermesSessionA': session_a, 'hermesSessionB': session_b,
            'hermesMessageRowsA': len(rows_a), 'hermesMessageRowsB': len(rows_b), 'thechatMessageRows': int(count)}
        self.report['checks']['hermesOwnsPersistentHistory'] = True

    def cleanup(self):
        for name, process in reversed(self.processes):
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                continue
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        removed = []
        for name in reversed(self.containers):
            label = self.run(self.docker + ['inspect', '--format', '{{index .Config.Labels "thechat.direct-hermes-e2e"}}', name]).strip()
            assert label == self.run_id, 'refusing to remove a container not owned by this run'
            self.run(self.docker + ['rm', '-f', name])
            removed.append(name)
        remaining = self.run(self.docker + ['ps', '-aq', '--filter', 'label=thechat.direct-hermes-e2e=' + self.run_id]).strip()
        assert not remaining, 'owned containers survived cleanup'
        self.report['cleanup'] = {'processesStopped': all(p.poll() is not None for _, p in self.processes),
            'containersRemoved': removed, 'verifiedNoOwnedContainersRemain': True}
        for filename in ('browser-input.json', 'preview-access.json'):
            private = self.root / filename
            if private.exists():
                private.unlink()


class RPC:
    def __init__(self, stack, ticket):
        self.stack, self.ticket = stack, ticket
        self.frames = []
        self.counter = 0

    async def __aenter__(self):
        self.ws = await websockets.connect(self.ticket['proxyUrl'],
            subprotocols=[PROTOCOL, 'thechat-ticket.' + self.ticket['ticket']],
            open_timeout=15, close_timeout=3, max_size=4 * 1024 * 1024)
        assert self.ws.subprotocol == PROTOCOL
        await self.event('gateway.ready')
        return self

    async def __aexit__(self, *args):
        await self.ws.close()
        with (self.stack.root / 'rpc-frames.jsonl').open('a') as file:
            for frame in self.frames:
                file.write(json.dumps(frame) + '\n')

    async def read(self):
        frame = json.loads(await self.ws.recv())
        self.frames.append(frame)
        return frame

    async def call(self, method, params=None):
        self.counter += 1
        rid = 'acceptance-' + str(self.counter)
        await self.ws.send(json.dumps({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params or {}}))
        async with asyncio.timeout(90):
            while True:
                frame = await self.read()
                if frame.get('id') == rid:
                    assert 'error' not in frame, frame
                    return frame['result']

    async def event(self, name, sid=None, since=0):
        def match(frame):
            event = frame.get('params', {}) if frame.get('method') == 'event' else {}
            return event.get('type') == name and (sid is None or event.get('session_id') == sid)
        async with asyncio.timeout(90):
            while True:
                for frame in self.frames[since:]:
                    if match(frame):
                        return frame['params']
                since = len(self.frames)
                await self.read()

    async def turn(self, sid, text, expected):
        start = len(self.frames)
        ack = await self.call('prompt.submit', {'session_id': sid, 'text': text})
        assert ack['status'] == 'streaming', ack
        event = await self.event('message.complete', sid, start)
        assert event['payload']['status'] == 'complete', event
        assert event['payload']['text'] == expected, event
        names = [frame.get('params', {}).get('type') for frame in self.frames[start:] if frame.get('method') == 'event']
        assert 'message.start' in names, names
        return names


async def transport_acceptance(stack):
    stack.seed_auth()
    ticket = stack.ticket()
    async with RPC(stack, ticket) as rpc:
        created_a = await rpc.call('session.create', {'title': 'Acceptance session A', 'cwd': str(stack.root)})
        sid_a, stored_a = created_a['session_id'], created_a['stored_session_id']
        names = await rpc.turn(sid_a, 'DIRECT_HERMES_TOOL_A: execute the real harmless terminal check.', fixture.FINAL_A)
        assert {'message.start', 'message.delta', 'tool.start', 'tool.complete', 'message.complete'} <= set(names), names
        assert stack.marker.read_text() == fixture.MARKER + '\n'
        tool = next(f['params']['payload'] for f in rpc.frames if f.get('params', {}).get('type') == 'tool.complete')
        assert tool['name'] == 'terminal' and tool['result']['exit_code'] == 0
        assert tool['result']['output'].strip() == fixture.MARKER
        history_a = await rpc.call('session.history', {'session_id': sid_a})
        assert fixture.FINAL_A in json.dumps(history_a)
        created_b = await rpc.call('session.create', {'title': 'Acceptance session B', 'cwd': str(stack.root)})
        sid_b, stored_b = created_b['session_id'], created_b['stored_session_id']
        await rpc.turn(sid_b, 'DIRECT_HERMES_SESSION_B', fixture.FINAL_B)
        history_b = await rpc.call('session.history', {'session_id': sid_b})
        assert fixture.FINAL_A not in json.dumps(history_b)
        saved = await rpc.call('session.list', {'limit': 200})
        assert {stored_a, stored_b} <= {s['id'] for s in saved['sessions']}, saved
        # Close live RPC sessions to force resume to hydrate genuine SQLite history.
        await rpc.call('session.close', {'session_id': sid_a})
        await rpc.call('session.close', {'session_id': sid_b})
    rejected = False
    try:
        async with websockets.connect(ticket['proxyUrl'], subprotocols=[PROTOCOL, 'thechat-ticket.' + ticket['ticket']], open_timeout=5):
            pass
    except Exception as error:
        rejected = getattr(getattr(error, 'response', None), 'status_code', None) == 401
    assert rejected, 'Consumed permission ticket was replayable'
    async with RPC(stack, stack.ticket()) as rpc:
        resumed = await rpc.call('session.resume', {'session_id': stored_a})
        assert fixture.FINAL_A in json.dumps(resumed), resumed
        sid_a = resumed['session_id']
        await rpc.turn(sid_a, 'DIRECT_HERMES_FOLLOWUP_A', fixture.FINAL_FOLLOWUP)
        switched = await rpc.call('session.resume', {'session_id': stored_b})
        assert fixture.FINAL_B in json.dumps(switched) and fixture.FINAL_A not in json.dumps(switched)
        switched_a = await rpc.call('session.resume', {'session_id': stored_a})
        assert fixture.FINAL_FOLLOWUP in json.dumps(switched_a)
        assert fixture.FINAL_B not in json.dumps(switched_a)
        stack.report['checks']['closeReconnectResumeFollowupSwitchIsolation'] = True
    stack.verify_storage(stored_a, stored_b)
    audit = json.loads((stack.root / 'fixture-audit.json').read_text())
    stages = [record['stage'] for record in audit]
    assert {'requested_real_terminal', 'verified_real_tool_result', 'isolated_b', 'resumed_a'} <= set(stages), audit
    stack.report['checks'].update({'singleUseTicketReplayRejected401': True, 'realTerminalToolExecuted': True,
        'inferenceFixtureSawRealToolResult': True, 'promptSubmitStreamingAck': True,
        'credentialAbsentFromApiResponses': True, 'gatewayReadyThroughRawProxy': True})
    stack.report['terminal'] = {'marker': stack.marker.read_text().strip(), 'exitCode': tool['result']['exit_code'], 'command': tool['args']['command']}
    stack.report['eventTypesObserved'] = sorted(set(names))
    stack.report['inferenceFixtureStages'] = stages
    stack.report['sessionIds'] = {'a': stored_a, 'b': stored_b}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hermes-source', default='/workspace/hermes-source')
    parser.add_argument('--scratch', default='/workspace/direct-hermes-e2e')
    parser.add_argument('--docker', default='sudo -n docker')
    parser.add_argument('--postgres-image', default='postgres:17-alpine')
    parser.add_argument('--redis-image', default='redis:7-alpine')
    parser.add_argument('--browser', action='store_true')
    parser.add_argument('--settings', action='store_true', help='Exercise real owner settings/access, revocation and browser Manage bots controls')
    parser.add_argument('--keep-running', action='store_true', help='After PASS hold this disposable preview open, then clean up')
    parser.add_argument('--keep-seconds', type=int, default=1800, help='Bounded preview lifetime (1..3600 seconds)')
    parser.add_argument('--timeout', type=int, default=540)
    args = parser.parse_args()
    if not 1 <= args.keep_seconds <= 3600:
        parser.error('--keep-seconds must be 1..3600')
    stack = Stack(args)
    def interrupt(signum, frame):
        raise TimeoutError(f'Acceptance interrupted by signal {signum}')
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGALRM, interrupt)
    signal.alarm(args.timeout)
    try:
        stack.start()
        asyncio.run(transport_acceptance(stack))
        if args.settings:
            settings_spec = importlib.util.spec_from_file_location('direct_settings', HERE / 'direct-hermes-settings.py')
            settings = importlib.util.module_from_spec(settings_spec)
            settings_spec.loader.exec_module(settings)
            asyncio.run(settings.verify(stack, RPC, PROTOCOL, fixture))
        if args.browser:
            browser_spec = importlib.util.spec_from_file_location('direct_browser', HERE / 'direct-hermes-browser.py')
            browser = importlib.util.module_from_spec(browser_spec)
            browser_spec.loader.exec_module(browser)
            browser.verify(stack)
            stack.verify_storage(stack.report['sessionIds']['a'], stack.report['sessionIds']['b'])
        stack.report['status'] = 'PASS'
        if args.keep_running:
            signal.alarm(0)
            access = {'inference': stack.report['inference'], 'api': stack.api,
                'browserUrl': stack.report['browser'].get('url'),
                'email': stack.run_id + '-owner@example.test',
                'password': 'Disposable-direct-hermes-123!', 'lifetimeSeconds': args.keep_seconds}
            (stack.root / 'preview-access.json').write_text(json.dumps(access, indent=2))
            (stack.root / 'preview-access.json').chmod(0o600)
            stack.report['preview'] = {'lifetimeSeconds': args.keep_seconds,
                'accessFile': str(stack.root / 'preview-access.json')}
            (stack.root / 'report.json').write_text(json.dumps(stack.report, indent=2))
            print('PREVIEW_READY ' + str(stack.root / 'report.json'), flush=True)
            print(json.dumps({'ports': stack.ports, 'inference': stack.report['inference']}), flush=True)
            # Keep this supervisor alive; SIGINT/SIGTERM still enter owned cleanup.
            until = time.monotonic() + args.keep_seconds
            while time.monotonic() < until:
                stack.wait('preview API', lambda: request(stack.api, 'GET', '/health')[0] == 200, seconds=10)
                time.sleep(min(2, max(0, until - time.monotonic())))
    except BaseException as error:
        stack.report['status'] = 'FAIL'
        stack.report['failure'] = str(error)
        raise
    finally:
        signal.alarm(0)
        stack.cleanup()
        (stack.root / 'report.json').write_text(json.dumps(stack.report, indent=2))
        print('REPORT ' + str(stack.root / 'report.json'), flush=True)
        print(json.dumps(stack.report, indent=2), flush=True)

if __name__ == '__main__':
    main()
