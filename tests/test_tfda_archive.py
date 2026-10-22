"""Offline independent archive policy, provenance, integrity and resumption tests."""
import contextlib, hashlib, importlib.util, io, json, pathlib, signal, sqlite3, sys, tempfile, unittest
from unittest.mock import patch

sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('archive_tfda',ROOT/'tools/archive-tfda-assets.py')
archive=importlib.util.module_from_spec(spec);spec.loader.exec_module(archive)

def job(url='https://mcp.fda.gov.tw/files/a.pdf',cohort='current_paper'):
    return {'schema':'tfda-archive-asset/v1','urlHash':hashlib.sha256(url.encode()).hexdigest(),'sourceUrl':url,'cohorts':[cohort],'parents':[{'fullLicense':'衛部藥製字第000001號','parentSourceUrl':'https://mcp.fda.gov.tw/exportpdf/1','parentRawSha256':'a'*64,'discoveryType':cohort}],'rawOnlyArchive':True,'publicationEligible':False}

def queue_file(root,rows):
    path=root/'queue.ndjson';path.write_text(''.join(json.dumps(row,ensure_ascii=False)+'\n'for row in rows),encoding='utf8');return path

def add_main_source(corpus,url,raw,status='downloaded_html_draft',extraction=None,license_no='L1',error=None):
    corpus.mkdir(parents=True,exist_ok=True);module=archive.helper_module();key=module.sha_bytes(url.encode());digest=module.sha_bytes(raw)if raw else None
    blob=pathlib.Path('objects')/digest[:2]/(digest+'.html')if digest else None
    if blob:(corpus/blob).parent.mkdir(parents=True,exist_ok=True);(corpus/blob).write_bytes(raw)
    extraction_path=pathlib.Path('extraction')/(key+'.json')if extraction is not None else None
    if extraction_path:
        extraction.update(urlHash=key,sourceBlobSha256=digest);(corpus/extraction_path).parent.mkdir(parents=True,exist_ok=True);(corpus/extraction_path).write_text(json.dumps(extraction),encoding='utf8')
    result={'sourceBlobSha256':digest,'sourceType':'html','bytes':len(raw)if raw else None,'blobPath':str(blob)if blob else None,'extractionPath':str(extraction_path)if extraction_path else None,'error':error,'finalUrl':url,'fetchedAt':'2026-10-22T00:00:00Z','contentType':'text/html','redirects':[],'httpStatus':200}
    with contextlib.closing(sqlite3.connect(corpus/'checkpoint.sqlite3'))as database:
        database.executescript('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE IF NOT EXISTS sources(url_hash TEXT PRIMARY KEY,url TEXT,disposition TEXT,status TEXT,result_json TEXT);CREATE TABLE IF NOT EXISTS product_sources(full_license TEXT,url_hash TEXT,PRIMARY KEY(full_license,url_hash));')
        database.execute('INSERT INTO sources VALUES(?,?,?,?,?)',(key,url,'',status,json.dumps(result)));database.execute('INSERT INTO product_sources VALUES(?,?)',(license_no,key));database.commit()
    return {'url_hash':key,'url':url,'status':status,'sha256':digest,'source_type':'html','bytes':len(raw)if raw else None,'blob_path':str(blob)if blob else None,'extraction_path':str(extraction_path)if extraction_path else None,'error':error,'final_url':url,'fetched_at':result['fetchedAt'],'content_type':'text/html','redirects':'[]','http_status':200,'corpus':str(corpus)}

