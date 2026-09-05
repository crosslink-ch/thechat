#!/usr/bin/env python3
"""Real Hermes dashboard/RPC bootstrap, isolated test home, loopback inference only.

No agent, RPC, persistence, event or terminal implementation is mocked.
Does not invoke Hermes CLI gateway/service-management commands.
"""
import ipaddress
import json
import os
from pathlib import Path
import socket
import sys

source = Path(os.environ['DIRECT_HERMES_SOURCE']).resolve()
home = Path(os.environ['HERMES_HOME']).resolve()
assert home.is_dir() and home != Path.home() / '.hermes'
assert os.environ['OPENAI_API_KEY'] == 'direct-hermes-local-inference-fixture-only'
assert not Path(os.environ['HERMES_MANAGED_DIR']).exists()
# Do not silently import checkout/ancestor credentials through dotenv discovery.
for directory in (source, *source.parents):
    for filename in ('.env', '.env.local'):
        if (directory / filename).exists():
            raise RuntimeError(f'Refusing source environment file: {directory / filename}')
sys.path.insert(0, str(source))
os.chdir(home)
# Safety-only network guard: any accidental auxiliary-provider selection fails
# locally instead of reaching a paid provider. The fixture is the only inference.
original_connect = socket.socket.connect
original_connect_ex = socket.socket.connect_ex
def check_address(address):
    if isinstance(address, tuple):
        host = address[0]
        if host != 'localhost':
            assert ipaddress.ip_address(host).is_loopback, f'Non-loopback connection refused: {host}'
def connect(sock, address):
    check_address(address)
    return original_connect(sock, address)
def connect_ex(sock, address):
    check_address(address)
    return original_connect_ex(sock, address)
socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
from hermes_cli.runtime_provider import resolve_runtime_provider
runtime = resolve_runtime_provider(requested='custom')
assert runtime['base_url'].rstrip('/') == os.environ['CUSTOM_BASE_URL'].rstrip('/'), runtime.get('base_url')
Path(os.environ['DIRECT_HERMES_PROVIDER_EVIDENCE']).write_text(json.dumps({
    'provider': runtime['provider'], 'baseUrl': runtime['base_url'],
    'inference': 'deterministic loopback fixture; no paid LLM',
    'hermesHome': str(home), 'externalPythonSocketConnections': 'blocked'}))
import uvicorn
uvicorn.run('hermes_cli.web_server:app', host='127.0.0.1', port=int(os.environ['DIRECT_HERMES_RPC_PORT']),
    log_level='warning', access_log=False)
