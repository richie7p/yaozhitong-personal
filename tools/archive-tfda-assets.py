"""Independent raw-only TFDA attachment/oversize archive. No publication or AI.

audit reads a frozen main-corpus checkpoint/extractions and writes a private
snapshot and URL queue. collect uses a separate checkpoint/corpus, with an
explicit 100 MB / 90 s archive policy. It never changes runtime/publisher caps,
the main checkpoint, source identity, or the existing parser implementation.
"""
from __future__ import annotations
import argparse, collections, concurrent.futures, contextlib, datetime, hashlib
import importlib.util, io, json, os, pathlib, re, shutil, signal, sqlite3, sys
import threading, urllib.parse, tempfile, subprocess

sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[1]
ARCHIVE_MAX_BYTES=100_000_000
ARCHIVE_DEADLINE_SECONDS=90
COHORTS=('current_paper','historical_paper','figure','oversize','unindexed_active_probe')

def helper_module():
    spec=importlib.util.spec_from_file_location('tfda_raw_archive_fetch',ROOT/'tools/fetch-tfda-sources.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def readonly_database(path):
    connection=sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)
    connection.row_factory=sqlite3.Row;connection.execute('PRAGMA query_only=ON');return connection

def canonical_url(value,base=None):
    if not isinstance(value,str) or not value.strip():raise ValueError('empty_url')
    url=urllib.parse.urljoin(base or '',value.strip());p=urllib.parse.urlsplit(url)
    if p.scheme.lower()!='https' or not p.hostname or not(p.hostname.lower()=='fda.gov.tw' or p.hostname.lower().endswith('.fda.gov.tw')) or p.username or p.password or p.port not in (None,443):raise ValueError('nonofficial_or_nonhttps_url')
    path=urllib.parse.quote(p.path,safe='/%:@!$&\'()*+,;=-._~')
    query=urllib.parse.quote(p.query,safe='/%?:@!$&\'()*+,;=-._~')
    path=re.sub(r'%[0-9a-fA-F]{2}',lambda m:m.group(0).upper(),path);query=re.sub(r'%[0-9a-fA-F]{2}',lambda m:m.group(0).upper(),query)
    return urllib.parse.urlunsplit(('https',p.hostname.lower(),path,query,''))

def corpus_rows(corpus):
    """Only metadata is projected; never load the large duplicated page arrays."""
    database=readonly_database(corpus/'checkpoint.sqlite3')
    try:
        metadata=dict(database.execute('select key,value from meta'))
        query="""select url_hash,url,status,
          json_extract(result_json,'$.sourceBlobSha256') sha256,
          json_extract(result_json,'$.sourceType') source_type,
          json_extract(result_json,'$.bytes') bytes,
          json_extract(result_json,'$.blobPath') blob_path,
          json_extract(result_json,'$.extractionPath') extraction_path,
          json_extract(result_json,'$.error') error,
          json_extract(result_json,'$.finalUrl') final_url,
          json_extract(result_json,'$.fetchedAt') fetched_at,
          json_extract(result_json,'$.contentType') content_type,
          json_extract(result_json,'$.redirects') redirects,
          json_extract(result_json,'$.httpStatus') http_status
          from sources order by rowid"""
        rows=[dict(row) for row in database.execute(query)]
        references=collections.defaultdict(list)
        for row in database.execute('select full_license,url_hash from product_sources'):references[row['url_hash']].append(row['full_license'])
        return rows,dict(references),metadata
    finally:database.close()

def inventory_states(path):
    states={}
    with path.open(encoding='utf-8-sig') as stream:
        for line in stream:
            if line.strip():
                row=json.loads(line);states[row['fullLicense']]=row.get('archiveLicenseState','active' if row.get('active') else 'unknown')
    return states

def write_ndjson(path,rows,module):
    temporary=path.with_name(path.name+'.tmp-'+str(os.getpid()));path.parent.mkdir(parents=True,exist_ok=True)
    with temporary.open('w',encoding='utf-8',newline='\n') as stream:
        for row in rows:stream.write(json.dumps(row,ensure_ascii=False,separators=(',',':'))+'\n')
        stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path)

