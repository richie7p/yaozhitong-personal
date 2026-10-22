"""One-shot resumable TFDA acquisition/preparation; cloud publication requires --publish.

No scheduling, AI, deployment, account, seat or quota changes. Archive acquisition
with --queue all still prepares only current active licenses for publication.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import subprocess
import sys
from contextlib import contextmanager
from uuid import uuid4

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
PROJECT = 'project-b6fe4904-e687-4365-b2f'
BUCKET = PROJECT + '-yzt-test-data'
SUCCESS = {'published_technical_source', 'same_source_no_op', 'recovered_committed_publication', 'skip_protected_publication'}
READ_ONLY_TRANSIENT = {'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'ECONNRESET'}
SAFE_FAILURE_CODES = READ_ONLY_TRANSIENT | {'UNKNOWN', 'VALIDATION_FAILED', 'RESOURCE_EXHAUSTED', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'INVALID_ARGUMENT', 'NOT_FOUND', 'ALREADY_EXISTS', 'FAILED_PRECONDITION', 'ABORTED', 'CANCELLED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'DATA_LOSS', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC'} | {f'HTTP_{code}' for code in (400, 401, 403, 404, 408, 409, 412, 429, 500, 502, 503, 504)}


class BatchError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise BatchError(code)


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def atomic(path, value):
    temporary = path.with_name(path.name + '.tmp-' + uuid4().hex)
    try:
        with temporary.open('x', encoding='utf-8', newline='\n') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def output_lock(path):
    with path.open('a+b') as stream:
        if stream.tell() == 0:
            stream.write(b'0'); stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise BatchError('runner_output_already_locked') from error
        yield  # OS releases the lock even if the process crashes.


class Runner:
    def __init__(self, args):
        self.args = args
        self.output = args.output.resolve(); self.output.mkdir(parents=True, exist_ok=True)
        self.logs = self.output / 'logs'; self.logs.mkdir(exist_ok=True)
        self.progress = self.output / 'progress.json'
        self.protected = self.output / 'published-sources.json'
        self.queue = args.inventory.resolve() / ('active-candidates.ndjson' if args.queue == 'active' else 'all-source-candidates.ndjson')
        require(self.queue.is_file(), 'selected_inventory_queue_missing')
        require(not args.protected.resolve().is_relative_to(self.output), 'original_protected_must_be_outside_runner_output')
        binding = {'inventory': str(args.inventory.resolve()), 'queue': args.queue, 'queueSha256': digest(self.queue),
                   'corpus': str(args.corpus.resolve()), 'protected': str(args.protected.resolve()),
                   'protectedSha256': digest(args.protected.resolve()), 'project': PROJECT, 'bucket': BUCKET}
        if self.progress.exists():
            self.state = read_json(self.progress)
            require(self.state.get('schema') == 'tfda-batch-run/v1' and self.state.get('binding') == binding,
                    'runner_inputs_changed_use_new_output_and_corpus_for_different_queue')
        else:
            require(not self.protected.exists(), 'derived_protected_exists_without_progress')
            original = read_json(args.protected.resolve())
            require(isinstance(original, dict) and isinstance(original.get('leaflets'), list), 'protected_leaflets_list_required')
            licenses = sorted({item['licenseNo'] for item in original['leaflets'] if item.get('status') == 'published' and isinstance(item.get('licenseNo'), str)})
            self.state = {'schema': 'tfda-batch-run/v1', 'binding': binding, 'completedBatches': 0, 'currentBatch': None,
                          'preparedManifests': [], 'pendingPublications': [], 'completedManifests': {}, 'protectedLicenses': licenses}
        self.save()

    def save(self):
        self.state['updatedAt'] = dt.datetime.now(dt.UTC).isoformat()
        atomic(self.progress, self.state)
        # Progress is authoritative, making a crash between these two writes recoverable.
        atomic(self.protected, {'leaflets': [{'licenseNo': license_no, 'status': 'published'} for license_no in self.state['protectedLicenses']],
                                'scope': 'Derived source publications only; no clinical or human review claim.'})

    def child(self, arguments, phase):
        token = phase.replace('/', '-') + '-' + uuid4().hex
        stdout, stderr = self.logs / (token + '.stdout.log'), self.logs / (token + '.stderr.log')
        if self.state.get('error'):
            self.state['lastFailure'] = {'error': self.state.pop('error'), 'phase': self.state.get('lastPhase'),
                                         'at': self.state.get('updatedAt'), 'diagnostic': self.state.get('lastChildFailure')}
        self.state.update(status='running', lastPhase=phase, lastLogs={'stdout': str(stdout), 'stderr': str(stderr)})
        self.save()
        with stdout.open('w', encoding='utf-8') as out, stderr.open('w', encoding='utf-8') as err:
            options = {'cwd': PROJECT_ROOT, 'stdout': out, 'stderr': err, 'check': False}
            if os.name == 'nt':
                options['creationflags'] = subprocess.CREATE_NO_WINDOW
            result = subprocess.run([str(value) for value in arguments], **options)
        if result.returncode != 0:
            diagnostic = {'code': 'UNKNOWN', 'validation': False, 'readOnlyTransient': False}
            try:
                require(stderr.stat().st_size <= 1_000_000, 'child_stderr_too_large')
                error_report = json.loads([line for line in stderr.read_text(encoding='utf-8-sig').splitlines() if line.strip()][-1])
                require(isinstance(error_report, dict), 'child_error_report_not_object')
                supplied = error_report.get('diagnostic', {})
                if error_report.get('status') == 'failed' and isinstance(supplied, dict):
                    # Only standard allowlisted codes can authorize another read.
                    diagnostic = {'code': supplied.get('code') if supplied.get('code') in SAFE_FAILURE_CODES else 'UNKNOWN',
                                  'validation': supplied.get('validation') is not False,
                                  'readOnlyTransient': supplied.get('validation') is False and supplied.get('code') in READ_ONLY_TRANSIENT}
            except (ValueError, TypeError, IndexError, OSError):
                pass
            self.state['lastChildFailure'] = {'phase': phase, **diagnostic}; self.save()
            raise BatchError('child_failed_' + phase)
        require(stdout.stat().st_size <= 20_000_000, 'child_stdout_exceeds_json_limit_' + phase)
        lines = [line for line in stdout.read_text(encoding='utf-8-sig').splitlines() if line.strip()]
        require(bool(lines), 'child_final_json_missing_' + phase)
        try:
            report = json.loads(lines[-1])
        except json.JSONDecodeError as error:
            raise BatchError('child_final_json_invalid_' + phase) from error
        require(isinstance(report, dict), 'child_final_json_not_object_' + phase)
        return report

    def node(self, tool, *arguments):
        return ['node', '--import', 'tsx', PROJECT_ROOT / 'tools' / tool, *arguments]

    def fresh_indexes(self):
        for info_id in (36, 39):
            timestamp = read_json(self.args.inventory.resolve() / f'info{info_id}.evidence.json').get('retrievedAt', '')
            try:
                age = (dt.datetime.now(dt.UTC) - dt.datetime.fromisoformat(timestamp.replace('Z', '+00:00'))).total_seconds()
            except (ValueError, TypeError):
                raise BatchError('official_index_timestamp_invalid') from None
            require(-60 <= age < 86400, 'official_index_stale_stop_and_refresh_snapshot')

    def publication_queue(self, manifests):
        for manifest in manifests:
            path = pathlib.Path(manifest).resolve()
            content = read_json(path)
            items = content.get('items')
            require(content.get('project') == PROJECT and content.get('bucket') == BUCKET and isinstance(items, list) and
                    1 <= len(items) <= 50 and len({item['fullLicense'] for item in items}) == len(items), 'prepared_manifest_target_or_items_invalid')
            sha = digest(path)
            if sha not in self.state['completedManifests'] and not any(item['manifestSha256'] == sha for item in self.state['pendingPublications']):
                self.state['pendingPublications'].append({'manifest': str(path), 'manifestSha256': sha, 'stage': 'new'})
        self.save()

    def publish_pending(self):
        while self.state['pendingPublications']:
            operation = self.state['pendingPublications'][0]
            manifest = pathlib.Path(operation['manifest'])
            require(digest(manifest) == operation['manifestSha256'], 'pending_manifest_changed')
            expected = {item['fullLicense'] for item in read_json(manifest)['items']}
            common = ['--manifest', manifest, '--project', PROJECT, '--bucket', BUCKET,
                      '--catalog-cache', self.output / 'catalog-cache', '--python', self.args.python]
            if operation['stage'] in ('new', 'inspecting'):
                # Until stdout hashes are durably saved, no apply can have started.
                # Re-inspect into a fresh path rather than trusting an orphaned file.
                for attempt in range(1, 3):  # At most two READONLY attempts, never an apply retry.
                    snapshot = self.output / ('snapshot-' + uuid4().hex + '.json')
                    operation.update(stage='inspecting', snapshot=str(snapshot), inspectAttempt=attempt); self.save()
                    try:
                        report = self.child(self.node('publish-tfda-sources.ts', '--mode', 'inspect', *common, '--snapshot', snapshot), 'inspect')
                        break
                    except BatchError as error:
                        failure = self.state.get('lastChildFailure', {})
                        if str(error) != 'child_failed_inspect' or attempt == 2 or failure.get('validation') is not False or failure.get('readOnlyTransient') is not True:
                            raise
                require(report.get('status') == 'cloud_readonly_snapshot_created' and report.get('manifestSha256') == operation['manifestSha256'] and
                        report.get('snapshotSha256') == digest(snapshot), 'inspect_snapshot_or_manifest_hash_mismatch')
                snapshot_sha = report['snapshotSha256']
                operation.update(stage='apply_pending', snapshotSha256=snapshot_sha); self.save()
            require(operation['stage'] == 'apply_pending' and digest(pathlib.Path(operation['snapshot'])) == operation['snapshotSha256'], 'pending_snapshot_changed')
            report = self.child(self.node('publish-tfda-sources.ts', '--mode', 'apply', *common, '--snapshot', operation['snapshot'],
                                '--manifest-sha256', operation['manifestSha256'], '--snapshot-sha256', operation['snapshotSha256']), 'apply')
            results = report.get('results')
            require(report.get('status') == 'fixed_batch_apply_finished' and isinstance(results, list) and len(results) == len(expected) and
                    {item.get('fullLicense') for item in results} == expected, 'apply_result_set_invalid')
            licenses = set(self.state['protectedLicenses'])
            licenses.update(item['fullLicense'] for item in results if item.get('status') in SUCCESS)
            self.state['protectedLicenses'] = sorted(licenses)
            self.state['completedManifests'][operation['manifestSha256']] = results
            self.state['pendingPublications'].pop(0); self.save()

    def run(self):
        args = self.args
        self.fresh_indexes()
        if args.publish:
            self.publication_queue(self.state['preparedManifests']); self.publish_pending()
        else:
            require(not self.state['pendingPublications'], 'unfinished_cloud_batch_requires_publish_to_reconcile')
        helper = PROJECT_ROOT / 'tools' / 'fetch-tfda-sources.py'
        fetch = [args.python, '-B', helper, '--inventory', self.queue, '--output', args.corpus.resolve(), '--workers', str(args.fetch_workers)]
        if args.extract_active_from is not None:
            # The downloader owns policy SHA binding/migration. Keep legacy runner bindings intact.
            fetch.extend(['--extract-active-from', args.extract_active_from.resolve()])
        if args.reextract_existing and self.state.get('reextractedHelperSha256') != digest(helper):
            report = self.child([*fetch, '--reextract-cached', '--all'], 'reextract')
            require(report.get('interrupted') is False and report.get('cachedObjectIntegrityFailures', 0) == 0, 'reextract_interrupted_or_cache_corrupt')
            self.state['reextractedHelperSha256'] = digest(helper); self.save()
        completed = 0
        while args.all or completed < args.max_batches:
            self.fresh_indexes()
            batch = self.state['currentBatch']
            if batch is None:
                batch = {'number': self.state['completedBatches'] + 1}
                self.state['currentBatch'] = batch; self.save()
            if 'fetch' not in batch:
                report = self.child([*fetch, '--limit', str(args.batch_size)], 'fetch')
                counts = report.get('statusCounts')
                require(isinstance(counts, dict) and all(type(value) is int and value >= 0 for value in counts.values()), 'fetch_status_counts_invalid')
                require(report.get('interrupted') is False and report.get('cachedObjectIntegrityFailures', 0) == 0, 'fetch_interrupted_or_cache_corrupt')
                require(type(report.get('completedThisRun')) is int and (report['completedThisRun'] > 0 or counts.get('pending', 0) == 0), 'fetch_made_no_progress')
                batch['fetch'] = report; self.save()
            if not batch.get('prepared'):
                self.fresh_indexes()
                report = self.child(self.node('prepare-tfda-sources.ts', '--inventory', args.inventory.resolve(), '--corpus', args.corpus.resolve(),
                                             '--output', self.output / 'prepared', '--protected', self.protected), 'prepare')
                require(isinstance(report.get('manifests'), list) and all(isinstance(path, str) for path in report['manifests']), 'prepare_manifests_invalid')
                self.state['preparedManifests'] = report['manifests']; batch['prepared'] = True; self.save()
            if args.publish and not batch.get('publicationQueued'):
                self.publication_queue(self.state['preparedManifests']); batch['publicationQueued'] = True; self.save()
            if args.publish:
                self.publish_pending()
            counts = batch['fetch']['statusCounts']
            failures = {key: value for key, value in counts.items() if key.startswith('failed') and value}
            self.state.update(currentBatch=None, completedBatches=batch['number'], fetchFailures=failures,
                              lastFetchStatusCounts=counts, pendingSources=counts.get('pending', 0))
            completed += 1; self.save()
            if counts.get('pending', 0) == 0:
                break
        self.state['status'] = 'selected_queue_exhausted_with_failures' if self.state.get('pendingSources') == 0 and self.state.get('fetchFailures') else 'selected_queue_exhausted' if self.state.get('pendingSources') == 0 else 'batch_limit_reached'
        self.state['coverageNotice'] = 'Acquisition queue progress only; raw/draft artifacts are not current published source coverage.'
        self.save(); return self.state


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('inventory', 'corpus', 'output', 'protected'):
        parser.add_argument('--' + flag, required=True, type=pathlib.Path)
    parser.add_argument('--python', default=sys.executable)
    parser.add_argument('--batch-size', type=int, default=100)
    parser.add_argument('--fetch-workers', type=int, default=4, help='Local download/extraction workers (1..4).')
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument('--max-batches', type=int); selection.add_argument('--all', action='store_true')
    parser.add_argument('--publish', action='store_true'); parser.add_argument('--reextract-existing', action='store_true')
    parser.add_argument('--queue', choices=('active', 'all'), default='active')
    parser.add_argument('--extract-active-from', type=pathlib.Path,
                        help='Forward an active-only extraction policy to fetch/reextract; archive other raw URLs without parsing.')
    args = parser.parse_args(argv)
    require(1 <= args.batch_size <= 500 and (args.max_batches is None or args.max_batches > 0), 'invalid_batch_size_or_max_batches')
    require(1 <= args.fetch_workers <= 4, 'invalid_fetch_workers')
    return args


def main(argv=None):
    args = arguments(argv); output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
    require(not args.protected.resolve().is_relative_to(output), 'original_protected_must_be_outside_runner_output')
    runner = None
    with output_lock(output / 'runner.lock'):
        try:
            runner = Runner(args); state = runner.run()
        except (Exception, KeyboardInterrupt) as error:
            if runner:
                runner.state.update(status='interrupted' if isinstance(error, KeyboardInterrupt) else 'failed', error=str(error) if isinstance(error, BatchError) else type(error).__name__)
                runner.save()
            raise
    print(json.dumps({'status': state['status'], 'completedBatches': state['completedBatches'], 'pendingSources': state.get('pendingSources'),
                      'fetchFailures': state.get('fetchFailures', {}), 'publishEnabled': args.publish, 'queue': args.queue, 'aiCalls': 0}))
    return state


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({'status': 'failed', 'code': str(error) if isinstance(error, BatchError) else type(error).__name__, 'aiCalls': 0}), file=sys.stderr)
        raise SystemExit(1)
