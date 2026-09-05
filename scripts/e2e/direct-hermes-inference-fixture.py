#!/usr/bin/env python3
"""Loopback deterministic OpenAI inference fixture. No real/paid model is used.

Only inference is replaced: Hermes must execute terminal and send its real result.
The fixture never writes the terminal marker; only Hermes' tool may create it.
"""
from __future__ import annotations
import argparse
import json
import re
import shlex
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL = 'direct-hermes-inference-fixture'
MARKER = 'DIRECT_HERMES_REAL_TERMINAL_OK'
CALL_ID = 'call_direct_hermes_terminal'
FINAL_A = 'Inference fixture verified the real Hermes terminal result for session A.'
FINAL_B = 'Inference fixture session B is isolated.'
FINAL_FOLLOWUP = 'Inference fixture resumed session A with its saved terminal history.'
FINAL_UI = 'Inference fixture browser followup completed with saved history.'

class Fixture:
    def __init__(self, marker: Path):
        self.marker = marker
        self.lock = threading.Lock()
        self.records = []

    def complete(self, payload):
        messages = payload.get('messages', [])
        users = [m.get('content', '') for m in messages if m.get('role') == 'user']
        latest = str(users[-1]) if users else ''
        tool_offered = any(t.get('function', {}).get('name') == 'terminal' for t in payload.get('tools', []))
        results = [m for m in messages if m.get('role') == 'tool' and m.get('tool_call_id') == CALL_ID]
        message = {'role': 'assistant', 'content': 'Direct Hermes inference fixture title'}
        finish = 'stop'
        stage = 'auxiliary'
        if tool_offered and 'DIRECT_HERMES_TOOL_A' in latest:
            if results:
                assert self.marker.exists(), 'terminal marker is missing'
                assert self.marker.read_text() == MARKER + '\n', 'terminal marker is incorrect'
                result = json.loads(results[-1]['content'])
                assert result.get('exit_code') == 0, 'real terminal exit code is not zero'
                assert result.get('output', '').strip() == MARKER, 'real tool output is incorrect'
                assert not result.get('error'), 'real terminal result has an error'
                message['content'] = FINAL_A
                stage = 'verified_real_tool_result'
            else:
                # The command is deliberately harmless, local and bounded.
                delay = 'sleep 3; ' if 'browser-created session' in latest else ''
                command = delay + f"printf '%s\\n' {shlex.quote(MARKER)} | tee {shlex.quote(str(self.marker))}"
                message = {'role': 'assistant', 'content': 'Running the real harmless terminal check.',
                    'tool_calls': [{'id': CALL_ID, 'type': 'function', 'function': {
                        'name': 'terminal', 'arguments': json.dumps({'command': command, 'timeout': 10})}}]}
                finish = 'tool_calls'
                stage = 'requested_real_terminal'
        elif tool_offered and 'DIRECT_HERMES_SESSION_B' in latest:
            assert not any('DIRECT_HERMES_TOOL_A' in str(u) for u in users), 'session A leaked into B'
            assert not results, 'session A tool results leaked into B'
            message['content'] = FINAL_B
            stage = 'isolated_b'
        elif tool_offered and ('DIRECT_HERMES_FOLLOWUP_A' in latest or 'DIRECT_HERMES_UI_FOLLOWUP' in latest):
            assert any('DIRECT_HERMES_TOOL_A' in str(u) for u in users), 'saved session A prompt missing'
            assert any(m.get('content') == FINAL_A for m in messages), 'saved assistant message missing'
            assert results, 'saved terminal result missing'
            assert not any('DIRECT_HERMES_SESSION_B' in str(u) for u in users), 'session B leaked into A'
            message['content'] = FINAL_UI if 'DIRECT_HERMES_UI_FOLLOWUP' in latest else FINAL_FOLLOWUP
            stage = 'browser_followup' if 'DIRECT_HERMES_UI_FOLLOWUP' in latest else 'resumed_a'
        with self.lock:
            self.records.append({'stage': stage, 'stream': bool(payload.get('stream')), 'model': payload.get('model'),
                'toolResultPresent': bool(results), 'messageRoles': [m.get('role') for m in messages],
                'userMarkers': [re.findall(r'DIRECT_HERMES_[A-Z_]+', str(u)) for u in users]})
        return {'id': 'chatcmpl-direct-hermes-fixture', 'object': 'chat.completion', 'created': int(time.time()),
            'model': MODEL, 'choices': [{'index': 0, 'message': message, 'finish_reason': finish}],
            'usage': {'prompt_tokens': 20, 'completion_tokens': 10, 'total_tokens': 30}}


def serve(port: int, marker: Path, audit: Path):
    fixture = Fixture(marker)
    class Handler(BaseHTTPRequestHandler):
        def reply(self, code, data):
            raw = json.dumps(data).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
        def do_GET(self):
            if self.path in ('/health', '/state'):
                return self.reply(200, {'inference': 'deterministic loopback fixture, not a paid LLM', 'records': fixture.records})
            if self.path.startswith('/v1/models'):
                return self.reply(200, {'object': 'list', 'data': [{'id': MODEL, 'object': 'model', 'owned_by': 'fixture'}]})
            self.reply(404, {'error': 'unsupported inference fixture route'})
        def do_POST(self):
            if self.path.rstrip('/') != '/v1/chat/completions':
                return self.reply(404, {'error': 'unsupported inference fixture route'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                assert 0 < size <= 8 * 1024 * 1024
                payload = json.loads(self.rfile.read(size))
                completion = fixture.complete(payload)
                audit.write_text(json.dumps(fixture.records, indent=2))
                if not payload.get('stream'):
                    return self.reply(200, completion)
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Connection', 'close')
                self.end_headers()
                choice = completion['choices'][0]
                message = dict(choice['message'])
                for i, tool in enumerate(message.get('tool_calls', [])):
                    tool['index'] = i
                base = {k: completion[k] for k in ('id', 'created', 'model')}
                base['object'] = 'chat.completion.chunk'
                chunks = [{**base, 'choices': [{'index': 0, 'delta': message, 'finish_reason': None}]},
                    {**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': choice['finish_reason']}]}]
                if payload.get('stream_options', {}).get('include_usage'):
                    chunks.append({**base, 'choices': [], 'usage': completion['usage']})
                for chunk in chunks:
                    self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                    self.wfile.flush()
                    time.sleep(0.02)
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()
            except Exception as exc:
                audit.with_suffix('.error').write_text(repr(exc))
                self.reply(500, {'error': {'message': 'Inference fixture assertion failed: ' + str(exc)}})
        def log_message(self, fmt, *args):
            pass
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', required=True, type=int)
    parser.add_argument('--marker', required=True, type=Path)
    parser.add_argument('--audit', required=True, type=Path)
    args = parser.parse_args()
    serve(args.port, args.marker, args.audit)