def audit(corpus,inventory,output,progress=None):
    module=helper_module();started_at=module.now();output.mkdir(parents=True,exist_ok=True)
    rows,refs,metadata=corpus_rows(corpus);states=inventory_states(inventory)
    by_key={row['url_hash']:row for row in rows};by_url={}
    for row in rows:
        try:by_url[canonical_url(row['url'])]=row
        except (ValueError,TypeError):pass
    counts=collections.Counter(row['status'] for row in rows)
    success=[row for row in rows if row['status'].startswith('downloaded_') and row['sha256']]
    unique_raw={row['sha256']:row for row in success}
    source_scopes=collections.defaultdict(collections.Counter);product_states=collections.defaultdict(collections.Counter)
    for row in rows:
        kinds={states.get(license_no,'unknown') for license_no in refs.get(row['url_hash'],[])}
        scope='mixed_active_and_archive' if 'active'in kinds and len(kinds)>1 else 'active_only' if kinds=={'active'} else 'archive_only'
        source_scopes[scope][row['status']]+=1
    product_keys=collections.defaultdict(list)
    for key,licenses in refs.items():
        for license_no in licenses:product_keys[license_no].append(key)
    for license_no,state in states.items():
        statuses=[by_key[key]['status'] for key in product_keys.get(license_no,[]) if key in by_key]
        product_states[state]['products']+=1
        if any(s.startswith('downloaded_')for s in statuses):product_states[state]['anyRawAvailable']+=1
        if statuses and all(s.startswith('downloaded_')for s in statuses):product_states[state]['allTopLevelUrlsHaveRaw']+=1
        if any(s=='pending'for s in statuses):product_states[state]['hasPendingTopLevelUrl']+=1
        if any(s.startswith('failed')for s in statuses):product_states[state]['hasFailedTopLevelUrl']+=1
    jobs={};discover_counts=collections.Counter();parse_failures=collections.Counter();inline=collections.Counter();html_count=0
    def add(url,kind,row,source_attr=None):
        if isinstance(url,str) and url.strip().lower().startswith('data:'):
            inline[kind]+=1;return
        try:canonical=canonical_url(url,row.get('final_url') or row['url'])
        except (ValueError,TypeError):discover_counts[kind+'_quarantined_nonofficial_or_nonhttps']+=1;return
        discover_counts[kind+'_occurrences']+=1
        key=module.sha_bytes(canonical.encode())
        job=jobs.setdefault(key,{'schema':'tfda-archive-asset/v1','urlHash':key,'sourceUrl':canonical,'cohorts':[],'parents':[],'rawOnlyArchive':True,'publicationEligible':False})
        if kind not in job['cohorts']:job['cohorts'].append(kind)
        full_licenses=refs.get(row['url_hash'],[])
        for license_no in full_licenses or [None]:
            parent={'fullLicense':license_no,'licenseState':states.get(license_no,'unknown'),'parentSourceUrl':row['url'],'parentFinalUrl':row.get('final_url'),'parentUrlHash':row['url_hash'],'parentRawSha256':row.get('sha256'),'discoveryType':kind,'sourceAttribute':source_attr,'literalUrl':url,'parentFetchedAt':row.get('fetched_at')}
            if parent not in job['parents']:job['parents'].append(parent)
    for row in rows:
        if row['status'].startswith('failed') and row['error']=='source_exceeds_15mb':add(row['url'],'oversize',row,'main_runtime_15mb_failure')
        if not row['status'].startswith('downloaded_') or row['source_type']!='html' or not row['extraction_path']:continue
        html_count+=1
        try:
            report=json.loads((corpus/row['extraction_path']).read_text(encoding='utf-8-sig'))
            if report.get('sourceBlobSha256')!=row['sha256'] or report.get('urlHash')!=row['url_hash']:
                parse_failures['extraction_raw_binding_mismatch']+=1;continue
        except (OSError,ValueError):parse_failures['extraction_missing_or_invalid']+=1;continue
        for url in report.get('paperLinks',[]):add(url,'current_paper',row,'paperLinks')
        for url in report.get('historicalPaperLinks',[]):add(url,'historical_paper',row,'historicalPaperLinks')
        for image in report.get('nonTextImages',[]):add(image.get('src') if isinstance(image,dict) else image,'figure',row,'nonTextImages.src')
        for element in report.get('nonTextElements',[]):
            if isinstance(element,dict) and element.get('src'):add(element['src'],'figure',row,'nonTextElements.'+str(element.get('tag','unknown'))+'.src')
        if html_count%1000==0:print(json.dumps({'htmlExtractionsScanned':html_count,'uniqueArchiveAssets':len(jobs),'networkRequests':0}),flush=True)
    cohorts={}
    for kind in COHORTS:
        subset=[job for job in jobs.values() if kind in job['cohorts']]
        cohorts[kind]={'uniqueUrls':len(subset),'notInTopLevelQueue':sum(job['sourceUrl']not in by_url for job in subset),'alreadyRawAvailable':sum(job['sourceUrl']in by_url and bool(by_url[job['sourceUrl']]['sha256']) and by_url[job['sourceUrl']]['status'].startswith('downloaded_')for job in subset),'parentReferences':sum(sum(p['discoveryType']==kind for p in job['parents'])for job in subset)}
    for job in jobs.values():
        known=by_url.get(job['sourceUrl']);job['topLevelState']=known['status']if known else'not_in_top_level_queue';job['alreadyKnownRawSha256']=known.get('sha256')if known else None
    progress_data=json.loads(progress.read_text(encoding='utf8')) if progress and progress.exists() else None
    progress_summary=None
    if progress_data:
        statuses=collections.Counter(item['status']for values in progress_data.get('completedManifests',{}).values()for item in values)
        progress_summary={'completedBatches':progress_data.get('completedBatches'),'currentBatchNumber':progress_data.get('currentBatch',{}).get('number'),'persistedPendingSources':progress_data.get('pendingSources'),'completedManifestItemStatuses':dict(statuses),'protectedBaselineCount':len(progress_data.get('protectedLicenses',[])),'status':progress_data.get('status'),'lastPhase':progress_data.get('lastPhase'),'pendingPublications':[{k:v for k,v in item.items()if k in ('stage','manifest','manifestSha256')}for item in progress_data.get('pendingPublications',[])]}
    report={'schema':'tfda-corpus-readonly-audit/v1','at':module.now(),'sourceSnapshotStartedAt':started_at,'corpus':str(corpus),'checkpointInventorySha256':metadata.get('inventory_sha256'),'inventorySha256':module.sha_file(inventory),'sourceStatusCounts':dict(counts),'uniqueQueuedUrls':len(rows),'rawSuccessUrls':len(success),'uniqueRawSha256':len(unique_raw),'successFormatCounts':dict(collections.Counter(row['source_type']for row in success)),'rawBytesAcrossUrls':sum(row['bytes']or 0 for row in success),'rawBytesAcrossDistinctSha256':sum(row['bytes']or 0 for row in unique_raw.values()),'failedReasonCounts':dict(collections.Counter(row['error']for row in rows if row['status'].startswith('failed'))),'uniqueUrlScopeStatusCounts':{k:dict(v)for k,v in source_scopes.items()},'productStateCoverage':{k:dict(v)for k,v in product_states.items()},'htmlExtractionsScanned':html_count,'extractionBindingFailures':dict(parse_failures),'attachmentDiscoveryCounts':dict(discover_counts),'inlineDataUriOccurrencesRetainedInParentRaw':dict(inline),'attachmentCohorts':cohorts,'uniqueArchiveAssetUrls':len(jobs),'uniqueAssetsNotInTopLevelQueue':sum(job['sourceUrl']not in by_url for job in jobs.values()),'progress':progress_summary,'limits':['Discovery covers explicit saved paperLinks/historicalPaperLinks/nonTextImages/nonTextElements only. Historical electronic detail item links, lazy/srcset/CSS references and not-yet-downloaded HTML may add further assets.','Record/checkpoint SHA metadata was counted; this audit does not rehash every main raw object or establish fresh cloud/publication coverage.','Every discovered attachment/figure/oversize source is archive-only. A same URL or same bytes never grants current-product or publication equivalence.'],'networkRequests':0,'cloudWrites':0,'aiCalls':0}
    queue=sorted(jobs.values(),key=lambda job:(min(COHORTS.index(c)for c in job['cohorts']),job['sourceUrl']))
    write_ndjson(output/'assets.ndjson',queue,module);module.write_json(output/'snapshot.json',report)
    print(json.dumps({k:report[k]for k in ('rawSuccessUrls','uniqueRawSha256','sourceStatusCounts','attachmentCohorts','uniqueArchiveAssetUrls','uniqueAssetsNotInTopLevelQueue')},ensure_ascii=False),flush=True)
    return report

