"""Build a complete TFDA license/source inventory without models or cloud writes.

Fresh: python tools/build-tfda-inventory.py --output NEW_EMPTY_DIRECTORY
Replay: python tools/build-tfda-inventory.py --output FROZEN_DIRECTORY --reuse
Only --reuse may replace derived reports; original response/JSON/evidence never change.
"""
import argparse
import collections
import datetime as dt
import hashlib
import io
import json
import os
import pathlib
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

LIMIT = 150_000_000
SCHEMA = 'tfda-full-inventory/v1'
FROZEN_FILES = tuple(f'info{info_id}.{suffix}' for info_id in (36, 39)
                     for suffix in ('response.bin', 'json', 'evidence.json'))


class InventoryError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise InventoryError(code)


def taipei_today():
    # Today's Taiwan civil date is UTC+08. This needs no optional Windows tzdata.
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=8), 'Asia/Taipei')).date()


@contextmanager
def output_guard(root, reuse):
    if reuse:
        require(root.is_dir(), 'reuse_output_directory_missing')
    else:
        root.mkdir(parents=True, exist_ok=True)
        require(not any(root.iterdir()), 'fresh_output_must_be_empty_use_new_directory_or_reuse')
    lock = root / '.inventory.lock'
    try:
        stream = lock.open('x', encoding='utf-8')
    except FileExistsError as error:
        raise InventoryError('inventory_output_already_locked') from error
    try:
        with stream:
            stream.write(json.dumps({'pid': os.getpid(), 'reuse': reuse}) + '\n')
            stream.flush()
            if not reuse:
                require(not any(path.name != lock.name for path in root.iterdir()),
                        'fresh_output_changed_before_snapshot')
            yield
    finally:
        lock.unlink(missing_ok=True)

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def sha_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value, exclusive=False):
    encoded = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if exclusive:
        with path.open('xb') as stream:
            stream.write(encoded)
        return
    temporary = path.with_name(path.name + '.tmp-' + uuid4().hex)
    try:
        temporary.write_bytes(encoded)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)

def write_ndjson(path, values):
    temporary = path.with_name(path.name + '.tmp-' + uuid4().hex)
    try:
        with temporary.open('x', encoding='utf-8', newline='\n') as stream:
            for value in values:
                stream.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)

def official_url(url):
    try:
        p = urllib.parse.urlsplit(url)
        return (p.scheme == 'https' and p.hostname is not None and
                (p.hostname == 'fda.gov.tw' or p.hostname.endswith('.fda.gov.tw')) and
                not p.username and not p.password and p.port in (None, 443))
    except ValueError:
        return False

class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        super().__init__()
        self.hops = []
        self.blocked = None

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urljoin(req.full_url, newurl)
        if not official_url(req.full_url) or not official_url(target):
            self.blocked = {'status': code, 'fromUrl': req.full_url, 'toUrl': target, 'followed': False}
            raise ValueError('blocked_nonofficial_or_nonhttps_redirect')
        self.hops.append({'status': code, 'fromUrl': req.full_url, 'toUrl': target})
        return super().redirect_request(req, fp, code, msg, headers, target)

def fetch(info_id):
    legacy = f'https://data.fda.gov.tw/opendata/exportDataList.do?method=ExportData&InfoId={info_id}&logType=5'
    url = f'https://data.fda.gov.tw/data/opendata/export/{info_id}/json'
    require(official_url(url), 'official_index_url_required')
    redirects = OfficialRedirect()
    opener = urllib.request.build_opener(redirects)
    started = dt.datetime.now(dt.UTC).isoformat()
    request = urllib.request.Request(url, headers={'User-Agent': 'Yaozhitong-TFDA-inventory/1.0'})
    with opener.open(request, timeout=60) as response:
        require(official_url(response.geturl()) and response.status == 200, 'official_index_response_invalid')
        raw = response.read(LIMIT + 1)
        require(0 < len(raw) <= LIMIT, 'index_download_size_limit')
        evidence = {'infoId': info_id, 'requestedUrl': url, 'finalUrl': response.geturl(),
                    'redirects': redirects.hops, 'retrievalStartedAt': started,
                    'legacyEndpoint': legacy, 'legacyBlockedRedirect': None,
                    'legacyEndpointRequested': False,
                    'retrievedAt': dt.datetime.now(dt.UTC).isoformat(), 'httpStatus': response.status,
                    'contentType': response.headers.get('Content-Type'),
                    'lastModified': response.headers.get('Last-Modified'),
                    'etag': response.headers.get('ETag'), 'downloadBytes': len(raw),
                    'downloadSha256': sha(raw)}
    data, member_name = unpack_response(raw)
    if member_name:
        evidence['archiveMember'] = member_name
    rows = decode_rows(data)
    evidence.update(jsonBytes=len(data), jsonSha256=sha(data), rows=len(rows),
                    fields=list(rows[0]) if rows else [])
    return rows, evidence, data, raw


