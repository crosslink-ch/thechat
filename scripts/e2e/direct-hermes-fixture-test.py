#!/usr/bin/env python3
"""Negative controls for the deterministic inference fixture (not an LLM)."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

class FixtureTest(unittest.TestCase):
    def test_real_result_and_marker_required(self):
        path = Path(__file__).with_name('direct-hermes-inference-fixture.py')
        self.assertTrue(path.exists(), 'Inference fixture is not implemented')
        spec = importlib.util.spec_from_file_location('fixture', path)
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / 'terminal-marker'
            state = fixture.Fixture(marker)
            payload = {'tools': [{'function': {'name': 'terminal'}}], 'messages': [
                {'role': 'user', 'content': 'DIRECT_HERMES_TOOL_A'}]}
            response = state.complete(payload)
            self.assertEqual(response['choices'][0]['finish_reason'], 'tool_calls')
            payload['messages'].append({'role': 'tool', 'tool_call_id': fixture.CALL_ID,
                'content': '{"output":"DIRECT_HERMES_REAL_TERMINAL_OK\\n","exit_code":0}'})
            with self.assertRaisesRegex(AssertionError, 'marker'):
                state.complete(payload)
            marker.write_text(fixture.MARKER + '\n')
            payload['messages'][-1]['content'] = '{"output":"wrong","exit_code":0}'
            with self.assertRaisesRegex(AssertionError, 'tool output'):
                state.complete(payload)
            payload['messages'][-1]['content'] = '{"output":"DIRECT_HERMES_REAL_TERMINAL_OK\\n","exit_code":0}'
            self.assertEqual(state.complete(payload)['choices'][0]['message']['content'], fixture.FINAL_A)
            payload['messages'][-1]['content'] = '{"output":"DIRECT_HERMES_REAL_TERMINAL_OK","exit_code":1}'
            with self.assertRaisesRegex(AssertionError, 'exit code'):
                state.complete(payload)
            followup = {'tools': payload['tools'], 'messages': [
                {'role': 'user', 'content': 'DIRECT_HERMES_TOOL_A'},
                {'role': 'assistant', 'content': fixture.FINAL_A},
                {'role': 'user', 'content': 'DIRECT_HERMES_FOLLOWUP_A'}]}
            with self.assertRaisesRegex(AssertionError, 'saved terminal result missing'):
                state.complete(followup)
            contaminated_b = {'tools': payload['tools'], 'messages': [
                {'role': 'user', 'content': 'DIRECT_HERMES_TOOL_A'},
                {'role': 'user', 'content': 'DIRECT_HERMES_SESSION_B'}]}
            with self.assertRaisesRegex(AssertionError, 'session A leaked into B'):
                state.complete(contaminated_b)

if __name__ == '__main__':
    unittest.main()