def build_reuse_index(corpora):
    found=collections.defaultdict(list)
    def add(url,candidate):
        try:url=canonical_url(url)
        except ValueError:return
        if not any(item['sha256']==candidate['sha256'] and item['corpus']==candidate['corpus'] for item in found[url]):found[url].append(candidate)
    for corpus in corpora:
        if (corpus/'checkpoint.sqlite3').is_file():
            rows,refs,_=corpus_rows(corpus)
            for row in rows:
                if not row['status'].startswith('downloaded_') or not row['sha256'] or not row['blob_path']:continue
                add(row['url'],{**row,'corpus':str(corpus),'priorFullLicenses':refs.get(row['url_hash'],[])})
        if (corpus/'archive-checkpoint.sqlite3').is_file():
            with contextlib.closing(readonly_database(corpus/'archive-checkpoint.sqlite3'))as database:
                for row in database.execute("select url_hash,url,result_json from assets where status like 'downloaded_%' or status='archive_reuse_multiple_raw_versions'"):
                    saved=json.loads(row['result_json']);versions=saved.get('rawVersions')or[{'blobPath':saved.get('blobPath'),'bytes':saved.get('bytes'),'sha256':saved.get('sourceBlobSha256'),'fetchedAt':saved.get('fetchedAt')}]
                    for version in versions:
                        if not version.get('blobPath')or not version.get('sha256'):continue
                        candidate={'url_hash':row['url_hash'],'url':row['url'],'sha256':version['sha256'],'bytes':version['bytes'],'blob_path':version['blobPath'],'source_type':saved.get('sourceType','other'),'final_url':saved.get('finalUrl',row['url']),'fetched_at':version.get('fetchedAt'),'content_type':saved.get('contentType','application/octet-stream'),'redirects':json.dumps(saved.get('redirects',[])),'http_status':saved.get('httpStatus'),'corpus':str(corpus),'priorParents':saved.get('parents',[]),'priorCohorts':saved.get('cohorts',[]),'priorReuseProvenance':saved.get('reuseProvenance',[])}
                        add(row['url'],candidate)
    return dict(found)