def unpack_response(raw):
    require(0 < len(raw) <= LIMIT, 'index_download_size_limit')
    data = raw
    member_name = None
    if raw.startswith(b'PK'):
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            names = [name for name in archive.namelist() if name.lower().endswith('.json')]
            require(len(names) == 1, 'index_json_member_ambiguous')
            member = archive.getinfo(names[0])
            require(0 < member.file_size <= LIMIT, 'index_expanded_size_limit')
            require(member.compress_size > 0 and member.file_size / member.compress_size < 200, 'index_expansion_ratio_limit')
            data = archive.read(names[0])
            member_name = names[0]
    require(0 < len(data) <= LIMIT, 'index_json_size_limit')
    return data, member_name


def decode_rows(data):
    rows = json.loads(data.decode('utf-8-sig'))
    require(isinstance(rows, list) and all(isinstance(row, dict) for row in rows), 'index_rows_must_be_objects')
    return rows

def load(info_id, root):
    data_path, response_path = root / f'info{info_id}.json', root / f'info{info_id}.response.bin'
    require(data_path.stat().st_size <= LIMIT and response_path.stat().st_size <= LIMIT, 'frozen_index_size_limit')
    data, response = data_path.read_bytes(), response_path.read_bytes()
    evidence = json.loads((root / f'info{info_id}.evidence.json').read_text(encoding='utf-8-sig'))
    require(evidence.get('infoId') == info_id and evidence.get('httpStatus') == 200,
            'frozen_index_identity_or_http_status_invalid')
    require(official_url(evidence.get('requestedUrl', '')) and official_url(evidence.get('finalUrl', '')),
            'frozen_index_official_https_provenance_invalid')
    hops = evidence.get('redirects')
    require(isinstance(hops, list) and all(isinstance(hop, dict) and official_url(hop.get('fromUrl', '')) and
            official_url(hop.get('toUrl', '')) for hop in hops), 'frozen_index_redirect_provenance_invalid')
    require(sha(data) == evidence.get('jsonSha256') and len(data) == evidence.get('jsonBytes'),
            'frozen_json_sha256_or_size_mismatch')
    require(sha(response) == evidence.get('downloadSha256') and len(response) == evidence.get('downloadBytes'),
            'frozen_response_sha256_or_size_mismatch')
    unpacked, member_name = unpack_response(response)
    require(unpacked == data and member_name == evidence.get('archiveMember'), 'frozen_response_json_binding_mismatch')
    rows = decode_rows(data)
    require(len(rows) == evidence.get('rows'), 'frozen_index_row_count_mismatch')
    checksums_path = root / 'output-checksums.json'
    if checksums_path.exists():
        checksums = json.loads(checksums_path.read_text(encoding='utf-8-sig'))
        for name in (f'info{info_id}.json', f'info{info_id}.response.bin', f'info{info_id}.evidence.json'):
            expected = checksums.get(name)
            require(isinstance(expected, dict) and expected.get('sha256') == sha_file(root / name) and
                    expected.get('bytes') == (root / name).stat().st_size, 'frozen_checksum_manifest_mismatch')
    return rows, evidence

def parse_date(value):
    if not value:
        return None
    for fmt in ('%Y/%m/%d', '%Y-%m-%d', '%Y%m%d'):
        try:
            return dt.datetime.strptime(str(value), fmt).date()
        except ValueError:
            pass
    return None

