"""Synthetic offline tests; no official downloads, cloud credentials or model calls."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
import urllib.request
from unittest import mock

TOOL = pathlib.Path(__file__).resolve().parents[1] / 'tools' / 'build-tfda-inventory.py'
SPEC = importlib.util.spec_from_file_location('tfda_inventory_tested', TOOL)
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)

DAY = '2026-10-22'
LICENSE = '衛部藥製字第999991號'
URL = 'https://mcp.fda.gov.tw/insert/pdfcasefile/synthetic-source?c=2'


def product(license_no=LICENSE, expiry='2030/12/31', revoked=''):
    return {'許可證字號': license_no, '中文品名': '合成離線測試錠5毫克',
            '英文品名': 'SYNTHETIC OFFLINE TABLETS 5MG', '有效日期': expiry,
            '註銷狀態': revoked, '主成分略述': 'SYNTHETIC INGREDIENT'}


def index_row(license_no=LICENSE, field=URL):
    return {'許可證字號': license_no, '中文品名': '合成離線測試錠5毫克',
            '英文品名': 'SYNTHETIC OFFLINE TABLETS 5MG', '仿單圖檔連結': field}


def snapshot(info_id, rows):
    raw = json.dumps(rows, ensure_ascii=False).encode('utf-8')
    endpoint = f'https://data.fda.gov.tw/data/opendata/export/{info_id}/json'
    evidence = {'infoId': info_id, 'requestedUrl': endpoint, 'finalUrl': endpoint,
                'httpStatus': 200, 'redirects': [], 'retrievedAt': '2026-10-22T01:00:00Z',
                'downloadBytes': len(raw), 'downloadSha256': inventory.sha(raw),
                'jsonBytes': len(raw), 'jsonSha256': inventory.sha(raw), 'rows': len(rows)}
    return rows, evidence, raw, raw


class TfdaInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='synthetic-tfda-inventory-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name) / 'inventory'
        self.root.mkdir()

    def seed(self, catalog, index):
        for info_id, rows in ((36, catalog), (39, index)):
            _, evidence, raw, response = snapshot(info_id, rows)
            (self.root / f'info{info_id}.json').write_bytes(raw)
            (self.root / f'info{info_id}.response.bin').write_bytes(response)
            inventory.write_json(self.root / f'info{info_id}.evidence.json', evidence)
        inventory.write_json(self.root / 'output-checksums.json', {
            name: {'bytes': (self.root / name).stat().st_size, 'sha256': inventory.sha_file(self.root / name)}
            for name in inventory.FROZEN_FILES})

    def run_reuse(self, as_of=DAY):
        with mock.patch.object(inventory, 'fetch', side_effect=AssertionError('network forbidden')), contextlib.redirect_stdout(io.StringIO()):
            return inventory.main(['--output', str(self.root), '--reuse', '--as-of', as_of])

    def rows(self, filename):
        return [json.loads(line) for line in (self.root / filename).read_text(encoding='utf-8').splitlines()]

    def test_r_identifier_and_equal_numeric_suffixes_keep_separate_complete_licenses(self):
        licenses = ['衛署藥製字第R00091號', '衛部藥製字第000091號', '衛署藥輸字第000091號']
        self.seed([product(value) for value in licenses], [index_row(value) for value in licenses])
        summary = self.run_reuse()
        rows = self.rows('licenses.ndjson')
        self.assertEqual([row['fullLicense'] for row in rows], licenses)
        self.assertEqual(rows[0]['licenseIdentifierExact'], 'R00091')
        self.assertEqual(rows[0]['licensePrefixExact'], '衛署藥製字')
        self.assertEqual(summary['activeReissuedLicenseIdentifierCount'], 1)
        self.assertEqual(summary['activeIdentifierCollisionGroups'], 1)
        self.assertEqual(self.rows('active-identifier-collisions.ndjson')[0]['fullLicenses'], licenses[1:])

    def test_all_url_occurrences_preserve_exact_order_offsets_duplicates_and_quarantine(self):
        other = 'https://mcp.fda.gov.tw/exportpdf/' + LICENSE
        placeholder = 'https://mcp.fda.gov.tw/insert/pdfcase'
        truncated = 'https://mcp.fda.gov.tw/insert/pdfcasefile/'
        insecure = 'http://mcp.fda.gov.tw/synthetic.pdf'
        field = f'{URL}; {other};{URL};{placeholder};{truncated};{insecure}'
        self.seed([product()], [index_row(field=field)])
        self.run_reuse()
        item = self.rows('licenses.ndjson')[0]
        self.assertEqual(item['sourceUrlsExactOrder'], [URL, other, placeholder, truncated, insecure])
        occurrences = self.rows('source-occurrences.ndjson')
        self.assertEqual(len(occurrences), 6)
        self.assertEqual([row['sourceOrdinalInRow'] for row in occurrences], list(range(6)))
        for row in occurrences:
            self.assertEqual(field[row['rawFieldStart']:row['rawFieldEnd']], row['sourceUrl'])
        self.assertEqual(item['fetchableSourceUrlsExactOrder'], [URL, other])
        self.assertEqual(len(self.rows('unresolved-source-branches.ndjson')), 3)
        self.assertTrue(item['requiresAllBranchesResolvedBeforeFullTextCoverage'])

    def test_expiry_revocation_invalid_dates_and_mixed_duplicate_states_are_not_active(self):
        licenses = [f'衛部藥製字第{number:06d}號' for number in range(999980, 999986)]
        rows = [product(licenses[0], DAY), product(licenses[1], '2026/10/21'),
                product(licenses[2], revoked='已註銷'), product(licenses[3], '2029/02/30'),
                product(licenses[4], ''), product(licenses[5]), product(licenses[5], revoked='已註銷')]
        self.seed(rows, [index_row(value) for value in licenses])
        summary = self.run_reuse()
        items = self.rows('licenses.ndjson')
        self.assertEqual([item['active'] for item in items], [True, False, False, False, False, False])
        self.assertTrue(items[-1]['catalogActiveStateAmbiguous'])
        self.assertEqual(sum(item['catalogRowCount'] for item in items), len(rows))
        self.assertEqual(summary['activeFullLicenses'], 1)

    def test_all_source_archive_queue_preserves_inactive_and_index_only_without_expanding_active_queue(self):
        expired, revoked, unknown = ('衛部藥製字第999992號', '衛部藥製字第999993號', '衛部藥製字第999994號')
        self.seed([product(), product(expired, '2020/01/01'), product(revoked, revoked='已註銷')],
                  [index_row(value) for value in (LICENSE, expired, revoked, unknown)])
        self.run_reuse()
        self.assertEqual([row['fullLicense'] for row in self.rows('active-candidates.ndjson')], [LICENSE])
        archive = self.rows('all-source-candidates.ndjson')
        self.assertEqual([row['archiveLicenseState'] for row in archive], ['active', 'expired', 'revoked', 'index_only'])
        self.assertTrue(all(row['archiveOnlyUnlessCurrentActiveIdentityAndSourceValidationPass'] for row in archive))
        self.assertEqual(archive[-1]['catalogRows'], [])
        self.assertEqual(archive[-1]['sourceUrlsExactOrder'], [URL])

    def test_reuse_keeps_original_raw_evidence_and_old_audit_while_appending_new_audit(self):
        self.seed([product(expiry=DAY)], [index_row()])
        original = {name: (self.root / name).read_bytes() for name in inventory.FROZEN_FILES}
        old_audit = b'{"historical":true}\n'
        (self.root / 'audit.json').write_bytes(old_audit)
        first = self.run_reuse()
        second = self.run_reuse('2026-10-23')
        self.assertEqual(first['frozenSnapshotSha256'], second['frozenSnapshotSha256'])
        self.assertEqual(second['activeFullLicenses'], 0)
        for name, raw in original.items():
            self.assertEqual((self.root / name).read_bytes(), raw)
        self.assertEqual((self.root / 'audit.json').read_bytes(), old_audit)
        self.assertEqual(len(self.rows('inventory-audit.ndjson')), 2)
        self.assertEqual(self.rows('inventory-audit.ndjson')[1]['networkCalls'], 0)

    def test_reuse_checks_both_json_and_original_response_sha_before_derived_writes(self):
        for suffix, expected_error in (('json', 'frozen_json_sha256_or_size_mismatch'),
                                       ('response.bin', 'frozen_response_sha256_or_size_mismatch')):
            with self.subTest(suffix=suffix):
                self.seed([product()], [index_row()])
                path = self.root / f'info36.{suffix}'
                path.write_bytes(path.read_bytes() + b' ')
                with self.assertRaisesRegex(inventory.InventoryError, expected_error):
                    self.run_reuse()
                self.assertFalse((self.root / 'manifest.json').exists())

    def test_reuse_checks_original_evidence_checksum_even_when_json_is_unchanged(self):
        self.seed([product()], [index_row()])
        path = self.root / 'info36.evidence.json'
        evidence = json.loads(path.read_text(encoding='utf-8'))
        evidence['retrievedAt'] = '2099-01-01T00:00:00Z'
        inventory.write_json(path, evidence)
        with self.assertRaisesRegex(inventory.InventoryError, 'frozen_checksum_manifest_mismatch'):
            self.run_reuse()

    def test_fresh_output_cannot_overwrite_any_existing_snapshot_or_unrelated_file(self):
        path = self.root / 'preserved.txt'
        path.write_text('unchanged', encoding='utf-8')
        with mock.patch.object(inventory, 'fetch', side_effect=AssertionError('must not fetch')):
            with self.assertRaisesRegex(inventory.InventoryError, 'fresh_output_must_be_empty'):
                inventory.main(['--output', str(self.root), '--as-of', DAY])
        self.assertEqual(path.read_text(encoding='utf-8'), 'unchanged')
        self.assertEqual([p.name for p in self.root.iterdir()], ['preserved.txt'])

    def test_fresh_seed_is_exclusive_and_default_as_of_uses_the_taipei_day_provider(self):
        data = {36: snapshot(36, [product()]), 39: snapshot(39, [index_row()])}
        with mock.patch.object(inventory, 'fetch', side_effect=lambda info_id: data[info_id]), \
                mock.patch.object(inventory, 'taipei_today', return_value=dt.date(2026, 10, 22)), \
                contextlib.redirect_stdout(io.StringIO()):
            summary = inventory.main(['--output', str(self.root)])
        self.assertEqual(summary['activeAsOf'], DAY)
        self.assertTrue((self.root / 'frozen-snapshot.json').exists())
        self.assertEqual(json.loads((self.root / 'inventory-audit.json').read_text())['networkCalls'], 2)
        with self.assertRaisesRegex(inventory.InventoryError, 'fresh_output_must_be_empty'):
            inventory.main(['--output', str(self.root), '--as-of', DAY])

    def test_redirect_policy_blocks_http_and_deceptive_hosts_before_following(self):
        for destination in ('http://data.fda.gov.tw/synthetic.json', 'https://fda.gov.tw.evil.example/synthetic.json'):
            handler = inventory.OfficialRedirect()
            request = urllib.request.Request('https://data.fda.gov.tw/synthetic.json')
            with self.assertRaisesRegex(ValueError, 'blocked_nonofficial_or_nonhttps_redirect'):
                handler.redirect_request(request, None, 301, 'Moved', {}, destination)
            self.assertEqual(handler.hops, [])
            self.assertFalse(handler.blocked['followed'])


if __name__ == '__main__':
    unittest.main()