def reuse_provenance(candidate):
    return {'corpus':candidate['corpus'],'sourceUrl':candidate['url'],'urlHash':candidate['url_hash'],'sha256':candidate['sha256'],'fetchedAt':candidate['fetched_at'],'priorFullLicenses':candidate.get('priorFullLicenses',[]),'priorParents':candidate.get('priorParents',[]),'priorCohorts':candidate.get('priorCohorts',[]),'priorReuseProvenance':candidate.get('priorReuseProvenance',[])}

def archive_media_kind(raw,content_type):
    if raw.startswith(b'%PDF-'):return'pdf'
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):return'png'
    if raw.startswith(b'\xff\xd8\xff'):return'jpeg'
    if raw.startswith((b'GIF87a',b'GIF89a')):return'gif'
    if raw.startswith(b'RIFF')and raw[8:12]==b'WEBP':return'webp'
    if b'<svg' in raw[:1000].lower():return'svg'
    if content_type=='text/html'or b'<html'in raw[:4096].lower():return'html'
    return'other'

def copy_verified_raw(candidate,output,module):
    """Use a copy so independent-archive damage cannot alter the main corpus."""
    source=pathlib.Path(candidate['corpus'])/candidate['blob_path']
    suffix=source.suffix if source.suffix in ('.pdf','.html','.bin') else '.bin'
    blob=output/'objects'/candidate['sha256'][:2]/(candidate['sha256']+suffix)
    blob.parent.mkdir(parents=True,exist_ok=True)
    if blob.is_file() and blob.stat().st_size==candidate['bytes'] and module.sha_file(blob)==candidate['sha256']:return blob
    fd,temporary=tempfile.mkstemp(prefix=candidate['sha256']+'.',suffix='.tmp',dir=blob.parent)
    try:
        with os.fdopen(fd,'wb')as target,source.open('rb')as original:
            shutil.copyfileobj(original,target,1024*1024);target.flush();os.fsync(target.fileno())
        if pathlib.Path(temporary).stat().st_size!=candidate['bytes']or module.sha_file(pathlib.Path(temporary))!=candidate['sha256']:raise ValueError('reused_archive_blob_hash_mismatch')
        os.replace(temporary,blob)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)
    return blob

def collect_asset(job,output,reuse,module):
    """Reuse verified successful raw bytes; never parse, publish or infer identity."""
    candidates=reuse.get(job['sourceUrl'],[]);verified=[]
    for candidate in candidates:
        path=pathlib.Path(candidate['corpus'])/candidate['blob_path']
        if path.is_file()and path.stat().st_size==candidate['bytes']and module.sha_file(path)==candidate['sha256']:verified.append(candidate)
    digests={candidate['sha256']for candidate in verified}
    if len(digests)>1:
        versions=[]
        for candidate in verified:
            blob=copy_verified_raw(candidate,output,module)
            versions.append({'sha256':candidate['sha256'],'bytes':candidate['bytes'],'blobPath':str(blob.relative_to(output)),'rawPath':str(blob),'fetchedAt':candidate['fetched_at'],'reusedFromCorpus':candidate['corpus']})
        result={'schema':'tfda-archive-result/v1','urlHash':job['urlHash'],'sourceUrl':job['sourceUrl'],'status':'archive_reuse_multiple_raw_versions','rawVersions':versions,'at':module.now(),'rawOnlyArchive':True,'publicationEligible':False,'networkRequests':0}
    elif verified:
        candidate=verified[0];blob=copy_verified_raw(candidate,output,module)
        result={'schemaVersion':1,'urlHash':job['urlHash'],'sourceUrl':job['sourceUrl'],'requestedUrl':job['sourceUrl'],'finalUrl':candidate['final_url'],'fetchedAt':candidate['fetched_at'],'at':module.now(),'sourceBlobSha256':candidate['sha256'],'sha256':candidate['sha256'],'bytes':candidate['bytes'],'blobPath':str(blob.relative_to(output)),'rawPath':str(blob),'sourceType':candidate['source_type'],'contentType':candidate['content_type'],'mediaType':candidate['content_type'],'httpStatus':candidate['http_status'],'redirects':json.loads(candidate['redirects'])if candidate['redirects']else[],'status':'downloaded_archive_raw','rawOnlyArchive':True,'extractionStatus':'archive_raw_only_not_extracted','extractionPath':None,'parserVersion':None,'publicationEligible':False,'reusedVerifiedRaw':True,'reusedFromCorpus':candidate['corpus'],'networkRequests':0}
    else:
        result=module.process_source({'url_hash':job['urlHash'],'url':job['sourceUrl'],'rawOnlyArchive':True},output)
        result['networkRequests']=result.get('attempts',0)
        if result.get('error')=='source_exceeds_15mb':result['error']='source_exceeds_archive_limit_100mb'
    result.update(schema='tfda-archive-result/v1',parents=job['parents'],cohorts=job['cohorts'],reuseProvenance=[reuse_provenance(candidate)for candidate in verified],archivePolicy={'maxRawBytes':ARCHIVE_MAX_BYTES,'downloadDeadlineSeconds':ARCHIVE_DEADLINE_SECONDS,'maxAttempts':2,'runtimeRawLimitUnchanged':15_000_000},publicationEligible=False,archiveOnlyReason='independent_attachment_figure_or_oversize_raw_archive')
    if result.get('blobPath'):
        with (output/result['blobPath']).open('rb')as stream:prefix=stream.read(4096)
        result['archiveMediaKind']=archive_media_kind(prefix,result.get('contentType',''))
    module.write_json(output/'records'/(job['urlHash']+'.json'),result);return result

