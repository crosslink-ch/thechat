#!/usr/bin/env python3
"""Negative controls for composer receipt assertions, not real E2E evidence."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


def load(name):
    path = Path(__file__).with_name(name + '.py')
    assert path.exists(), 'Composer receipt helper is not implemented'
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ComposerFixtureTest(unittest.TestCase):
    def test_branch_requires_copied_history_and_file_only_is_not_auxiliary(self):
        helper = load('direct-hermes-composer-fixture')
        self.assertTrue(hasattr(helper, 'BRANCH_MARKER'), 'Branch receipt check not implemented')
        messages = [{'role': 'user', 'content': helper.BRANCH_MARKER}]
        with self.assertRaisesRegex(AssertionError, 'branch parent history'):
            helper.complete(messages, Path('/unused'))
        messages = [{'role': 'user', 'content': helper.SEED_MARKER}, {'role': 'assistant', 'content': helper.FINAL_SEED}] + messages
        self.assertEqual(helper.complete(messages, Path('/unused'))[0]['content'], helper.FINAL_BRANCH)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / 'hermes-home/attachments' / helper.ONLY_NAME
            file.parent.mkdir(parents=True)
            file.write_bytes(helper.ONLY_BYTES)
            messages = [{'role': 'user', 'content': helper.TEXT_MARKER}, {'role': 'tool', 'tool_call_id': helper.FILE_CALL_ID, 'content': '{"output":"stale", "exit_code":0}'}, {'role': 'user', 'content': 'Please review the attached files.\n@file:' + str(file)}]
            self.assertEqual(helper.complete(messages, root)[1], 'tool_calls', 'Prior turn receipts must not satisfy a fresh upload')
            content = 'Please review the attached files.\n@file:' + str(file) + '\n' + helper.ONLY_BYTES.decode()
            message, finish, evidence = helper.complete([{'role': 'user', 'content': content}], root)
            self.assertEqual(message['content'], helper.FINAL_ONLY)
            self.assertEqual(evidence['stage'], 'attachment_only')
            self.assertEqual(evidence['receipt'], 'automatic_file_context_expansion')

    def test_dispatch_preserves_old_stages_and_counts_every_agent_inference(self):
        helper = load('direct-hermes-composer-fixture')
        fixture = load('direct-hermes-inference-fixture')
        with tempfile.TemporaryDirectory() as tmp:
            state = fixture.Fixture(Path(tmp) / 'marker')
            payload = {'tools': [{'function': {'name': 'terminal'}}], 'messages': [{'role': 'user', 'content': helper.IMAGE_MARKER}]}
            with self.assertRaisesRegex(AssertionError, 'image_url'):
                state.complete(payload)
            payload['messages'][0]['content'] = '/unknown-command-should-not-hit-model'
            state.complete(payload)
            self.assertTrue(state.records[-1]['agentInference'])
            state.complete({'messages': [{'role': 'user', 'content': helper.IMAGE_MARKER}]})
            self.assertFalse(state.records[-1]['agentInference'])
            payload['messages'][0]['content'] = 'DIRECT_HERMES_SESSION_B'
            self.assertEqual(state.complete(payload)['choices'][0]['message']['content'], fixture.FINAL_B)
            self.assertEqual(state.records[-1]['stage'], 'isolated_b')

    def test_image_requires_actual_multimodal_bytes_not_marker_or_url(self):
        import base64
        helper = load('direct-hermes-composer-fixture')
        self.assertTrue(hasattr(helper, 'IMAGE_BYTES'), 'Image receipt check not implemented')
        payload = [{'role': 'user', 'content': [{'type': 'text', 'text': helper.IMAGE_MARKER}]}]
        with self.assertRaisesRegex(AssertionError, 'image_url'):
            helper.complete(payload, Path('/unused'))
        image = {'type': 'image_url', 'image_url': {'url': 'https://example.test/not-a-real-receipt.png'}}
        payload[0]['content'].append(image)
        with self.assertRaisesRegex(AssertionError, 'data URL'):
            helper.complete(payload, Path('/unused'))
        image['image_url']['url'] = 'data:image/png;base64,' + base64.b64encode(b'wrong').decode()
        with self.assertRaisesRegex(AssertionError, 'image bytes'):
            helper.complete(payload, Path('/unused'))
        image['image_url']['url'] = 'data:image/png;base64,' + base64.b64encode(helper.IMAGE_BYTES).decode()
        message, finish, evidence = helper.complete(payload, Path('/unused'))
        self.assertEqual(message['content'], helper.FINAL_IMAGE)
        self.assertEqual(evidence['sha256'], helper.sha256(helper.IMAGE_BYTES))
        self.assertEqual(evidence['receipt'], 'provider_multimodal_image_url_bytes')

    def test_file_receipt_requires_real_scoped_bytes_and_tool_result(self):
        helper = load('direct-hermes-composer-fixture')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            attachment = root / 'hermes-home/attachments' / helper.TEXT_NAME
            attachment.parent.mkdir(parents=True)
            attachment.write_bytes(helper.TEXT_BYTES)
            messages = [{'role': 'user', 'content': helper.TEXT_MARKER + '\n@file:`' + str(attachment) + '`'}]
            message, finish, evidence = helper.complete(messages, root)
            self.assertEqual(finish, 'tool_calls')
            call = message['tool_calls'][0]
            self.assertEqual(call['function']['name'], 'terminal')
            self.assertIn(str(attachment), json.loads(call['function']['arguments'])['command'])
            messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': json.dumps({'output': 'invented', 'exit_code': 0})})
            with self.assertRaisesRegex(AssertionError, 'receipt'):
                helper.complete(messages, root)
            messages[-1]['content'] = json.dumps({'output': json.dumps({'sha256': helper.sha256(helper.TEXT_BYTES), 'text': helper.TEXT_BYTES.decode()}), 'exit_code': 0})
            answer, finish, evidence = helper.complete(messages, root)
            self.assertEqual(answer['content'], helper.FINAL_TEXT)
            self.assertEqual(evidence['receipt'], 'real_terminal_result')
            messages[-1]['content'] = json.dumps({'output': json.dumps({'sha256': helper.sha256(helper.TEXT_BYTES), 'text': helper.TEXT_BYTES.decode()}), 'exit_code': 1})
            with self.assertRaisesRegex(AssertionError, 'exit code'):
                helper.complete(messages, root)
            messages.pop()
            messages[0]['content'] = helper.TEXT_MARKER + '\n@file:/etc/passwd'
            with self.assertRaisesRegex(AssertionError, 'scoped attachment'):
                helper.complete(messages, root)
            messages[0]['content'] = helper.TEXT_MARKER
            with self.assertRaisesRegex(AssertionError, '@file'):
                helper.complete(messages, root)


class ComposerStorageTest(unittest.TestCase):
    def test_branch_copy_rejects_reused_id_wrong_parent_and_missing_history(self):
        import sqlite3
        checks = load('direct-hermes-browser-composer')
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / 'state.db'
            with sqlite3.connect(db) as connection:
                connection.executescript("CREATE TABLE sessions(id TEXT, parent_session_id TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT); INSERT INTO sessions VALUES('parent',NULL),('branch','parent'); INSERT INTO messages(session_id,role,content) VALUES('parent','user','seed'),('parent','assistant','answer'),('branch','user','seed'),('branch','assistant','answer');")
            rows = checks.history(db, 'parent')
            checks.assert_branch_storage(db, 'parent', 'branch', rows)
            with self.assertRaisesRegex(AssertionError, 'different stored'):
                checks.assert_branch_storage(db, 'parent', 'parent', rows)
            with sqlite3.connect(db) as connection:
                connection.execute("UPDATE sessions SET parent_session_id='other' WHERE id='branch'")
            with self.assertRaisesRegex(AssertionError, 'parent ID'):
                checks.assert_branch_storage(db, 'parent', 'branch', rows)
            with sqlite3.connect(db) as connection:
                connection.execute("UPDATE sessions SET parent_session_id='parent' WHERE id='branch'")
                connection.execute("DELETE FROM messages WHERE session_id='branch' AND role='assistant'")
            with self.assertRaisesRegex(AssertionError, 'copied visible history'):
                checks.assert_branch_storage(db, 'parent', 'branch', rows)
            with sqlite3.connect(db) as connection:
                connection.execute("INSERT INTO messages(session_id,role,content) VALUES('parent','user','leak')")
            with self.assertRaisesRegex(AssertionError, 'parent history changed'):
                checks.assert_branch_storage(db, 'parent', 'branch', rows)


if __name__ == '__main__':
    unittest.main()