class ArchiveTests(unittest.TestCase):
    def test_url_policy_and_query_identity(self):
        self.assertEqual(archive.canonical_url('../x?a=1#ignored','https://mcp.fda.gov.tw/base/item'),'https://mcp.fda.gov.tw/x?a=1')
        self.assertIn('%E8%A1%9B',archive.canonical_url('https://MCP.FDA.GOV.TW:443/衛?x=%ab'))
        self.assertNotEqual(archive.canonical_url('https://mcp.fda.gov.tw/a?c=2'),archive.canonical_url('https://mcp.fda.gov.tw/a'))
        for url in ['http://mcp.fda.gov.tw/a','https://mcp.fda.gov.tw.evil.example/a','https://evilfda.gov.tw/a','https://user@mcp.fda.gov.tw/a','https://mcp.fda.gov.tw:444/a']:
            with self.subTest(url=url),self.assertRaises(ValueError):archive.canonical_url(url)

    def test_magic_media_does_not_trust_extension(self):
        for raw,kind in [(b'%PDF-x','pdf'),(b'\x89PNG\r\n\x1a\n','png'),(b'\xff\xd8\xff','jpeg'),(b'GIF89a','gif'),(b'RIFFxxxxWEBP','webp'),(b'<?xml?><svg>','svg'),(b'<html>','html'),(b'xyz','other')]:
            with self.subTest(kind=kind):self.assertEqual(archive.archive_media_kind(raw,'application/octet-stream'),kind)

    def test_audit_keeps_all_provenance_and_never_changes_main_checkpoint(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);corpus=root/'main';url='https://mcp.fda.gov.tw/exportpdf/L1'
            extraction={'paperLinks':['/a.pdf','/b.pdf'],'historicalPaperLinks':['/old.pdf'],'nonTextImages':[{'src':'/a.png'},{'src':'data:image/png;base64,eA=='},{'src':'https://evil.example/a.png'}],'nonTextElements':[{'tag':'object','src':'/b.svg'}]}
            source=add_main_source(corpus,url,b'<html>body</html>',extraction=extraction)
            add_main_source(corpus,'https://mcp.fda.gov.tw/large.pdf',b'',status='failed',error='source_exceeds_15mb',license_no='L2')
            inventory=root/'inventory.ndjson';inventory.write_text(json.dumps({'fullLicense':'L1','active':True})+'\n'+json.dumps({'fullLicense':'L2','active':False,'archiveLicenseState':'revoked'})+'\n',encoding='utf8')
            before=hashlib.sha256((corpus/'checkpoint.sqlite3').read_bytes()).hexdigest()
            with contextlib.redirect_stdout(io.StringIO()),patch.object(archive,'helper_module',wraps=archive.helper_module):report=archive.audit(corpus,inventory,root/'audit')
            self.assertEqual(hashlib.sha256((corpus/'checkpoint.sqlite3').read_bytes()).hexdigest(),before)
            self.assertEqual(report['uniqueArchiveAssetUrls'],6);self.assertEqual(report['networkRequests'],0)
            self.assertEqual(report['inlineDataUriOccurrencesRetainedInParentRaw'],{'figure':1});self.assertEqual(report['attachmentDiscoveryCounts']['figure_quarantined_nonofficial_or_nonhttps'],1)
            jobs=[json.loads(line)for line in(root/'audit/assets.ndjson').read_text(encoding='utf8').splitlines()]
            self.assertEqual(len(jobs),6)
            current=next(item for item in jobs if item['sourceUrl'].endswith('/a.pdf'))
            self.assertEqual(current['parents'][0]['parentRawSha256'],source['sha256']);self.assertEqual(current['parents'][0]['fullLicense'],'L1')
            self.assertTrue(all(item['rawOnlyArchive']and item['publicationEligible']is False for item in jobs))
            oversize=next(item for item in jobs if item['cohorts']==['oversize']);self.assertIsNone(oversize['parents'][0]['parentRawSha256'])

    def test_verified_main_raw_reuse_is_copy_and_never_downloads_or_inspects(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);item=job();candidate=add_main_source(root/'main',item['sourceUrl'],b'<html>cached</html>');module=archive.helper_module()
            with patch.object(module,'process_source',side_effect=AssertionError('network or inspect forbidden')):result=archive.collect_asset(item,root/'archive',{item['sourceUrl']:[candidate]},module)
            self.assertEqual(result['networkRequests'],0);self.assertTrue(result['reusedVerifiedRaw']);self.assertFalse(result['publicationEligible']);self.assertIsNone(result['parserVersion'])
            self.assertEqual(result['parents'],item['parents']);self.assertEqual(pathlib.Path(result['rawPath']).read_bytes(),b'<html>cached</html>')
            pathlib.Path(result['rawPath']).write_bytes(b'corruption')
            self.assertEqual((root/'main'/candidate['blob_path']).read_bytes(),b'<html>cached</html>')

    def test_same_url_multiple_verified_versions_are_all_archived_without_selection(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);item=job();a=add_main_source(root/'a',item['sourceUrl'],b'<html>old</html>');b=add_main_source(root/'b',item['sourceUrl'],b'<html>new</html>');module=archive.helper_module()
            with patch.object(module,'process_source',side_effect=AssertionError('must reuse')):result=archive.collect_asset(item,root/'archive',{item['sourceUrl']:[a,b]},module)
            self.assertEqual(result['status'],'archive_reuse_multiple_raw_versions');self.assertEqual(len(result['rawVersions']),2);self.assertNotIn('sourceBlobSha256',result)
            self.assertTrue(all(pathlib.Path(version['rawPath']).is_file()for version in result['rawVersions']));self.assertEqual(result['networkRequests'],0)
            self.assertTrue((root/'archive/records'/(item['urlHash']+'.json')).is_file());self.assertFalse(result['publicationEligible'])

    def test_bad_main_hash_is_not_silently_reused(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);item=job();candidate=add_main_source(root/'main',item['sourceUrl'],b'<html>cached</html>');candidate['sha256']='0'*64;module=archive.helper_module()
            with patch.object(module,'process_source',return_value={'status':'failed','attempts':1,'error':'test_network_failed'})as call:result=archive.collect_asset(item,root/'archive',{item['sourceUrl']:[candidate]},module)
            call.assert_called_once();self.assertEqual(result['status'],'failed');self.assertFalse(result['publicationEligible'])

    def test_archive_100mb_policy_is_process_local_no_inspection_and_resume_no_request(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);item=job(cohort='oversize');queue=queue_file(root,[item]);out=root/'archive';module=archive.helper_module();raw=b'%PDF-'+b'x'*15_000_001;calls=[]
            def fetch(url):
                calls.append(url);self.assertEqual(module.MAX_BYTES,100_000_000);self.assertEqual(module.TIMEOUT_SECONDS,90)
                return raw,{'finalUrl':url,'contentType':'application/pdf','httpStatus':200,'redirects':[],'fetchedAt':'2026-10-22T00:00:00Z'}
            previous=signal.getsignal(signal.SIGINT)
            with patch.object(archive,'helper_module',return_value=module),patch.object(module,'fetch_bounded',side_effect=fetch),patch.object(module,'inspect_pdf',side_effect=AssertionError('no parsing')),patch.object(module,'inspect_html',side_effect=AssertionError('no parsing')),contextlib.redirect_stdout(io.StringIO()):
                result=archive.collect(queue,out,[],'oversize',1,1,False);resumed=archive.collect(queue,out,[],'oversize',1,1,False)
            self.assertEqual(len(calls),1);self.assertEqual(result['completedThisRun'],1);self.assertEqual(resumed['scheduledThisRun'],0);self.assertEqual(signal.getsignal(signal.SIGINT),previous)
            saved=json.loads((out/'records'/(item['urlHash']+'.json')).read_text(encoding='utf8'));self.assertGreater(saved['bytes'],15_000_000);self.assertEqual(saved['archivePolicy']['maxRawBytes'],100_000_000);self.assertEqual(saved['status'],'downloaded_archive_raw');self.assertIsNone(saved['extractionPath'])
            fresh=archive.helper_module();self.assertEqual(fresh.MAX_BYTES,15_000_000);self.assertEqual(fresh.TIMEOUT_SECONDS,25)

    def test_main_output_checkpoint_is_rejected_before_write(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);(root/'checkpoint.sqlite3').write_bytes(b'keep')
            with self.assertRaisesRegex(ValueError,'separate_from_main'):archive.collect(root/'missing',root,[],'all',1,1,False)
            self.assertEqual((root/'checkpoint.sqlite3').read_bytes(),b'keep');self.assertFalse((root/'archive-checkpoint.sqlite3').exists())

    def test_queue_sha_binding_rejects_changed_scope_without_network(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);queue=queue_file(root,[job()]);out=root/'out';module=archive.helper_module()
            with patch.object(archive,'helper_module',return_value=module),patch.object(module,'process_source',return_value={'status':'failed','attempts':1}),contextlib.redirect_stdout(io.StringIO()):archive.collect(queue,out,[],'all',1,1,False)
            queue_file(root,[job('https://mcp.fda.gov.tw/other')])
            with patch.object(module,'process_source',side_effect=AssertionError('no network')),self.assertRaisesRegex(ValueError,'queue_changed'):archive.collect(queue,out,[],'all',1,1,False)

    def test_corrupted_finished_archive_is_marked_failed_without_automatic_refetch(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);item=job();queue=queue_file(root,[item]);out=root/'out';module=archive.helper_module()
            metadata={'finalUrl':item['sourceUrl'],'contentType':'image/png','httpStatus':200,'redirects':[],'fetchedAt':'2026-10-22T00:00:00Z'}
            with patch.object(archive,'helper_module',return_value=module),patch.object(module,'fetch_bounded',return_value=(b'\x89PNG\r\n\x1a\nraw',metadata))as fetch,contextlib.redirect_stdout(io.StringIO()):
                archive.collect(queue,out,[],'all',1,1,False)
                saved=json.loads((out/'records'/(item['urlHash']+'.json')).read_text(encoding='utf8'));pathlib.Path(saved['rawPath']).write_bytes(b'bad')
                resumed=archive.collect(queue,out,[],'all',1,1,False)
                self.assertEqual(fetch.call_count,1)
            self.assertEqual(resumed['scheduledThisRun'],0);self.assertEqual(resumed['statusCounts'],{'failed_cached_archive_blob_integrity':1})

    def test_invalid_scope_binding_and_workers_rejected_offline(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);item=job();item['publicationEligible']=True;queue=queue_file(root,[item])
            with self.assertRaisesRegex(ValueError,'scope_binding'):archive.collect(queue,root/'out',[],'all',1,1,False)
            with self.assertRaisesRegex(ValueError,'workers'):archive.collect(queue,root/'out2',[],'all',1,5,False)

    def test_archive_lock_prevents_reentry(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);out=root/'out';out.mkdir();queue=queue_file(root,[job()]);module=archive.helper_module()
            with patch.object(archive,'helper_module',return_value=module),module.OutputLock(out/'archive.lock'),self.assertRaisesRegex(module.SourceError,'locked'):archive.collect(queue,out,[],'all',1,1,False)

    def test_unindexed_queue_binds_actual_inventory_and_encodes_full_license(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);inventory=root/'missing.ndjson';license_no='內衛藥製字第006737號'
            inventory.write_text(json.dumps({'active':True,'fullLicense':license_no,'sources':[]},ensure_ascii=False)+'\n',encoding='utf8')
            with contextlib.redirect_stdout(io.StringIO()):summary=archive.make_unindexed_queue(inventory,root/'probe')
            item=json.loads((root/'probe/unindexed-assets.ndjson').read_text(encoding='utf8'));self.assertEqual(summary['products'],1)
            self.assertEqual(item['sourceUrl'],'https://mcp.fda.gov.tw/exportpdf/'+archive.urllib.parse.quote(license_no,safe=''))
            self.assertEqual(item['parents'][0]['inventorySha256'],hashlib.sha256(inventory.read_bytes()).hexdigest());self.assertEqual(item['association'],'no_Info39_association');self.assertFalse(item['publicationEligible'])

    def test_unindexed_probe_refuses_nonactive_or_existing_source_association(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);inventory=root/'missing.ndjson'
            for row in [{'active':False,'fullLicense':'L1','sources':[]},{'active':True,'fullLicense':'L1','sources':[{'sourceUrl':'https://mcp.fda.gov.tw/a'}]}]:
                inventory.write_text(json.dumps(row)+'\n',encoding='utf8')
                with self.assertRaisesRegex(ValueError,'without_source_association'):archive.make_unindexed_queue(inventory,root/'probe')

    def test_unindexed_offline_classification_distinguishes_metadata_body_and_paper(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);items=[job('https://mcp.fda.gov.tw/exportpdf/L'+str(i),'unindexed_active_probe')for i in range(3)];queue=queue_file(root,items);out=root/'archive';module=archive.helper_module()
            body='<div class="toggle-all"><div class="toggle"><div class="toggle-title"><span class="title-name">用法</span></div><div class="toggle-inner">一次一錠。</div></div></div>'
            paper='<div class="popup"><span class="pagetitle">紙本仿單樣式(自行上傳)</span><a href="/insert/pdfcasefile/a">紙本</a></div>'
            raw=[b'<html><div class="page_name"><label>license</label><span>L0</span></div></html>',('<html>'+body+'</html>').encode(),('<html>'+paper+'</html>').encode()]
            def fetch(url):return raw[int(url[-1])],{'finalUrl':url,'contentType':'text/html','httpStatus':200,'redirects':[],'fetchedAt':'2026-10-22T00:00:00Z'}
            with patch.object(archive,'helper_module',return_value=module),patch.object(module,'fetch_bounded',side_effect=fetch),contextlib.redirect_stdout(io.StringIO()):archive.collect(queue,out,[],'unindexed_active_probe',3,1,False)
            with contextlib.redirect_stdout(io.StringIO()):summary=archive.classify_unindexed(out,root/'classifications',50)
            self.assertEqual(summary['classificationCountsIncludingAlreadyClassified'],{'no_leaflet_body':1,'obtained_but_unpublished_missing_index_association':1,'paper_link_observed_pending_archive':1})
            nested=[json.loads(line)for line in(root/'classifications'/summary['discoveredQueue']).read_text(encoding='utf8').splitlines()]
            self.assertEqual(len(nested),1);self.assertEqual(nested[0]['parents'][0]['parentRawSha256'],hashlib.sha256(raw[2]).hexdigest());self.assertFalse(nested[0]['publicationEligible']);self.assertEqual(nested[0]['association'],'no_Info39_association')
            reports=[json.loads(path.read_text(encoding='utf8'))for path in(root/'classifications/classifications').glob('*.json')]
            self.assertTrue(all(report['association']=='no_Info39_association'and report['publicationEligible']is False for report in reports))
            with patch.object(archive.subprocess,'run',side_effect=AssertionError('must reuse prior classifications')),contextlib.redirect_stdout(io.StringIO()):again=archive.classify_unindexed(out,root/'classifications',50)
            self.assertEqual(again['newlyClassified'],0)

    def test_unindexed_tampered_raw_is_not_parsed_or_reported_as_obtained(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);item=job(cohort='unindexed_active_probe');queue=queue_file(root,[item]);out=root/'archive';module=archive.helper_module();metadata={'finalUrl':item['sourceUrl'],'contentType':'text/html','httpStatus':200,'redirects':[]}
            with patch.object(archive,'helper_module',return_value=module),patch.object(module,'fetch_bounded',return_value=(b'<html>metadata</html>',metadata)),contextlib.redirect_stdout(io.StringIO()):archive.collect(queue,out,[],'unindexed_active_probe',1,1,False)
            saved=json.loads((out/'records'/(item['urlHash']+'.json')).read_text(encoding='utf8'));pathlib.Path(saved['rawPath']).write_bytes(b'changed')
            with patch.object(archive.subprocess,'run',side_effect=AssertionError('never parse corrupt raw')),contextlib.redirect_stdout(io.StringIO()):summary=archive.classify_unindexed(out,root/'classification',1)
            self.assertEqual(summary['classificationCountsIncludingAlreadyClassified'],{'unclassified_response_requires_review':1})
            evidence=json.loads((root/'classification/classifications'/(item['urlHash']+'.json')).read_text(encoding='utf8'));self.assertEqual(evidence['error'],'archive_raw_integrity_failed')

    def test_incremental_archive_reuses_both_main_and_prior_archive_with_all_provenance(self):
        with tempfile.TemporaryDirectory()as folder:
            root=pathlib.Path(folder);item=job();queue=queue_file(root,[item]);first=root/'first';module=archive.helper_module();main=root/'main';prior=add_main_source(main,item['sourceUrl'],b'<html>old main version</html>')
            metadata={'finalUrl':item['sourceUrl'],'contentType':'text/html','httpStatus':200,'redirects':[],'fetchedAt':'2026-10-23T00:00:00Z'}
            with patch.object(archive,'helper_module',return_value=module),patch.object(module,'fetch_bounded',return_value=(b'<html>new archive version</html>',metadata)),contextlib.redirect_stdout(io.StringIO()):archive.collect(queue,first,[],'all',1,1,False)
            with patch.object(module,'fetch_bounded',side_effect=AssertionError('all successes must be reused')),patch.object(archive,'helper_module',return_value=module),contextlib.redirect_stdout(io.StringIO()):summary=archive.collect(queue,root/'incremental',[main,first],'all',1,1,False)
            result=json.loads((root/'incremental/records'/(item['urlHash']+'.json')).read_text(encoding='utf8'))
            self.assertEqual(summary['networkAttemptsThisRun'],0);self.assertEqual(result['status'],'archive_reuse_multiple_raw_versions');self.assertEqual(len(result['rawVersions']),2)
            self.assertEqual({entry['corpus']for entry in result['reuseProvenance']},{str(main),str(first)})
            archive_provenance=next(entry for entry in result['reuseProvenance']if entry['corpus']==str(first));self.assertEqual(archive_provenance['priorParents'],item['parents']);self.assertEqual(archive_provenance['priorCohorts'],item['cohorts'])
            self.assertIn(prior['sha256'],{version['sha256']for version in result['rawVersions']});self.assertTrue(all(pathlib.Path(version['rawPath']).is_file()for version in result['rawVersions']))

if __name__=='__main__':unittest.main()