def collect(queue,output,corpora,cohort,limit,workers,retry_failed):
    if limit<1 or not 1<=workers<=4 or cohort not in (*COHORTS,'all'):raise ValueError('invalid_archive_limit_workers_or_cohort')
    module=helper_module()
    # These are module globals in this separate process only; no file/runtime cap changes.
    module.MAX_BYTES=ARCHIVE_MAX_BYTES;module.TIMEOUT_SECONDS=ARCHIVE_DEADLINE_SECONDS
    if (output/'checkpoint.sqlite3').exists():raise ValueError('archive_output_must_be_separate_from_main_corpus')
    output.mkdir(parents=True,exist_ok=True);stopped=threading.Event()
    def stop(*unused):stopped.set()
    previous_signals={sig:signal.signal(sig,stop)for sig in (signal.SIGINT,signal.SIGTERM)if hasattr(signal,sig.name)}
    try:
      with module.OutputLock(output/'archive.lock'),contextlib.closing(sqlite3.connect(output/'archive-checkpoint.sqlite3'))as database:
        database.row_factory=sqlite3.Row
        database.executescript('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS assets(url_hash TEXT PRIMARY KEY,url TEXT NOT NULL,job_json TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT);')
        queue_raw=queue.read_bytes();digest=module.sha_bytes(queue_raw);previous=database.execute("select value from meta where key='queue_sha256'").fetchone()
        if previous and previous[0]!=digest:raise ValueError('archive_queue_changed_use_a_new_output_directory')
        if not previous:
            with io.StringIO(queue_raw.decode('utf-8-sig'))as stream:
                for line in stream:
                    if not line.strip():continue
                    job=json.loads(line)
                    if job.get('rawOnlyArchive')is not True or job.get('publicationEligible')is not False or canonical_url(job['sourceUrl'])!=job['sourceUrl']or module.sha_bytes(job['sourceUrl'].encode())!=job['urlHash']:raise ValueError('invalid_archive_queue_url_or_scope_binding')
                    database.execute('insert into assets values(?,?,?,?,?)',(job['urlHash'],job['sourceUrl'],json.dumps(job,ensure_ascii=False),'pending',None))
            database.execute("insert into meta values('queue_sha256',?)",(digest,));database.commit()
        for row in database.execute("select url_hash,result_json from assets where status like 'downloaded_%' or status='archive_reuse_multiple_raw_versions'").fetchall():
            saved=json.loads(row['result_json']);versions=saved.get('rawVersions')or[{'blobPath':saved.get('blobPath'),'bytes':saved.get('bytes'),'sha256':saved.get('sourceBlobSha256')}]
            def intact(version):
                blob=output/version['blobPath']if version.get('blobPath')else None
                return bool(blob and blob.is_file()and blob.stat().st_size==version['bytes']and module.sha_file(blob)==version['sha256'])
            if not all(intact(version)for version in versions):
                saved.update(status='failed_cached_archive_blob_integrity',error='cached_archive_blob_missing_or_hash_mismatch',at=module.now())
                database.execute('update assets set status=?,result_json=?where url_hash=?',(saved['status'],json.dumps(saved,ensure_ascii=False),row['url_hash']))
        database.commit()
        jobs=[]
        for row in database.execute("select job_json from assets where status='pending'"+("or status like 'failed%'"if retry_failed else'')+' order by rowid'):
            job=json.loads(row['job_json'])
            if cohort=='all'or cohort in job['cohorts']:jobs.append(job)
            if len(jobs)>=limit:break
        reuse=build_reuse_index(corpora);completed=0;network=0;inflight={};cursor=iter(jobs)
        def submit(pool):
            if stopped.is_set():return
            try:job=next(cursor)
            except StopIteration:return
            inflight[pool.submit(collect_asset,job,output,reuse,module)]=job
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers)as pool, (output/'events.jsonl').open('a',encoding='utf8',newline='\n')as journal:
            for _ in range(workers):submit(pool)
            while inflight:
                done,_=concurrent.futures.wait(inflight,return_when=concurrent.futures.FIRST_COMPLETED)
                for future in done:
                    job=inflight.pop(future)
                    try:result=future.result()
                    except Exception as error:result={'urlHash':job['urlHash'],'sourceUrl':job['sourceUrl'],'status':'failed_archive_worker','error':type(error).__name__,'at':module.now(),'rawOnlyArchive':True,'publicationEligible':False,'parents':job['parents'],'cohorts':job['cohorts']}
                    encoded=json.dumps(result,ensure_ascii=False);database.execute('update assets set status=?,result_json=?where url_hash=?',(result['status'],encoded,job['urlHash']));database.commit();journal.write(encoded+'\n');journal.flush();completed+=1;network+=result.get('networkRequests',0)
                    print(json.dumps({'completedThisRun':completed,'scheduledThisRun':len(jobs),'urlHash':job['urlHash'],'status':result['status'],'bytes':result.get('bytes',0)}),flush=True);submit(pool)
        counts={row['status']:row['n']for row in database.execute('select status,count(*)n from assets group by status')}
        raw_urls=0;raw_versions=0;raw_sizes={};url_version_bytes=0
        for row in database.execute("select json_extract(result_json,'$.sourceBlobSha256')sha,json_extract(result_json,'$.bytes')bytes,json_extract(result_json,'$.rawVersions')versions from assets where status like 'downloaded_%' or status='archive_reuse_multiple_raw_versions'"):
            versions=json.loads(row['versions'])if row['versions']else[{'sha256':row['sha'],'bytes':row['bytes']}]
            if any(version.get('sha256')for version in versions):raw_urls+=1
            for version in versions:
                if version.get('sha256'):raw_versions+=1;raw_sizes[version['sha256']]=version['bytes'];url_version_bytes+=version['bytes']
        failures={row['error']:row['n']for row in database.execute("select json_extract(result_json,'$.error')error,count(*)n from assets where status like 'failed%' group by error")}
        summary={'schema':'tfda-archive-summary/v1','at':module.now(),'queueSha256':digest,'cohort':cohort,'scheduledThisRun':len(jobs),'completedThisRun':completed,'interrupted':stopped.is_set(),'statusCounts':counts,'rawSuccessUrls':raw_urls,'rawUrlVersionReferences':raw_versions,'uniqueRawSha256':len(raw_sizes),'rawBytesAcrossUrlVersionReferences':url_version_bytes,'rawBytesAcrossDistinctSha256':sum(raw_sizes.values()),'failedReasonCounts':failures,'networkAttemptsThisRun':network,'archivePolicy':{'maxRawBytes':ARCHIVE_MAX_BYTES,'downloadDeadlineSeconds':ARCHIVE_DEADLINE_SECONDS,'maxWorkers':4},'runtimeRawLimitUnchanged':15_000_000,'publicationActions':0,'cloudWrites':0,'aiCalls':0}
        module.write_json(output/'summary.json',summary);print(json.dumps(summary));return summary
    finally:
        for sig,handler in previous_signals.items():signal.signal(sig,handler)

