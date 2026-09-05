#!/usr/bin/env python3
"""Deterministic composer inference cases. Never fabricates file/tool receipts."""
import base64
import hashlib
import json
from pathlib import Path
import re
import shlex
import struct
import zlib

TEXT_NAME = 'direct-hermes fixture.txt'
TEXT_BYTES = b'Disposable Direct Hermes upload. Receipt token: cobalt-sparrow-427.\n'
TEXT_MARKER = 'DIRECT_HERMES_ATTACHMENT_TEXT'
FINAL_TEXT = 'Inference fixture verified the actual uploaded text file contents.'
ONLY_NAME = 'direct-hermes-attachment-only.txt'
ONLY_BYTES = b'Attachment-only receipt token: copper-lantern-913.\n'
FINAL_ONLY = 'Inference fixture verified the attachment-only file contents.'
SEED_MARKER = 'DIRECT_HERMES_BRANCH_SEED'
BRANCH_MARKER = 'DIRECT_HERMES_BRANCH_FOLLOWUP'
FINAL_SEED = 'Inference fixture created the branch parent history.'
FINAL_BRANCH = 'Inference fixture followed up on the branch with copied parent history.'
FILE_CALL_ID = 'call_direct_hermes_attachment_read'
IMAGE_NAME = 'direct-hermes-pixels.png'
IMAGE_MARKER = 'DIRECT_HERMES_ATTACHMENT_IMAGE'
FINAL_IMAGE = 'Inference fixture received the actual PNG bytes as multimodal image input; not paid vision.'


def png_chunk(kind, content):
    return struct.pack('!I', len(content)) + kind + content + struct.pack('!I', zlib.crc32(kind + content))


# Valid 2x2 RGB PNG, constructed without external assets or image services.
IMAGE_BYTES = (b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('!IIBBBBB', 2, 2, 8, 2, 0, 0, 0))
    + png_chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00\x00\xff\x00\x00\x00\x00\xff\xff\xff\xff')) + png_chunk(b'IEND', b''))


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def complete(messages, root):
    users = [m.get('content', '') for m in messages if m.get('role') == 'user']
    latest = str(users[-1]) if users else ''
    if BRANCH_MARKER in latest:
        assert any(SEED_MARKER in str(u) for u in users) and any(m.get('content') == FINAL_SEED for m in messages), 'branch parent history missing'
        return {'role': 'assistant', 'content': FINAL_BRANCH}, 'stop', {'stage': 'branch_followup', 'copiedParentHistory': True}
    if SEED_MARKER in latest:
        return {'role': 'assistant', 'content': FINAL_SEED}, 'stop', {'stage': 'branch_seed'}
    if IMAGE_MARKER in latest:
        parts = users[-1] if isinstance(users[-1], list) else []
        images = [p for p in parts if isinstance(p, dict) and p.get('type') == 'image_url']
        assert len(images) == 1, 'actual multimodal image_url missing or duplicated'
        url = images[0].get('image_url', {}).get('url', '')
        assert url.startswith('data:image/png;base64,'), 'image receipt is not a PNG data URL'
        raw = base64.b64decode(url.split(',', 1)[1], validate=True)
        assert raw == IMAGE_BYTES, 'provider image bytes differ from selected fixture PNG'
        return {'role': 'assistant', 'content': FINAL_IMAGE}, 'stop', {
            'stage': 'attachment_image', 'receipt': 'provider_multimodal_image_url_bytes',
            'sha256': sha256(raw), 'bytes': len(raw), 'imageCount': len(images), 'mime': 'image/png'}
    only = ONLY_NAME in latest
    if TEXT_MARKER not in latest and not only:
        return None
    expected = ONLY_BYTES if only else TEXT_BYTES
    final = FINAL_ONLY if only else FINAL_TEXT
    refs = re.findall(r'@file:(?:`([^`]+)`|"([^"]+)"|\'([^\']+)\'|([^\s]+))', latest)
    assert refs, 'uploaded @file reference missing'
    path = Path(next(value for value in refs[-1] if value))
    if not path.is_absolute():
        path = root / path
    path = path.resolve()
    scope = (root / 'hermes-home/attachments').resolve()
    assert path.is_relative_to(scope) and path.is_file(), 'not a real scoped attachment'
    raw = path.read_bytes()
    assert raw == expected, 'uploaded file bytes differ'
    evidence = {'stage': 'attachment_only' if only else 'attachment_text', 'sha256': sha256(raw), 'bytes': len(raw), 'path': str(path)}
    current_turn = messages[max(i for i, m in enumerate(messages) if m.get('role') == 'user') + 1:]
    results = [m for m in current_turn if m.get('role') == 'tool' and m.get('tool_call_id') == FILE_CALL_ID]
    if expected.decode().strip() in latest:
        evidence['receipt'] = 'automatic_file_context_expansion'
        return {'role': 'assistant', 'content': final}, 'stop', evidence
    if results:
        result = json.loads(results[-1]['content'])
        assert result.get('exit_code') == 0 and not result.get('error'), 'attachment terminal exit code is not zero'
        try:
            receipt = json.loads(result.get('output', ''))
        except (ValueError, TypeError):
            raise AssertionError('attachment receipt is not JSON')
        assert receipt == {'sha256': sha256(raw), 'text': raw.decode()}, 'attachment receipt differs from real bytes'
        evidence['receipt'] = 'real_terminal_result'
        return {'role': 'assistant', 'content': final}, 'stop', evidence
    # The fixture requests a REAL harmless terminal read via Hermes; it never
    # substitutes the read result. Only allow the server's isolated upload dir.
    code = 'from pathlib import Path; import hashlib,json; b=Path(' + repr(str(path)) + ').read_bytes(); print(json.dumps({"sha256":hashlib.sha256(b).hexdigest(),"text":b.decode()}))'
    command = 'python3 -c ' + shlex.quote(code)
    evidence['stage'] = 'requested_attachment_read'
    return {'role': 'assistant', 'content': 'Reading the actual uploaded fixture file.', 'tool_calls': [
        {'id': FILE_CALL_ID, 'type': 'function', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': command, 'timeout': 10})}}
    ]}, 'tool_calls', evidence
