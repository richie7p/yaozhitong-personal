"""Mock subprocess tests. No network, models, deployment or cloud calls occur."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

TOOL = pathlib.Path(__file__).resolve().parents[1] / 'tools' / 'run-tfda-batches.py'
SPEC = importlib.util.spec_from_file_location('tfda_batch_runner_tested', TOOL)
runner = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(runner)
LICENSE = '衛部藥製字第999992號'


class MockChildren:
    def __init__(self, fetches=None, fail_once=None, invalid_phase=None, failure_diagnostic=None, failures=1):
        self.fetches = list(fetches or [(0, 0)])
        self.fail_once, self.invalid_phase = fail_once, invalid_phase
        self.failure_diagnostic, self.remaining_failures = failure_diagnostic, failures
        self.calls, self.apply_calls, self.prepare_count = [], [], 0

    def __call__(self, command, **options):
        assert isinstance(command, list) and 'shell' not in options
        self.calls.append(command)
        tool = next(pathlib.Path(value).name for value in command if value.endswith(('.py', '.ts')))
        phase = 'reextract' if '--reextract-cached' in command else 'fetch' if tool == 'fetch-tfda-sources.py' else 'prepare' if tool == 'prepare-tfda-sources.ts' else command[command.index('--mode') + 1]
        value = lambda flag: command[command.index(flag) + 1]
        if phase == 'apply':
            self.apply_calls.append(command)
            assert value('--manifest-sha256') == runner.digest(pathlib.Path(value('--manifest')))
            assert value('--snapshot-sha256') == runner.digest(pathlib.Path(value('--snapshot')))
        if phase == self.fail_once:
            self.remaining_failures -= 1
            if self.remaining_failures == 0:
                self.fail_once = None
            options['stderr'].write(json.dumps({'status': 'failed', 'diagnostic': self.failure_diagnostic}) + '\n' if self.failure_diagnostic else 'Synthetic controlled child failure\n')
            return subprocess.CompletedProcess(command, 1)
        if phase == self.invalid_phase:
            options['stdout'].write('not valid final JSON\n')
            return subprocess.CompletedProcess(command, 0)
        if phase in ('fetch', 'reextract'):
            pending, failed = self.fetches.pop(0) if phase == 'fetch' and self.fetches else (0, 0)
            report = {'schemaVersion': 3, 'interrupted': False, 'cachedObjectIntegrityFailures': 0,
                      'completedThisRun': 1, 'statusCounts': {'pending': pending, 'failed': failed}}
        elif phase == 'prepare':
            self.prepare_count += 1
            output = pathlib.Path(value('--output')); output.mkdir(parents=True, exist_ok=True)
            manifest = output / f'synthetic-batch-{self.prepare_count}.json'
            runner.atomic(manifest, {'schema': 'tfda-source-publication-batch/v1', 'batchId': 'synthetic',
                                     'project': runner.PROJECT, 'bucket': runner.BUCKET, 'items': [{'fullLicense': LICENSE}]})
            report = {'manifests': [str(manifest)], 'cloudWrites': 0, 'aiCalls': 0}
        elif phase == 'inspect':
            manifest, snapshot = pathlib.Path(value('--manifest')), pathlib.Path(value('--snapshot'))
            runner.atomic(snapshot, {'schema': 'tfda-source-publication-snapshot/v1', 'manifestSha256': runner.digest(manifest)})
            report = {'status': 'cloud_readonly_snapshot_created', 'manifestSha256': runner.digest(manifest), 'snapshotSha256': runner.digest(snapshot)}
        else:
            assert phase == 'apply'
            report = {'status': 'fixed_batch_apply_finished', 'results': [{'fullLicense': LICENSE, 'status': 'recovered_committed_publication'}]}
        options['stdout'].write('Synthetic progress output\n' + json.dumps(report) + '\n\n')
        return subprocess.CompletedProcess(command, 0)


class TfdaBatchRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-tfda-batches-')
        self.addCleanup(self.temp.cleanup)
        base = pathlib.Path(self.temp.name)
        self.inventory, self.corpus, self.output = base / 'inventory with spaces', base / 'corpus', base / 'run'
        self.inventory.mkdir(); self.corpus.mkdir()
        for name in ('active-candidates.ndjson', 'all-source-candidates.ndjson'):
            (self.inventory / name).write_text(json.dumps({'syntheticQueue': name}) + '\n', encoding='utf-8')
        for info_id in (36, 39):
            runner.atomic(self.inventory / f'info{info_id}.evidence.json', {'retrievedAt': dt.datetime.now(dt.UTC).isoformat()})
        self.protected = base / 'protected-original.json'
        runner.atomic(self.protected, {'leaflets': [{'licenseNo': '衛部藥製字第999991號', 'status': 'published'}]})
        self.original = self.protected.read_bytes()

    def args(self, *extra):
        return ['--inventory', str(self.inventory), '--corpus', str(self.corpus), '--output', str(self.output),
                '--protected', str(self.protected), '--python', 'synthetic-python-executable', *extra]

    def execute(self, child, *extra):
        with mock.patch.object(runner.subprocess, 'run', side_effect=child), contextlib.redirect_stdout(io.StringIO()):
            return runner.main(self.args(*extra))

    def state(self):
        return runner.read_json(self.output / 'progress.json')

    def test_default_is_local_only_and_original_protected_is_immutable(self):
        child = MockChildren()
        state = self.execute(child, '--max-batches', '1')
        self.assertEqual(len(child.calls), 2)
        self.assertFalse(any('publish-tfda-sources.ts' in ' '.join(command) for command in child.calls))
        self.assertTrue(child.calls[0][0].endswith('synthetic-python-executable'))
        self.assertEqual(child.calls[0][child.calls[0].index('--workers') + 1], '4')
        self.assertEqual(self.protected.read_bytes(), self.original)
        self.assertNotIn(LICENSE, state['protectedLicenses'])
        self.assertEqual(state['status'], 'selected_queue_exhausted')

    def test_publication_pins_manifest_and_unique_snapshot_and_updates_derived_list(self):
        child = MockChildren()
        state = self.execute(child, '--max-batches', '1', '--publish')
        self.assertEqual(len(child.apply_calls), 1)
        apply = child.apply_calls[0]
        self.assertIn(runner.PROJECT, apply); self.assertIn(runner.BUCKET, apply)
        self.assertIn('--manifest-sha256', apply); self.assertIn('--snapshot-sha256', apply)
        self.assertIn(LICENSE, state['protectedLicenses'])
        self.assertEqual(self.protected.read_bytes(), self.original)
        self.assertIn(LICENSE, {row['licenseNo'] for row in runner.read_json(self.output / 'published-sources.json')['leaflets']})

    def test_failed_apply_stops_and_resumes_same_snapshot_without_fetch_or_reinspect(self):
        first = MockChildren(fail_once='apply')
        with self.assertRaisesRegex(runner.BatchError, 'child_failed_apply'):
            self.execute(first, '--max-batches', '1', '--publish')
        operation = self.state()['pendingPublications'][0]
        self.assertEqual(operation['stage'], 'apply_pending')
        self.assertEqual(self.state()['status'], 'failed')
        second = MockChildren()
        state = self.execute(second, '--max-batches', '1', '--publish')
        self.assertEqual(second.calls, first.apply_calls)
        self.assertEqual(state['pendingPublications'], [])
        self.assertIn(LICENSE, state['protectedLicenses'])

    def test_failed_prepare_reuses_saved_fetch_checkpoint_before_new_acquisition(self):
        first = MockChildren(fail_once='prepare')
        with self.assertRaisesRegex(runner.BatchError, 'child_failed_prepare'):
            self.execute(first, '--max-batches', '1')
        self.assertIn('fetch', self.state()['currentBatch'])
        second = MockChildren()
        self.execute(second, '--max-batches', '1')
        self.assertEqual(len(second.calls), 1)
        self.assertTrue(any('prepare-tfda-sources.ts' in value for value in second.calls[0]))
        self.assertNotIn('error', self.state())
        self.assertEqual(self.state()['lastFailure']['error'], 'child_failed_prepare')

    def test_invalid_last_json_stops_before_prepare_and_records_logs(self):
        child = MockChildren(invalid_phase='fetch')
        with self.assertRaisesRegex(runner.BatchError, 'child_final_json_invalid_fetch'):
            self.execute(child, '--max-batches', '1')
        self.assertEqual(len(child.calls), 1)
        self.assertEqual(self.state()['lastPhase'], 'fetch')
        self.assertTrue(pathlib.Path(self.state()['lastLogs']['stdout']).exists())

    def test_explicit_all_exhausts_pending_without_retrying_failed_sources(self):
        child = MockChildren(fetches=[(1, 0), (0, 2)])
        state = self.execute(child, '--all', '--batch-size', '3')
        fetches = [command for command in child.calls if any(value.endswith('fetch-tfda-sources.py') for value in command)]
        self.assertEqual(len(fetches), 2)
        self.assertTrue(all(command[command.index('--limit') + 1] == '3' for command in fetches))
        self.assertFalse(any('--retry-failed' in command for command in child.calls))
        self.assertEqual(state['status'], 'selected_queue_exhausted_with_failures')
        self.assertEqual(state['fetchFailures'], {'failed': 2})

    def test_max_batches_limits_this_invocation_and_all_queue_never_changes_prepare_input(self):
        child = MockChildren(fetches=[(5, 0), (4, 0), (3, 0)])
        state = self.execute(child, '--max-batches', '2', '--queue', 'all')
        self.assertEqual(state['completedBatches'], 2)
        self.assertEqual(state['status'], 'batch_limit_reached')
        self.assertEqual(len(child.calls), 4)
        self.assertTrue(child.calls[0][child.calls[0].index('--inventory') + 1].endswith('all-source-candidates.ndjson'))
        self.assertEqual(child.calls[1][child.calls[1].index('--inventory') + 1], str(self.inventory))
        with self.assertRaisesRegex(runner.BatchError, 'runner_inputs_changed'):
            self.execute(MockChildren(), '--max-batches', '1', '--queue', 'active')

    def test_stale_indexes_stop_before_any_child(self):
        runner.atomic(self.inventory / 'info36.evidence.json', {'retrievedAt': (dt.datetime.now(dt.UTC) - dt.timedelta(hours=25)).isoformat()})
        child = MockChildren()
        with self.assertRaisesRegex(runner.BatchError, 'official_index_stale_stop'):
            self.execute(child, '--max-batches', '1')
        self.assertEqual(child.calls, [])
        self.assertEqual(self.state()['status'], 'failed')

    def test_inspect_retries_only_confirmed_transient_code_with_a_new_snapshot(self):
        child = MockChildren(fail_once='inspect', failure_diagnostic={'code': 'UNAVAILABLE', 'validation': False})
        state = self.execute(child, '--max-batches', '1', '--publish')
        inspections = [command for command in child.calls if '--mode' in command and command[command.index('--mode') + 1] == 'inspect']
        self.assertEqual(len(inspections), 2)
        self.assertNotEqual(inspections[0][inspections[0].index('--snapshot') + 1], inspections[1][inspections[1].index('--snapshot') + 1])
        self.assertEqual(len(child.apply_calls), 1)
        self.assertIn(LICENSE, state['protectedLicenses'])

    def test_confirmed_transient_inspect_is_bounded_to_two_attempts(self):
        child = MockChildren(fail_once='inspect', failures=3, failure_diagnostic={'code': 'DEADLINE_EXCEEDED', 'validation': False})
        with self.assertRaisesRegex(runner.BatchError, 'child_failed_inspect'):
            self.execute(child, '--max-batches', '1', '--publish')
        inspections = [command for command in child.calls if '--mode' in command]
        self.assertEqual(len(inspections), 2)
        self.assertEqual(child.apply_calls, [])
        self.assertEqual(self.state()['pendingPublications'][0]['inspectAttempt'], 2)

    def test_generic_or_validation_inspect_failure_is_never_retried(self):
        for number, diagnostic in enumerate((None, {'code': 'UNAVAILABLE', 'validation': True})):
            with self.subTest(diagnostic=diagnostic):
                self.output = pathlib.Path(self.temp.name) / f'no-retry-{number}'
                child = MockChildren(fail_once='inspect', failure_diagnostic=diagnostic)
                with self.assertRaisesRegex(runner.BatchError, 'child_failed_inspect'):
                    self.execute(child, '--max-batches', '1', '--publish')
                self.assertEqual(len([command for command in child.calls if '--mode' in command]), 1)
                self.assertEqual(child.apply_calls, [])

    def test_active_extract_policy_forwards_to_both_fetch_modes_without_changing_legacy_runner_binding(self):
        self.execute(MockChildren(), '--max-batches', '1')
        original_binding = self.state()['binding']
        child = MockChildren()
        policy = self.inventory / 'active-candidates.ndjson'
        self.execute(child, '--max-batches', '1', '--extract-active-from', str(policy), '--reextract-existing')
        fetches = [command for command in child.calls if any(value.endswith('fetch-tfda-sources.py') for value in command)]
        self.assertEqual(len(fetches), 2)
        for command in fetches:
            self.assertEqual(command[command.index('--extract-active-from') + 1], str(policy))
        self.assertEqual(self.state()['binding'], original_binding)

    def test_reextract_flag_is_checkpointed_and_never_enables_failed_network_retries(self):
        first = MockChildren()
        self.execute(first, '--max-batches', '1', '--reextract-existing')
        self.assertIn('--reextract-cached', first.calls[0]); self.assertIn('--all', first.calls[0])
        second = MockChildren()
        self.execute(second, '--max-batches', '1', '--reextract-existing')
        self.assertFalse(any('--reextract-cached' in command for command in second.calls))

    def test_local_workers_are_bounded_and_forwarded_to_fetch_and_reextract(self):
        child = MockChildren()
        self.execute(child, '--max-batches', '1', '--reextract-existing', '--fetch-workers', '2')
        fetches = [command for command in child.calls if any(value.endswith('fetch-tfda-sources.py') for value in command)]
        self.assertEqual(len(fetches), 2)
        self.assertTrue(all(command[command.index('--workers') + 1] == '2' for command in fetches))
        for invalid in ('0', '5'):
            with self.assertRaisesRegex(runner.BatchError, 'invalid_fetch_workers'):
                runner.arguments(self.args('--max-batches', '1', '--fetch-workers', invalid))

    def test_all_or_max_batches_is_required_and_limits_are_validated(self):
        with contextlib.redirect_stderr(io.StringIO()):
            for extra in ([], ['--all', '--max-batches', '1']):
                with self.assertRaises(SystemExit):
                    runner.arguments(self.args(*extra))
        with self.assertRaisesRegex(runner.BatchError, 'invalid_batch_size'):
            runner.arguments(self.args('--max-batches', '1', '--batch-size', '501'))


if __name__ == '__main__':
    unittest.main()