def make_unindexed_queue(inventory,output):
    """Derive a known official license route; do not invent a PDF resource UUID."""
    module=helper_module();raw=inventory.read_bytes();inventory_sha=module.sha_bytes(raw);jobs=[];seen=set()
    for line in raw.decode('utf-8-sig').splitlines():
        if not line.strip():continue
        row=json.loads(line);license_no=row.get('fullLicense')
        if row.get('active')is not True or not isinstance(license_no,str)or not license_no.strip()or row.get('sources')!=[]:raise ValueError('unindexed_probe_requires_active_products_without_source_association')
        if license_no in seen:raise ValueError('duplicate_unindexed_license')
        seen.add(license_no)
        url=canonical_url('https://mcp.fda.gov.tw/exportpdf/'+urllib.parse.quote(license_no,safe=''))
        jobs.append({'schema':'tfda-archive-asset/v1','urlHash':module.sha_bytes(url.encode()),'sourceUrl':url,'cohorts':['unindexed_active_probe'],'parents':[{'fullLicense':license_no,'licenseState':'active','parentSourceUrl':None,'parentRawSha256':None,'discoveryType':'unindexed_active_probe','origin':'derived_known_official_license_route','association':'no_Info39_association','inventorySha256':inventory_sha}],'origin':'derived_known_official_license_route','association':'no_Info39_association','rawOnlyArchive':True,'publicationEligible':False})
    output.mkdir(parents=True,exist_ok=True);write_ndjson(output/'unindexed-assets.ndjson',jobs,module)
    report={'schema':'tfda-unindexed-probe-queue/v1','at':module.now(),'inventorySha256':inventory_sha,'products':len(jobs),'uniqueUrls':len(jobs),'origin':'derived_known_official_license_route','association':'no_Info39_association','publicationEligible':False,'networkRequests':0,'cloudWrites':0,'aiCalls':0}
    module.write_json(output/'unindexed-queue-summary.json',report);print(json.dumps(report));return report