def catalog_status(row, as_of):
    revoked = bool(str(row.get('註銷狀態') or '').strip())
    effective = parse_date(row.get('有效日期'))
    return {'revoked': revoked, 'effectiveUntil': row.get('有效日期'),
            'validDateParsed': effective is not None,
            'active': not revoked and effective is not None and effective >= as_of,
            'reason': 'revoked' if revoked else 'invalid_or_missing_effective_date' if effective is None else 'expired' if effective < as_of else 'active'}

def url_type(url):
    try:
        p = urllib.parse.urlsplit(url)
    except ValueError:
        return 'invalid_source_url'
    path = p.path.lower()
    if path.rstrip('/') in ('/insert/pdfcase', '/insert/pdfcasefile', '/fileshow', '/exportpdf'):
        return 'placeholder_missing_resource_identifier'
    if '/exportpdf/' in path:
        return 'exportpdf_entrypoint'
    if path.startswith('/insert/pdfcasefile/'):
        return 'official_pdfcasefile_endpoint'
    if path.endswith('.pdf'):
        return 'direct_pdf'
    if '/im_detail_' in path:
        return 'electronic_leaflet_html'
    if path.endswith(('.jpg', '.jpeg', '.png', '.gif', '.tif', '.tiff', '.bmp')):
        return 'image'
    return 'other'

def url_occurrences(field, index_row, license_no):
    if not isinstance(field, str):
        field = '' if field is None else str(field)
    # Keep every occurrence in original order, even repeated URLs and repeated rows.
    matches = list(re.finditer(r'https?://[^\s;<>"\u3000]+', field))
    result = []
    for ordinal, match in enumerate(matches):
        raw_url = match.group(0)
        result.append({'indexRow': index_row, 'sourceOrdinalInRow': ordinal,
                       'fullLicense': license_no, 'sourceUrl': raw_url,
                       'sourceKeySha256': sha(raw_url.encode('utf-8')),
                       'rawFieldStart': match.start(), 'rawFieldEnd': match.end(),
                       'initialOfficialHttps': official_url(raw_url),
                       'urlType': url_type(raw_url), 'networkStatus': 'not_fetched',
                       'sourceDisposition': 'quarantined_nonofficial_or_nonhttps' if not official_url(raw_url) else 'quarantined_missing_resource_identifier' if url_type(raw_url) == 'placeholder_missing_resource_identifier' else 'queued_unfetched',
                       'redirectPolicy': 'https_fda_gov_tw_at_every_hop'})
    return result