def classify_unindexed(archive_corpus,output,limit=50):
    """Read only archived responses, using the frozen raw DOM parser offline.

    These derived routes can never establish an Info39 association or a current
    paper version. Body/link discoveries remain unpublished and become a second
    independent raw-archive queue; no link is fetched here.
    """
    if limit<1:raise ValueError('positive_classification_limit_required')
    module=helper_module();helper_sha=module.sha_file(ROOT/'tools/fetch-tfda-sources.py');output.mkdir(parents=True,exist_ok=True);reports=[];nested={};counts=collections.Counter()
    with contextlib.closing(readonly_database(archive_corpus/'archive-checkpoint.sqlite3'))as database:
        rows=list(database.execute("select url_hash,job_json,result_json from assets where status='downloaded_archive_raw' order by rowid"))
    for row in rows:
        job=json.loads(row['job_json'])
        if 'unindexed_active_probe'not in job['cohorts']:continue
        result=json.loads(row['result_json']);path=archive_corpus/result['blobPath'];digest=result['sourceBlobSha256']
        report_path=output/'classifications'/(row['url_hash']+'.json')
        if report_path.is_file():
            old=json.loads(report_path.read_text(encoding='utf-8'))
            if old.get('sourceBlobSha256')==digest and old.get('parserHelperSha256')==helper_sha and path.is_file()and path.stat().st_size==result['bytes']and module.sha_file(path)==digest:counts[old['classification']]+=1;continue
        evidence={'schema':'tfda-unindexed-response-classification/v1','at':module.now(),'urlHash':row['url_hash'],'sourceUrl':job['sourceUrl'],'sourceBlobSha256':digest,'rawPath':str(path),'parents':job['parents'],'parserHelperSha256':helper_sha,'origin':'derived_known_official_license_route','association':'no_Info39_association','rawOnlyArchive':True,'publicationEligible':False,'classification':'unclassified_response_requires_review','networkRequests':0,'limitation':'A downloaded response and DOM body/link observation do not establish index association, current attachment version, clinical completeness or official absence of other leaflets.'}
        try:
            if not path.is_file()or path.stat().st_size!=result['bytes']or module.sha_file(path)!=digest:raise ValueError('archive_raw_integrity_failed')
            with path.open('rb')as stream:kind=archive_media_kind(stream.read(4096),result.get('contentType',''))
            evidence['archiveMediaKind']=kind
            if kind=='pdf':evidence.update(classification='obtained_but_unpublished_missing_index_association',obtainedKind='raw_pdf_magic_only_not_parsed')
            elif kind=='html':
                if result['bytes']>15_000_000:raise ValueError('html_above_frozen_parser_input_limit_raw_archived')
                command=[sys.executable,'-X','utf8',str(ROOT/'tools/fetch-tfda-sources.py'),'--inspect-html-internal',str(path),result.get('finalUrl')or job['sourceUrl']]
                child=subprocess.run(command,capture_output=True,timeout=45,check=False)
                if child.returncode:raise ValueError('offline_html_parser_child_failed')
                parsed=json.loads(child.stdout)
                if parsed.get('rawSha256')!=digest or parsed.get('rawBytes')!=result['bytes']:raise ValueError('offline_parser_raw_binding_failed')
                module.write_json(output/'dom-evidence'/(row['url_hash']+'.json'),parsed)
                body=bool(parsed.get('sections'))and any(section.get('text','').strip()for section in parsed['sections'])
                links=parsed.get('paperLinks',[])+parsed.get('historicalPaperLinks',[])
                evidence.update(parserVersion=parsed.get('parserVersion'),bodyObserved=body,fullDomConserved=parsed.get('fullDomConserved')is True,currentPaperLinks=len(parsed.get('paperLinks',[])),historicalPaperLinks=len(parsed.get('historicalPaperLinks',[])),unaccountedMainBlockCount=parsed.get('unaccountedMainBlockCount'))
                if body and parsed.get('fullDomConserved')is True:evidence.update(classification='obtained_but_unpublished_missing_index_association',obtainedKind='recognized_full_dom_body')
                elif body:evidence['classification']='leaflet_body_observed_but_unverified_missing_index_association'
                elif links:evidence['classification']='paper_link_observed_pending_archive'
                elif parsed.get('toggleAllCount')==0:evidence.update(classification='no_leaflet_body',observationScope='no_recognized_leaflet_body_in_this_response_only')
                for cohort,attribute in [('current_paper','paperLinks'),('historical_paper','historicalPaperLinks'),('figure','nonTextImages'),('figure','nonTextElements')]:
                    for item in parsed.get(attribute,[]):
                        literal=item.get('src')if isinstance(item,dict)else item
                        if isinstance(literal,str)and literal.lower().startswith('data:'):continue
                        try:url=canonical_url(literal,result.get('finalUrl')or job['sourceUrl'])
                        except (ValueError,TypeError):continue
                        key=module.sha_bytes(url.encode());asset=nested.setdefault(key,{'schema':'tfda-archive-asset/v1','urlHash':key,'sourceUrl':url,'cohorts':[],'parents':[],'origin':'derived_known_official_license_route','association':'no_Info39_association','rawOnlyArchive':True,'publicationEligible':False})
                        if cohort not in asset['cohorts']:asset['cohorts'].append(cohort)
                        for parent in job['parents']:
                            reference={**parent,'parentSourceUrl':job['sourceUrl'],'parentFinalUrl':result.get('finalUrl'),'parentUrlHash':row['url_hash'],'parentRawSha256':digest,'discoveryType':cohort,'sourceAttribute':attribute,'literalUrl':literal}
                            if reference not in asset['parents']:asset['parents'].append(reference)
        except subprocess.TimeoutExpired:evidence.update(classification='unclassified_response_requires_review',error='offline_html_parse_deadline_45s')
        except (OSError,ValueError,KeyError,TypeError)as error:evidence.update(classification='unclassified_response_requires_review',error=str(error)if isinstance(error,ValueError)else type(error).__name__)
        module.write_json(report_path,evidence);reports.append(evidence);counts[evidence['classification']]+=1
        if len(reports)>=limit:break
    # Each finite classification batch gets its own immutable downstream queue.
    run_key=module.sha_bytes(json.dumps([(r['urlHash'],r['sourceBlobSha256'])for r in reports],separators=(',',':')).encode())
    queue_name='discovered-assets-'+run_key[:16]+'.ndjson';write_ndjson(output/queue_name,sorted(nested.values(),key=lambda job:job['sourceUrl']),module)
    summary={'schema':'tfda-unindexed-classification-summary/v1','at':module.now(),'newlyClassified':len(reports),'classificationCountsIncludingAlreadyClassified':dict(counts),'discoveredArchiveAssetUrls':len(nested),'discoveredQueue':queue_name,'noLeafletBodyMeaning':'This response has no recognized leaflet body; it does not prove that TFDA has no other available leaflet.','publicationActions':0,'networkRequests':0,'cloudWrites':0,'aiCalls':0}
    module.write_json(output/'classification-summary.json',summary);print(json.dumps(summary));return summary

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='mode',required=True)
    inspect=sub.add_parser('audit');inspect.add_argument('--corpus',type=pathlib.Path,required=True);inspect.add_argument('--inventory',type=pathlib.Path,required=True);inspect.add_argument('--output',type=pathlib.Path,required=True);inspect.add_argument('--progress',type=pathlib.Path)
    download=sub.add_parser('collect');download.add_argument('--queue',type=pathlib.Path,required=True);download.add_argument('--output',type=pathlib.Path,required=True);download.add_argument('--reuse-corpus',type=pathlib.Path,action='append',default=[]);download.add_argument('--cohort',choices=(*COHORTS,'all'),default='current_paper');download.add_argument('--limit',type=int,default=50);download.add_argument('--workers',type=int,default=4);download.add_argument('--retry-failed',action='store_true')
    probe=sub.add_parser('make-unindexed-queue');probe.add_argument('--inventory',type=pathlib.Path,required=True);probe.add_argument('--output',type=pathlib.Path,required=True)
    classify=sub.add_parser('classify-unindexed');classify.add_argument('--corpus',type=pathlib.Path,required=True);classify.add_argument('--output',type=pathlib.Path,required=True);classify.add_argument('--limit',type=int,default=50)
    args=parser.parse_args(argv)
    if args.mode=='audit':audit(args.corpus.resolve(),args.inventory.resolve(),args.output.resolve(),args.progress.resolve()if args.progress else None)
    elif args.mode=='make-unindexed-queue':make_unindexed_queue(args.inventory.resolve(),args.output.resolve())
    elif args.mode=='classify-unindexed':classify_unindexed(args.corpus.resolve(),args.output.resolve(),args.limit)
    else:
        if args.limit<1 or not 1<=args.workers<=4:parser.error('positive --limit and 1..4 --workers required')
        collect(args.queue.resolve(),args.output.resolve(),[p.resolve()for p in args.reuse_corpus],args.cohort,args.limit,args.workers,args.retry_failed)
    return 0
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as error:
        print(json.dumps({'status':'failed','errorType':type(error).__name__,'error':str(error)if isinstance(error,ValueError)else'archive_operation_failed'}),file=sys.stderr);sys.exit(1)