def build_inventory(root, as_of, reuse=False):
    if reuse:
        catalog, catalog_evidence = load(36, root)
        index, index_evidence = load(39, root)
    else:
        with ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(fetch, 36)
            b = pool.submit(fetch, 39)
            catalog, catalog_evidence, catalog_json, catalog_response = a.result()
            index, index_evidence, index_json, index_response = b.result()
        # Both downloads have passed before any frozen snapshot is written.
        for info_id, data, response, evidence in (
                (36, catalog_json, catalog_response, catalog_evidence),
                (39, index_json, index_response, index_evidence)):
            for suffix, content in (('json', data), ('response.bin', response)):
                with (root / f'info{info_id}.{suffix}').open('xb') as stream:
                    stream.write(content)
            write_json(root / f'info{info_id}.evidence.json', evidence, exclusive=True)
    frozen_files = {name: {'bytes': (root / name).stat().st_size, 'sha256': sha_file(root / name)}
                    for name in FROZEN_FILES}
    frozen_path = root / 'frozen-snapshot.json'
    if frozen_path.exists():
        frozen = json.loads(frozen_path.read_text(encoding='utf-8-sig'))
        require(frozen.get('files') == frozen_files, 'frozen_snapshot_manifest_mismatch')
    else:
        write_json(frozen_path, {'schema': 'tfda-frozen-indexes/v1', 'files': frozen_files}, exclusive=True)
    frozen_sha256 = sha(json.dumps(frozen_files, sort_keys=True, separators=(',', ':')).encode())
    by_license = collections.defaultdict(list)
    by_index = collections.defaultdict(list)
    for i, row in enumerate(catalog):
        by_license[str(row.get('許可證字號') or '')].append((i, row))
    for i, row in enumerate(index):
        by_index[str(row.get('許可證字號') or '')].append((i, row))
    licenses = list(by_license)
    licenses.extend(no for no in by_index if no not in by_license)
    inventory = []
    all_occurrences = []
    residue = []
    for license_no in licenses:
        cat = by_license.get(license_no, [])
        ix = by_index.get(license_no, [])
        statuses = [catalog_status(row, as_of) for _, row in cat]
        states = {s['active'] for s in statuses}
        active = bool(cat) and states == {True}
        occurrences = []
        for ix_id, row in ix:
            field = row.get('仿單圖檔連結')
            found = url_occurrences(field, ix_id, license_no)
            occurrences.extend(found)
            text_field = str(field or '')
            unmatched = re.sub(r'https?://[^\s;<>"\u3000]+', '', text_field)
            if re.sub(r'[\s;,|]', '', unmatched):
                residue.append({'fullLicense': license_no, 'indexRow': ix_id, 'field': text_field,
                                'unparsedResidue': unmatched})
        unique = list(dict.fromkeys(o['sourceUrl'] for o in occurrences))
        official = [url for url in unique if official_url(url)]
        number = re.search(r'第([A-Za-z]*)(\d+)號$', license_no)
        prefix = license_no[:number.start()] if number else license_no
        fetchable = [url for url in official if url_type(url) != 'placeholder_missing_resource_identifier']
        unresolved = sum(o['sourceDisposition'].startswith('quarantined_') for o in occurrences)
        item = {'schema': SCHEMA, 'fullLicense': license_no, 'licensePrefixExact': prefix,
                'licenseIdentifierExact': number.group(1) + number.group(2) if number else None,
                'licenseNumericPart': number.group(2) if number else None,
                'catalogRowCount': len(cat), 'catalogRows': [{'row': i, 'record': row, 'status': status} for (i,row), status in zip(cat,statuses)],
                'indexRowCount': len(ix), 'indexRows': [{'row': i, 'record': row} for i,row in ix],
                'activeAsOf': as_of.isoformat(), 'active': active, 'catalogActiveStateAmbiguous': len(states) > 1,
                'sourceOccurrenceCount': len(occurrences), 'uniqueSourceCount': len(unique),
                'officialHttpsUniqueSourceCount': len(official),
                'specificResourceSourceCount': len(fetchable),
                'unresolvedSourceCount': unresolved,
                'requiresAllBranchesResolvedBeforeFullTextCoverage': True,
                'sourceUrlsExactOrder': unique, 'officialHttpsSourceUrlsExactOrder': official,
                'fetchableSourceUrlsExactOrder': fetchable,
                'sources': occurrences, 'coverageStatus': 'not_fulltext_downloaded_or_verified',
                'candidateStatus': 'active_with_official_https_source' if active and official else 'active_without_official_https_source' if active else 'unknown_catalog' if not cat else 'inactive_or_ambiguous'}
        inventory.append(item)
        all_occurrences.extend(occurrences)
    active_items = [i for i in inventory if i['active']]
    candidates = [i for i in active_items if i['officialHttpsUniqueSourceCount']]
    download_candidates = [i for i in candidates if i['specificResourceSourceCount']]
    all_source_candidates = []
    for item in inventory:
        if not item['indexRowCount'] or not item['uniqueSourceCount']:
            continue
        states = {entry['status']['reason'] for entry in item['catalogRows']}
        state = 'index_only' if not item['catalogRowCount'] else next(iter(states)) if len(states) == 1 else 'mixed_or_ambiguous'
        # Do not mutate active-candidates rows or their existing queue hashes.
        all_source_candidates.append({**item, 'archiveLicenseState': state,
                                      'archiveOnlyUnlessCurrentActiveIdentityAndSourceValidationPass': True})
    all_source_candidates.sort(key=lambda item: not item['active'])  # stable active-first acquisition, then archive
    source_licenses = collections.defaultdict(list)
    for item in inventory:
        for url in item['sourceUrlsExactOrder']:
            source_licenses[url].append(item['fullLicense'])
    active_source_licenses = collections.defaultdict(list)
    for item in candidates:
        for url in item['officialHttpsSourceUrlsExactOrder']:
            active_source_licenses[url].append(item['fullLicense'])
    reused = [{'sourceUrl': u, 'fullLicenses': ls, 'licenseCount': len(ls)} for u,ls in source_licenses.items() if len(ls)>1]
    active_reused = [{'sourceUrl': u, 'fullLicenses': ls, 'licenseCount': len(ls)} for u,ls in active_source_licenses.items() if len(ls)>1]
    by_identifier = collections.defaultdict(list)
    for item in active_items:
        by_identifier[item['licenseIdentifierExact']].append(item['fullLicense'])
    identifier_collisions = [{'licenseIdentifierExact': identifier, 'fullLicenses': ls, 'licenseCount': len(ls)}
                            for identifier, ls in by_identifier.items() if len(ls) > 1]
    manifest = {'schema': SCHEMA, 'generatedAt': dt.datetime.now(dt.UTC).isoformat(), 'activeAsOf': as_of.isoformat(), 'frozenSnapshotSha256': frozen_sha256, 'operation': 'reuse_frozen_indexes_offline' if reuse else 'fresh_official_indexes',
                'catalogEvidence': catalog_evidence, 'leafletIndexEvidence': index_evidence,
                'identityKey': 'fullLicense (exact full TFDA license string; numeric suffix is never a key)',
                'sourceOrdering': 'InfoId39 row order, then URL occurrence order; sourceUrlsExactOrder deduplicates exact strings only',
                'networkPolicy': {'allowedScheme': 'https', 'allowedHost': 'fda.gov.tw or any subdomain of fda.gov.tw',
                                  'validateInitialUrlAndEveryRedirectBeforeNetwork': True, 'bodyDownloadLimitBytes': 15000000},
                'coverageNotice': 'Index presence is source availability only; it is not verified full-text coverage.',
                'inventoryNdjson': 'licenses.ndjson', 'candidateNdjson': 'active-candidates.ndjson',
                'downloadCandidateNdjson': 'download-candidates.ndjson',
                'allSourceCandidateNdjson': 'all-source-candidates.ndjson',
                'allSourceOccurrencesNdjson': 'source-occurrences.ndjson',
                'items': [{'fullLicense': i['fullLicense'], 'licensePrefixExact': i['licensePrefixExact'],
                           'catalogRows': [r['row'] for r in i['catalogRows']], 'indexRows': [r['row'] for r in i['indexRows']],
                           'sourceUrlsExactOrder': i['officialHttpsSourceUrlsExactOrder'],
                           'fetchableSourceUrlsExactOrder': i['fetchableSourceUrlsExactOrder'],
                           'sourceBranches': i['sources'],
                           'sourceOccurrenceCount': i['sourceOccurrenceCount'], 'uniqueSourceCount': i['uniqueSourceCount'],
                           'unresolvedSourceCount': i['unresolvedSourceCount'],
                           'requiresAllBranchesResolvedBeforeFullTextCoverage': True,
                           'requiresSourceIdentityVerification': True, 'requiresFullTextQA': True,
                           'status': 'queued' if i['specificResourceSourceCount'] else 'quarantined_missing_resource_identifier'} for i in candidates]}
    summary = {'schema': SCHEMA, 'generatedAt': manifest['generatedAt'], 'activeAsOf': as_of.isoformat(),
               'frozenSnapshotSha256': frozen_sha256, 'operation': manifest['operation'],
               'catalogRows': len(catalog), 'catalogDistinctFullLicenses': len(by_license),
               'catalogDuplicateFullLicenseGroups': sum(len(v)>1 for v in by_license.values()),
               'catalogStatusRowCounts': dict(collections.Counter(catalog_status(r, as_of)['reason'] for r in catalog)),
               'leafletIndexRows': len(index), 'leafletIndexDistinctFullLicenses': len(by_index),
               'leafletIndexDuplicateFullLicenseGroups': sum(len(v)>1 for v in by_index.values()),
               'allSourceCandidateFullLicenses': len(all_source_candidates),
               'allSourceCandidateStateCounts': dict(collections.Counter(item['archiveLicenseState'] for item in all_source_candidates)),
               'activeFullLicenses': len(active_items),
               'activeWithIndexRow': sum(i['indexRowCount']>0 for i in active_items),
               'activeWithAnyIndexedSourceUrl': sum(i['uniqueSourceCount']>0 for i in active_items),
               'activeWithOfficialHttpsSourceUrl': len(candidates),
               'activeWithSpecificResourceSourceUrl': len(download_candidates),
               'activeOnlyPlaceholderMissingResourceIdentifier': len(candidates) - len(download_candidates),
               'activeWithUnresolvedSourceBranch': sum(i['unresolvedSourceCount']>0 for i in active_items),
               'activeSpecificResourceSourceOccurrences': sum(len(i['fetchableSourceUrlsExactOrder']) for i in active_items),
               'activeWithoutIndexRow': sum(i['indexRowCount']==0 for i in active_items),
               'activeWithIndexRowButNoSourceUrl': sum(i['indexRowCount']>0 and i['uniqueSourceCount']==0 for i in active_items),
               'activeWithoutOfficialHttpsSourceUrl': sum(i['officialHttpsUniqueSourceCount']==0 for i in active_items),
               'activeMultipleDistinctSourceUrls': sum(i['uniqueSourceCount']>1 for i in active_items),
               'activeSourceOccurrenceCount': sum(i['sourceOccurrenceCount'] for i in active_items),
               'activeUniqueSourceUrlCountAcrossLicenses': len(active_source_licenses),
               'activeSumDistinctSourceUrlsPerLicense': sum(i['officialHttpsUniqueSourceCount'] for i in active_items),
               'activeReusedSourceUrls': len(active_reused),
               'activeLicensesAffectedByReusedSourceUrls': len({l for i in active_reused for l in i['fullLicenses']}),
               'allSourceOccurrenceCount': len(all_occurrences),
               'allUniqueSourceUrlCountAcrossLicenses': len(source_licenses),
               'allSumDistinctSourceUrlsPerLicense': sum(i['uniqueSourceCount'] for i in inventory),
               'allRepeatedOccurrencesWithinSameLicense': sum(i['sourceOccurrenceCount'] - i['uniqueSourceCount'] for i in inventory),
               'allReusedSourceUrls': len(reused),
               'nonOfficialHttpsSourceOccurrences': sum(not o['initialOfficialHttps'] for o in all_occurrences),
               'indexUnknownCatalogFullLicenses': sum(i['indexRowCount']>0 and i['catalogRowCount']==0 for i in inventory),
               'indexInactiveOrAmbiguousFullLicenses': sum(i['indexRowCount']>0 and i['catalogRowCount']>0 and not i['active'] for i in inventory),
               'catalogActiveStateAmbiguousFullLicenses': sum(i['catalogActiveStateAmbiguous'] for i in inventory),
               'unparsedSourceFields': len(residue),
               'allSourceUrlTypeOccurrences': dict(collections.Counter(o['urlType'] for o in all_occurrences)),
               'activeSourceUrlTypeOccurrences': dict(collections.Counter(o['urlType'] for i in active_items for o in i['sources'])),
               'activePrefixCounts': dict(collections.Counter(i['licensePrefixExact'] for i in active_items)),
               'activeReissuedLicenseIdentifierCount': sum(bool(re.match(r'[A-Za-z]', i['licenseIdentifierExact'] or '')) for i in active_items),
               'activeIdentifierCollisionGroups': len(identifier_collisions),
               'activeLicensesWithIdentifierCollisions': sum(i['licenseCount'] for i in identifier_collisions),
               'maxActiveIdentifierCollisionGroup': max((i['licenseCount'] for i in identifier_collisions), default=0),
               'indexSourceFieldMaxCharacters': max((len(str(r.get('仿單圖檔連結') or '')) for r in index), default=0),
               'activeUniqueSourceCountDistribution': dict(sorted(collections.Counter(i['uniqueSourceCount'] for i in active_items).items())),
               'fullTextCoverageClaimedByThisInventory': 0,
               'networkScope': 'official_TFDA_HTTPS_only', 'leafletDownloads': 0, 'cloudCalls': 0, 'cloudWrites': 0, 'aiCalls': 0}
    write_ndjson(root / 'licenses.ndjson', inventory)
    write_ndjson(root / 'active-candidates.ndjson', candidates)
    write_ndjson(root / 'download-candidates.ndjson', download_candidates)
    write_ndjson(root / 'all-source-candidates.ndjson', all_source_candidates)
    write_ndjson(root / 'active-missing-sources.ndjson', [i for i in active_items if not i['officialHttpsUniqueSourceCount']])
    write_ndjson(root / 'index-unknown-catalog.ndjson', [i for i in inventory if i['indexRowCount'] and not i['catalogRowCount']])
    write_ndjson(root / 'unresolved-source-branches.ndjson', [o for o in all_occurrences if o['sourceDisposition'].startswith('quarantined_')])
    write_ndjson(root / 'active-identifier-collisions.ndjson', identifier_collisions)
    write_ndjson(root / 'source-occurrences.ndjson', all_occurrences)
    write_ndjson(root / 'source-reuse.ndjson', reused)
    write_ndjson(root / 'active-source-reuse.ndjson', active_reused)
    write_ndjson(root / 'unparsed-source-fields.ndjson', residue)
    write_json(root / 'manifest.json', manifest)
    write_json(root / 'summary.json', summary)
    write_json(root / 'schema.json', {'schema': SCHEMA,
        'licenseKey': 'fullLicense is the exact complete license. licensePrefixExact and licenseIdentifierExact are informational; numeric suffix is never a key.',
        'files': {'info36.json': 'Fresh raw official complete license JSON; catalogRow refers to zero-based array position.',
                  'info39.json': 'Fresh raw official leaflet/box index JSON; indexRow refers to zero-based array position.',
                  'licenses.ndjson': 'All catalog full licenses plus index-only full licenses; all catalogRows and indexRows kept.',
                  'active-candidates.ndjson': 'All active full licenses with initial official HTTPS indexed sources; includes source quarantine branches.',
                  'download-candidates.ndjson': 'Active full licenses with at least one non-placeholder source; use fetchableSourceUrlsExactOrder or source branches with queued_unfetched.',
                  'all-source-candidates.ndjson': 'Every index full license with URL branches, including inactive and index-only artifacts for raw archiving; this queue never grants current source publication eligibility.',
                  'manifest.json': 'items is the batch queue; preserve fullLicense identity and process every branch; no full-text coverage is implied.',
                  'unresolved-source-branches.ndjson': 'Indexed URLs without a resource id; look up current official license detail rather than inventing missing suffix.',
                  'source-occurrences.ndjson': 'Every exact source URL occurrence, in original index row and branch order.',
                  'active-missing-sources.ndjson': 'Active licenses with absent index or empty source field.',
                  'index-unknown-catalog.ndjson': 'Index licenses absent from current catalog; exclude until investigated.',
                  'active-identifier-collisions.ndjson': 'Multiple full licenses share identifier; never merge them.',
                  'output-checksums.json': 'SHA256 and bytes for frozen snapshot and generated artifacts.',
                  'frozen-snapshot.json': 'Immutable hashes of original response, JSON and provenance files.',
                  'inventory-audit.json': 'Latest on-disk row/count reconciliation; historical audit.json is preserved.',
                  'inventory-audit.ndjson': 'Append-only reconciliation history for explicit offline replays.'},
        'sourceFields': {'indexRow': 'zero-based InfoId39 array index', 'sourceOrdinalInRow': 'zero-based URL occurrence order within original field',
                         'sourceUrl': 'exact unmodified index substring', 'sourceKeySha256': 'sha256 of exact URL for source-blob deduplication only',
                         'rawFieldStart': 'zero-based character offset in original 仿單圖檔連結', 'rawFieldEnd': 'exclusive character offset',
                         'sourceDisposition': 'queued_unfetched, quarantined_missing_resource_identifier or quarantined_nonofficial_or_nonhttps',
                         'networkStatus': 'not_fetched means redirects and body format are not yet verified'},
        'completionRule': 'Index availability is not full-text coverage. Every branch must resolve, license identity and text completeness must pass technical source validation, with explicit source correction for unresolved evidence. No human or clinical review is implied.',
        'rerunFresh': 'python tools/build-tfda-inventory.py --output NEW_EMPTY_DIRECTORY',
        'rerunOffline': 'python tools/build-tfda-inventory.py --output FROZEN_DIRECTORY --reuse [--as-of YYYY-MM-DD]',
        'costAndPrivacy': {'cloudCalls':0, 'cloudWrites':0, 'aiCalls':0, 'leafletDownloads':0}})
    # Reconcile serialized rows, not just in-memory counters. Frozen evidence is
    # never refreshed by a replay, and no text-coverage claim follows from counts.
    audit_counts = {}
    expected_counts = {'licenses.ndjson': len(inventory), 'active-candidates.ndjson': len(candidates),
                       'download-candidates.ndjson': len(download_candidates),
                       'all-source-candidates.ndjson': len(all_source_candidates),
                       'source-occurrences.ndjson': len(all_occurrences)}
    for filename, expected_count in expected_counts.items():
        count = 0
        with (root / filename).open(encoding='utf-8') as stream:
            for line in stream:
                require(isinstance(json.loads(line), dict), 'inventory_audit_nonobject_row')
                count += 1
        require(count == expected_count, 'inventory_audit_row_count_mismatch')
        audit_counts[filename] = count
    require(sum(item['catalogRowCount'] for item in inventory) == len(catalog) and
            sum(item['indexRowCount'] for item in inventory) == len(index), 'inventory_audit_original_rows_not_conserved')
    require(len({item['fullLicense'] for item in inventory}) == len(inventory), 'inventory_audit_duplicate_full_license')
    audit = {'schema': 'tfda-inventory-audit/v1', 'status': 'passed', 'checkedAt': dt.datetime.now(dt.UTC).isoformat(),
             'activeAsOf': as_of.isoformat(), 'operation': manifest['operation'], 'frozenSnapshotSha256': frozen_sha256,
             'frozenFilesVerified': len(FROZEN_FILES), 'catalogRowsReconciled': len(catalog),
             'indexRowsReconciled': len(index), 'outputRowsReconciled': audit_counts,
             'networkCalls': 0 if reuse else 2 + len(catalog_evidence.get('redirects', [])) + len(index_evidence.get('redirects', [])),
             'cloudCalls': 0, 'cloudWrites': 0, 'aiCalls': 0,
             'humanReviewed': False, 'clinicalReviewed': False,
             'coverageClaim': 'No full-text coverage is inferred from this inventory.'}
    write_json(root / 'inventory-audit.json', audit)
    with (root / 'inventory-audit.ndjson').open('a', encoding='utf-8', newline='\n') as stream:
        stream.write(json.dumps(audit, ensure_ascii=False, separators=(',', ':')) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    output_files = [path for path in root.iterdir() if path.is_file() and
                    path.name not in ('output-checksums.json', 'audit.json', '.inventory.lock') and '.tmp-' not in path.name]
    write_json(root / 'output-checksums.json', {path.name: {'bytes': path.stat().st_size, 'sha256': sha_file(path)}
                                             for path in sorted(output_files)})
    return summary


def main(argv=None):
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--output', required=True, type=pathlib.Path,
                     help='New/empty directory for fresh snapshots, or existing frozen directory with --reuse.')
    cli.add_argument('--as-of', help='Inclusive license expiry date, YYYY-MM-DD; default is today in Asia/Taipei.')
    cli.add_argument('--reuse', action='store_true', help='Replay and verify original frozen bytes without any network calls.')
    args = cli.parse_args(argv)
    as_of = taipei_today()
    if args.as_of:
        require(bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', args.as_of)), 'as_of_requires_iso_calendar_date')
        parsed = parse_date(args.as_of)
        require(parsed is not None, 'as_of_requires_valid_calendar_date')
        as_of = parsed
    root = args.output.resolve()
    with output_guard(root, args.reuse):
        summary = build_inventory(root, as_of, args.reuse)
    print(json.dumps(summary, ensure_ascii=True))
    return summary

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, InventoryError) else type(error).__name__
        print(json.dumps({'status': 'failed', 'code': code, 'cloudCalls': 0, 'cloudWrites': 0, 'aiCalls': 0}), file=sys.stderr)
        raise SystemExit(1)
