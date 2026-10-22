"""Local-only TFDA acquisition and literal-source derivation regression tests."""
import importlib.util, pathlib, unittest, urllib.error, io, tempfile, json, sys, subprocess, signal, threading, time, sqlite3, contextlib
from xml.sax.saxutils import escape
from unittest.mock import patch
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('fetch_tfda',ROOT/'tools/fetch-tfda-sources.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class DownloaderTests(unittest.TestCase):
 def test_absolute_download_deadline_prevents_request(self):
  with patch.object(module.time,'monotonic',side_effect=[0,26]),patch.object(module.urllib.request,'build_opener') as opener:
   with self.assertRaisesRegex(module.SourceError,'deadline'):module.fetch_bounded('https://mcp.fda.gov.tw/a')
  opener.return_value.open.assert_not_called()
 def test_official_https_allowlist(self):
  self.assertIn('%E8%A1%9B',module.validate_official_https('https://mcp.fda.gov.tw/exportpdf/衛署藥製字第001號'))
  for url in ['http://mcp.fda.gov.tw/a','https://evilfda.gov.tw/a','https://fda.gov.tw.evil.example/a','https://user@mcp.fda.gov.tw/a','https://mcp.fda.gov.tw:444/a']:
   with self.subTest(url=url):
    with self.assertRaises(module.SourceError):module.validate_official_https(url)
 def test_redirect_rejected_before_http_request(self):
  calls=[]
  class Opener:
   def open(self,request,timeout):
    calls.append(request.full_url)
    raise urllib.error.HTTPError(request.full_url,302,'redirect',{'Location':'http://mcp.fda.gov.tw/downgraded'},io.BytesIO())
  with patch.object(module.urllib.request,'build_opener',return_value=Opener()):
   with self.assertRaises(module.SourceError):module.fetch_bounded('https://mcp.fda.gov.tw/exportpdf/x')
  self.assertEqual(calls,['https://mcp.fda.gov.tw/exportpdf/x'])
 def test_official_redirect_follows_explicit_validated_https(self):
  calls=[]
  class Response:
   status=200;headers={'Content-Type':'application/pdf','Content-Length':'8'}
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self,n):return stream.read(n)
  stream=io.BytesIO(b'%PDF-abc')
  class Opener:
   def open(self,request,timeout):
    calls.append(request.full_url)
    if len(calls)==1:raise urllib.error.HTTPError(request.full_url,302,'redirect',{'Location':'/file.pdf'},io.BytesIO())
    return Response()
  with patch.object(module.urllib.request,'build_opener',return_value=Opener()):raw,record=module.fetch_bounded('https://mcp.fda.gov.tw/start')
  self.assertEqual(raw,b'%PDF-abc');self.assertEqual(calls,['https://mcp.fda.gov.tw/start','https://mcp.fda.gov.tw/file.pdf']);self.assertEqual(len(record['redirects']),1)
 def test_declared_and_streamed_size_limit(self):
  class Response:
   status=200;headers={'Content-Type':'application/pdf'}
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def read(self,n):return b'x'*n
  class Opener:
   def open(self,*args,**kwargs):return Response()
  with patch.object(module.urllib.request,'build_opener',return_value=Opener()),patch.object(module,'MAX_BYTES',128):
   with self.assertRaisesRegex(module.SourceError,'15mb'):module.fetch_bounded('https://mcp.fda.gov.tw/a')
 def test_placeholder_never_network(self):
  with tempfile.TemporaryDirectory() as directory,patch.object(module,'fetch_bounded',side_effect=AssertionError('must not network')):
   result=module.process_source({'url_hash':'x','url':'https://mcp.fda.gov.tw/insert/pdfcase'},pathlib.Path(directory))
  self.assertEqual(result['status'],'unresolved_placeholder')
 def test_raw_checkpoint_reparse_without_network(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);(root/'objects').mkdir();blob=root/'objects'/'test.html';blob.write_bytes(b'<html>plain</html>')
   module.write_json(root/'records'/'test.json',{'sourceUrl':'https://mcp.fda.gov.tw/a','sourceBlobSha256':module.sha_file(blob),'blobPath':'objects/test.html','finalUrl':'https://mcp.fda.gov.tw/a','contentType':'text/html','httpStatus':200,'redirects':[]})
   with patch.object(module,'fetch_bounded',side_effect=AssertionError('must not network')):
    result=module.process_source({'url_hash':'test','url':'https://mcp.fda.gov.tw/a'},root)
   self.assertTrue(result['resumedVerifiedRawCheckpoint']);self.assertEqual(result['attempts'],0);self.assertTrue((root/'records'/'test.json').exists())
 def test_reextract_only_never_network_if_cache_missing(self):
  with tempfile.TemporaryDirectory() as directory,patch.object(module,'fetch_bounded',side_effect=AssertionError('must not network')):
   result=module.process_source({'url_hash':'test','url':'https://mcp.fda.gov.tw/a','reextractOnly':True},pathlib.Path(directory))
  self.assertEqual(result['status'],'failed_cached_blob_integrity')
 def test_pdf_child_timeout_retains_needs_review_evidence(self):
  with patch.object(module.subprocess,'run',side_effect=module.subprocess.TimeoutExpired('pdf',45)) as run:
   result=module.inspect_pdf(pathlib.Path('raw.pdf'))
  self.assertEqual(result['status'],'needs_review');self.assertEqual(result['parserVersion'],module.PDF_PARSER_VERSION)
  self.assertEqual(result['error'],'independent_pdf_parse_deadline_45s');self.assertEqual(run.call_args.kwargs['timeout'],45)
 def test_pdf_invalid_child_json_is_needs_review(self):
  with patch.object(module.subprocess,'run',return_value=subprocess.CompletedProcess([],0,b'not json',b'private warning\n')):
   report=module.inspect_pdf(pathlib.Path('raw.pdf'))
  self.assertEqual(report['status'],'needs_review');self.assertEqual(report['error'],'independent_pdf_child_invalid_json');self.assertEqual(report['warningLineCount'],1)
 def test_reextract_format_requires_explicit_cached_mode(self):
  run=subprocess.run([sys.executable,'-X','utf8',str(ROOT/'tools/fetch-tfda-sources.py'),'--inventory','not-read','--output','not-created','--reextract-format','html'],capture_output=True,text=True)
  self.assertNotEqual(run.returncode,0);self.assertIn('requires --reextract-cached',run.stderr)
 def test_reextract_format_selects_only_cached_html_no_network(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);inventory=root/'inventory.ndjson';out=root/'out';out.mkdir()
   inventory.write_text(json.dumps({'fullLicense':'x','sources':[{'sourceUrl':'https://mcp.fda.gov.tw/a'},{'sourceUrl':'https://mcp.fda.gov.tw/b'}]})+'\n',encoding='utf8')
   database=sqlite3.connect(out/'checkpoint.sqlite3');database.executescript('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE sources(url_hash TEXT PRIMARY KEY,url TEXT NOT NULL,disposition TEXT,status TEXT NOT NULL,result_json TEXT);CREATE TABLE product_sources(full_license TEXT NOT NULL,url_hash TEXT NOT NULL,PRIMARY KEY(full_license,url_hash));')
   module.load_inventory(database,inventory)
   for index,kind in enumerate(['html','pdf']):
    url='https://mcp.fda.gov.tw/'+('a' if index==0 else 'b');key=module.sha_bytes(url.encode());blob=out/(kind+'.bin');blob.write_bytes(kind.encode())
    result={'urlHash':key,'sourceUrl':url,'sourceType':kind,'blobPath':blob.name,'sourceBlobSha256':module.sha_file(blob)}
    database.execute('update sources set status=?,result_json=? where url_hash=?',('downloaded_'+kind+'_draft',json.dumps(result),key))
   database.commit();database.close();seen=[]
   def local_only(job,root):
    self.assertTrue(job['reextractOnly']);seen.append(job['url']);return {'urlHash':job['url_hash'],'sourceUrl':job['url'],'at':module.now(),'status':'downloaded_html_draft'}
   with patch.object(module,'process_source',side_effect=local_only),patch.object(module,'fetch_bounded',side_effect=AssertionError('no network')),contextlib.redirect_stdout(io.StringIO()):
    status=module.main(['--inventory',str(inventory),'--output',str(out),'--reextract-cached','--reextract-format','html','--limit','100'])
   self.assertEqual(status,0);self.assertEqual(seen,['https://mcp.fda.gov.tw/a'])
 def test_worker_limit_rejects_more_than_four(self):
  run=subprocess.run([sys.executable,'-X','utf8',str(ROOT/'tools/fetch-tfda-sources.py'),'--inventory','not-read','--output','not-created','--workers','5'],capture_output=True,text=True)
  self.assertNotEqual(run.returncode,0);self.assertIn('between 1 and 4',run.stderr)
 def test_html_selects_body_and_excludes_export_modal_and_close_link(self):
  html='''<div class="page_name"><label>許可證號</label><span>衛部藥輸字第000001號</span></div>
  <div class="toggle-all"><div class="toggle"><div class="toggle-title"><span class="title-name">5 警語</span></div><div class="toggle-inner"><div><span class="title-name">5.1</span>孕婦不得使用<table><tr><td>患者</td><td>條件</td></tr></table></div></div></div></div>
  <div id="popupExportSelect" class="popup" data_popup="popup-export-select"><form id="exportForm"><div class="toggle-all"><div class="toggle"><span class="title-name">5 警語</span><input type="checkbox"></div></div></form></div>
  <div class="popup"><span class="pagetitle">紙本仿單樣式(自行上傳)</span><a class="popup_close" href="#">close</a><a href="/insert/pdfcasefile/real">real</a></div>'''
  report=module.inspect_html(html.encode(),'https://mcp.fda.gov.tw/im_detail_1/license')
  self.assertEqual(report['bodyCandidateCount'],1);self.assertTrue(report['fullDomConserved']);self.assertEqual(report['tableCount'],1)
  self.assertEqual(report['paperLinks'],['https://mcp.fda.gov.tw/insert/pdfcasefile/real']);self.assertIn('孕婦不得使用',report['normalizedSectionText'])
 def test_metadata_only_html_cannot_be_complete_leaflet(self):
  report=module.inspect_html(b'<html><div class="page_name"><label>name</label><span>test</span></div></html>','https://mcp.fda.gov.tw/im_detail_1/x')
  self.assertFalse(report['fullDomConserved']);self.assertEqual(report['status'],'needs_review');self.assertEqual(report['sections'],[])
 def test_process_lock_rejects_reentry(self):
  with tempfile.TemporaryDirectory() as directory:
   lock=pathlib.Path(directory)/'fetch.lock'
   with module.OutputLock(lock):
    with self.assertRaisesRegex(module.SourceError,'locked'):
     with module.OutputLock(lock):pass
 def test_resume_same_inventory_without_retry(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);inventory=root/'inventory.ndjson';out=root/'out'
   inventory.write_text(json.dumps({'fullLicense':'x','sources':[{'sourceUrl':'https://mcp.fda.gov.tw/insert/pdfcase'}]})+'\n',encoding='utf8')
   command=[sys.executable,'-X','utf8',str(ROOT/'tools/fetch-tfda-sources.py'),'--inventory',str(inventory),'--output',str(out),'--limit','1']
   first=subprocess.run(command,capture_output=True,text=True);second=subprocess.run(command,capture_output=True,text=True)
   self.assertEqual(first.returncode,0,first.stderr);self.assertEqual(second.returncode,0,second.stderr)
   self.assertEqual(json.loads((out/'summary.json').read_text())['completedThisRun'],0)
   inventory.write_text(inventory.read_text()+'\n',encoding='utf8')
   third=subprocess.run(command,capture_output=True,text=True)
   self.assertNotEqual(third.returncode,0);self.assertIn('inventory_changed',third.stderr)
 def test_sigint_drains_inflight_and_leaves_remaining_pending(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);inventory=root/'inventory.ndjson';out=root/'out'
   inventory.write_text(json.dumps({'fullLicense':'x','sources':[{'sourceUrl':f'https://mcp.fda.gov.tw/fake-{n}'} for n in range(8)]})+'\n',encoding='utf8')
   old_sigint=signal.getsignal(signal.SIGINT);old_sigterm=signal.getsignal(signal.SIGTERM)
   def slow_source(job,root):
    time.sleep(.4)
    return {'urlHash':job['url_hash'],'sourceUrl':job['url'],'at':module.now(),'status':'failed_test_no_network'}
   timer=threading.Timer(.1,lambda:signal.raise_signal(signal.SIGINT));timer.start()
   try:
    with patch.object(module,'process_source',side_effect=slow_source):
     status=module.main(['--inventory',str(inventory),'--output',str(out),'--all','--workers','2'])
   finally:timer.join();signal.signal(signal.SIGINT,old_sigint);signal.signal(signal.SIGTERM,old_sigterm)
   summary=json.loads((out/'summary.json').read_text())
   self.assertEqual(status,130);self.assertTrue(summary['interrupted']);self.assertEqual(summary['completedThisRun'],2);self.assertEqual(summary['statusCounts']['pending'],6)

def leaflet_document(body, extra='', title='5 警語'):
 return ('<div class="toggle-all"><div class="toggle"><div class="toggle-title"><span class="title-name">'+title+'</span></div><div class="toggle-inner">'+body+'</div></div></div>'+extra).encode()

def export_option_ui(titles, extra='', known_context=True):
 rows=''.join('<div class="toggle"><div class="toggle-title"><input type="checkbox" class="toggle-check"><span class="title-name">'+escape(title)+'</span></div></div>' for title in titles)
 main='<div class="toggle-all">'+rows+extra+'</div>'
 return '<div id="popupExportSelect" class="popup" data_popup="popup-export-select"><form id="exportForm">'+main+'</form></div>' if known_context else main

class HtmlLiteralConservationTests(unittest.TestCase):
 def parse(self,body,extra=''):
  return module.inspect_html(leaflet_document(body,extra),'https://mcp.fda.gov.tw/a')
 def test_simple_table_preserves_empty_cells_and_row_boundaries(self):
  report=self.parse('<table><tr><th>條件</th><th>劑量</th><th></th></tr><tr><td>成人<br>嚴重時</td><td>40</td><td></td></tr></table>')
  table=report['sections'][0]['tables'][0]
  self.assertEqual(table['serializedText'],'條件\t劑量\t\n成人 嚴重時\t40\t')
  self.assertEqual(table['columnCounts'],[3,3]);self.assertTrue(table['simple']);self.assertEqual(report['complexTableCount'],0)
  self.assertTrue(report['fullDomConserved']);self.assertTrue(report['simpleTablesConserved']);self.assertFalse(report['hasUnverifiedNonTextContent'])
  self.assertIn('條件\t劑量\t',report['normalizedSectionText']);self.assertIn('成人 嚴重時\t40\t',report['completeDomText'])
 def assert_matrix(self,rows):
  raw='<table>'+''.join('<tr>'+''.join('<td>'+escape(cell).replace('\n','<br>')+'</td>' for cell in row)+'</tr>' for row in rows)+'</table>'
  report=self.parse(raw);table=report['sections'][0]['tables'][0]
  expected=[[' '.join(cell.split()) for cell in row] for row in rows]
  self.assertTrue(table['simple']);self.assertEqual(table['rowCount'],len(rows));self.assertEqual(table['columnCounts'],[len(row) for row in rows])
  self.assertEqual([row.split('\t') for row in table['serializedText'].split('\n')],expected)
  self.assertEqual(table['originalNormalizedTextSha256'],table['serializedNormalizedTextSha256'])
  self.assertTrue(report['fullDomConserved']);self.assertEqual(report['originalNormalizedDomSha256'],report['serializedNormalizedDomSha256'])
 def test_numeric_dose_matrix_6_by_2_preserves_literal_values(self):
  self.assert_matrix([['前次劑量(mg)','重新開始的劑量(mg)'],['40','20'],['50','20'],['60','30'],['70','30'],['80以上','40']])
 def test_clinical_condition_matrix_4_by_4_preserves_cell_internal_breaks(self):
  self.assert_matrix([['出血類型','≥12 歲青少年/成人劑量 (IU/kg)','<12 歲兒童劑量 (IU/kg)','額外劑量'],['輕度\n初期關節血腫','40','65','1 劑應即足夠'],['中度\n肌肉出血','40','65','24 小時後額外施用'],['重度\n危及生命的出血','50','65','每 24 小時施用']])
 def test_frequency_matrix_6_by_6_preserves_leading_and_trailing_empty_cells(self):
  self.assert_matrix([['系統','常見','不常見','罕見','未知',''],['A','1','','','',''],['B','','2','','',''],['C','','','3','',''],['D','','','','4',''],['E','','','','','5']])
 def test_rowspan_and_colspan_remain_review(self):
  for span in ('rowspan','colspan'):
   with self.subTest(span=span):
    report=self.parse('<table><tr><td '+span+'="2">條件</td><td>40</td></tr></table>')
    self.assertTrue(report['fullDomConserved']);self.assertTrue(report['hasUnverifiedNonTextContent']);self.assertGreater(report['complexTableCount'],0)
    self.assertIn(span,report['sections'][0]['tables'][0]['complexReasons'])
 def test_nonempty_nested_tables_remain_review(self):
  report=self.parse('<table><tr><td>條件<table><tr><td>成人</td><td>40</td></tr></table></td></tr></table>')
  self.assertTrue(report['fullDomConserved']);self.assertTrue(report['hasUnverifiedNonTextContent']);self.assertIn('nested_table',report['sections'][0]['tables'][0]['complexReasons'])
 def test_ragged_rows_are_not_inferred_or_filled(self):
  report=self.parse('<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>');table=report['sections'][0]['tables'][0]
  self.assertEqual(table['columnCounts'],[2,1]);self.assertEqual(table['serializedText'],'A\tB\nC')
  self.assertIn('ragged_column_count',table['complexReasons']);self.assertTrue(report['hasUnverifiedNonTextContent'])
 def test_verified_zero_content_layout_placeholder_is_accounted(self):
  report=self.parse('<table class="sub-table"><tr><td>5.1</td><td>患者條件<table class="sub-table"><tbody></tbody></table></td></tr></table>')
  self.assertEqual(report['emptyLayoutTableCount'],1);self.assertEqual(report['complexTableCount'],0)
  self.assertTrue(report['fullDomConserved']);self.assertFalse(report['hasUnverifiedNonTextContent']);self.assertIn('5.1\t患者條件',report['normalizedSectionText'])
 def test_nontext_table_is_never_empty_layout_placeholder(self):
  report=self.parse('<table><tr><td><img src="/graph.png"></td></tr></table>')
  self.assertTrue(report['hasUnverifiedNonTextContent']);self.assertTrue(report['hasNonTextContent']);self.assertEqual(report['emptyLayoutTableCount'],0)
 def test_unaccounted_second_main_with_new_body_blocks_full_dom(self):
  report=self.parse('原有警語','<div class="toggle-all"><p>新發現孕婦禁用條件</p></div>')
  self.assertEqual(report['unaccountedMainBlockCount'],1);self.assertFalse(report['allMainBlocksAccounted']);self.assertFalse(report['fullDomConserved']);self.assertEqual(report['status'],'needs_review')
 def test_second_complete_body_is_ambiguous_and_blocks(self):
  report=module.inspect_html(leaflet_document('原有警語')+leaflet_document('新增禁忌'),'https://mcp.fda.gov.tw/a')
  self.assertEqual(report['bodyCandidateCount'],2);self.assertFalse(report['fullDomConserved']);self.assertGreater(report['unaccountedMainBlockCount'],0)
 def test_real_export_ui_shape_can_duplicate_retained_titles(self):
  report=self.parse('原有警語',export_option_ui(['5 警語','製造廠','藥商']))
  self.assertEqual(report['unaccountedMainBlockCount'],0);self.assertTrue(report['allMainBlocksAccounted']);self.assertTrue(report['fullDomConserved'])
  ignored=report['ignoredMainBlocks'][0]
  self.assertEqual(ignored['classification'],'verified_export_pdf_option_list');self.assertEqual(ignored['checkboxCount'],3)
  self.assertEqual(len(ignored['normalizedTextSha256']),64);self.assertEqual(ignored['retainedSectionTitleCount'],1)
 def test_duplicate_titles_without_verified_export_context_block(self):
  report=self.parse('原有警語',export_option_ui(['5 警語'],known_context=False))
  self.assertFalse(report['fullDomConserved']);self.assertEqual(report['unaccountedMainBlockCount'],1)
 def test_export_modal_with_additional_text_blocks(self):
  report=self.parse('原有警語',export_option_ui(['5 警語'],extra='<div>額外未保留正文</div>'))
  self.assertFalse(report['fullDomConserved']);self.assertEqual(report['unaccountedMainBlockCount'],1)
 def test_export_modal_with_new_title_blocks(self):
  report=self.parse('原有警語',export_option_ui(['5 警語','新禁忌']))
  self.assertFalse(report['fullDomConserved']);self.assertEqual(report['unaccountedMainBlockCount'],1)
 def test_empty_layout_main_is_explicitly_accounted(self):
  report=self.parse('原有警語','<div class="toggle-all"><span> </span></div>')
  self.assertTrue(report['fullDomConserved']);self.assertEqual(report['ignoredMainBlocks'][0]['classification'],'verified_empty_layout_block')
 def test_text_outside_retained_section_blocks_conservation(self):
  raw=leaflet_document('原有警語').decode().replace('<div class="toggle-all">','<div class="toggle-all"><p>未保留內容</p>',1)
  report=module.inspect_html(raw.encode(),'https://mcp.fda.gov.tw/a');self.assertFalse(report['fullDomConserved'])
 def test_hidden_html_reparse_binds_sha_and_bytes_to_actual_input(self):
  with tempfile.TemporaryDirectory() as directory:
   source=pathlib.Path(directory)/'leaflet.html';raw=leaflet_document('完整警語',export_option_ui(['5 警語']));source.write_bytes(raw)
   run=subprocess.run([sys.executable,'-X','utf8',str(ROOT/'tools/fetch-tfda-sources.py'),'--inspect-html-internal',str(source),'https://mcp.fda.gov.tw/a'],capture_output=True,check=True)
   report=json.loads(run.stdout)
   self.assertEqual(report['schemaVersion'],4);self.assertEqual(report['parserVersion'],'tfda-complete-dom-v4');self.assertEqual(report['rawSha256'],module.sha_bytes(raw));self.assertEqual(report['rawBytes'],len(raw));self.assertEqual(report['sourceUrl'],'https://mcp.fda.gov.tw/a');self.assertTrue(report['fullDomConserved']);self.assertEqual(run.stderr,b'')
 def test_hidden_pdf_keeps_physical_blank_pages_and_same_byte_hash(self):
  from pypdf import PdfWriter
  with tempfile.TemporaryDirectory() as directory:
   source=pathlib.Path(directory)/'leaflet.pdf';writer=PdfWriter();writer.add_blank_page(612,792);writer.add_blank_page(612,792)
   with source.open('wb') as stream:writer.write(stream)
   raw=source.read_bytes();run=subprocess.run([sys.executable,'-X','utf8',str(ROOT/'tools/fetch-tfda-sources.py'),'--inspect-pdf-internal',str(source)],capture_output=True,check=True)
   report=json.loads(run.stdout)
   self.assertEqual(report['rawSha256'],module.sha_bytes(raw));self.assertEqual(report['rawBytes'],len(raw));self.assertEqual(report['physicalPageCount'],2);self.assertEqual([p['page'] for p in report['pages']],[1,2]);self.assertTrue(all(p['text']=='' and not p['imageLarge'] for p in report['pages']));self.assertEqual(report['status'],'needs_review')

class GeometryPage:
 def __init__(self,words=(),lines=(),rects=(),curves=(),images=(),tables=()):
  self.words=list(words);self.lines=list(lines);self.rects=list(rects);self.curves=list(curves);self.images=list(images);self.tables=list(tables)
  self.chars=[{'upright':True} for word in words for char in word['text']]
 def extract_words(self,**unused):return self.words
 def find_tables(self):return self.tables

def bbox_word(text,x,y,width=60,height=10):return {'text':text,'x0':x,'x1':x+width,'top':y,'bottom':y+height}

def synthetic_layout_pdf(grid=False):
 """Tiny synthetic PDF fixture; no authoring/renderer/external font dependency."""
 from pypdf import PdfWriter
 from pypdf.generic import DictionaryObject,NameObject,DecodedStreamObject
 writer=PdfWriter();page=writer.add_blank_page(600,800)
 font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
 page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
 commands=[]
 for row in range(4 if grid else 6):
  y=685-row*20 if grid else 720-row*18
  for x,text in [(60,'Left'+str(row)),(190 if grid else 330,'Right'+str(row))]:commands.append(f'BT /F1 10 Tf 1 0 0 1 {x} {y} Tm ({text}) Tj ET')
 if grid:
  for y in range(620,701,20):commands.append(f'50 {y} m 330 {y} l S')
  for x in [50,180,330]:commands.append(f'{x} 620 m {x} 700 l S')
 stream=DecodedStreamObject();stream.set_data('\n'.join(commands).encode());page[NameObject('/Contents')]=writer._add_object(stream)
 output=io.BytesIO();writer.write(output);return output.getvalue()

class PdfStructureTests(unittest.TestCase):
 def assess(self,page,text=None):
  if text is None:text=' '.join(word['text'] for word in page.words)
  return module.inspect_pdf_structure(page,600,800,text)
 def test_simple_paragraph_has_explicit_no_detected_structure(self):
  words=[bbox_word('Single',50,50,35),bbox_word('flow',90,50,25),bbox_word('paragraph',120,50,60),bbox_word('continues',50,70,55),bbox_word('inline',110,70,30),bbox_word('here',145,70,25)]
  flagged,evidence=self.assess(GeometryPage(words))
  self.assertFalse(flagged);self.assertEqual(evidence['status'],'single_flow_no_detected_structure');self.assertEqual(evidence['reasons'],[]);self.assertEqual(evidence['wordCharacterCoverage'],1.0)
 def test_vector_grid_is_review_even_with_no_bitmap_images(self):
  lines=[{'x0':50,'x1':330,'top':y,'bottom':y} for y in [50,70,90]]+[{'x0':x,'x1':x,'top':50,'bottom':90}for x in [50,180,330]]
  words=[bbox_word('A',60,55),bbox_word('B',190,55),bbox_word('C',60,75),bbox_word('D',190,75)]
  flagged,evidence=self.assess(GeometryPage(words,lines=lines))
  self.assertTrue(flagged);self.assertIn('pdf_vector_grid_detected',evidence['reasons']);self.assertGreaterEqual(evidence['vectorGridIntersectionCount'],6)
 def test_detected_table_is_review(self):
  table=type('Table',(),{'bbox':(50,50,330,100),'rows':[1,2],'columns':[1,2],'cells':[1,2,3,4]})()
  flagged,evidence=self.assess(GeometryPage([bbox_word('A',50,50)],tables=[table]))
  self.assertTrue(flagged);self.assertIn('pdf_table_detected',evidence['reasons']);self.assertEqual(evidence['tables'][0]['rowCount'],2)
 def test_borderless_columns_with_aligned_baselines_are_review(self):
  words=[bbox_word('L'+str(i),50,50+i*20,80) for i in range(4)]+[bbox_word('R'+str(i),330,50+i*20,80)for i in range(4)]
  flagged,evidence=self.assess(GeometryPage(words))
  self.assertTrue(flagged);self.assertIn('pdf_repeated_column_gap_detected',evidence['reasons']);self.assertTrue(evidence['columnEvidence'])
 def test_borderless_columns_with_offset_baselines_are_review(self):
  words=[bbox_word('L'+str(i),50,50+i*20,80) for i in range(4)]+[bbox_word('R'+str(i),330,57+i*20,80)for i in range(4)]
  flagged,evidence=self.assess(GeometryPage(words))
  self.assertTrue(flagged);self.assertIn('pdf_global_column_gutter_detected',evidence['reasons'])
 def test_missing_or_invalid_geometry_fails_closed(self):
  self.assertTrue(module.inspect_pdf_structure(None,600,800,'source text')[0])
  page=GeometryPage([{'text':'invalid','x0':50}]);flagged,evidence=self.assess(page)
  self.assertTrue(flagged);self.assertIn('pdf_structure_analysis_failed',evidence['reasons'])
 def test_missing_word_coverage_fails_closed(self):
  flagged,evidence=self.assess(GeometryPage([bbox_word('A',50,50)]),'A missing B')
  self.assertTrue(flagged);self.assertIn('pdf_structure_coverage_uncertain',evidence['reasons'])
 def test_detector_exception_fails_closed(self):
  page=GeometryPage([bbox_word('A',50,50)])
  with patch.object(page,'find_tables',side_effect=ValueError('synthetic detector failure')):flagged,evidence=self.assess(page)
  self.assertTrue(flagged);self.assertIn('pdf_structure_analysis_failed',evidence['reasons'])
 def test_unclassified_curve_and_rotated_text_are_review(self):
  page=GeometryPage([bbox_word('A',50,50)],curves=[{'x0':20,'x1':100,'top':30,'bottom':80}]);page.chars[0]['upright']=False
  flagged,evidence=self.assess(page)
  self.assertTrue(flagged);self.assertIn('pdf_unclassified_vector_path',evidence['reasons']);self.assertIn('pdf_rotated_text_structure_uncertain',evidence['reasons'])
 def test_empty_physical_page_can_have_explicit_clear_structure(self):
  flagged,evidence=self.assess(GeometryPage())
  self.assertFalse(flagged);self.assertEqual(evidence['status'],'empty_page_no_structure')
 def test_single_outer_page_frame_is_not_a_subdivided_grid(self):
  flagged,evidence=self.assess(GeometryPage(rects=[{'x0':10,'x1':590,'top':10,'bottom':790}]))
  self.assertFalse(flagged);self.assertEqual(evidence['ignoredPageFrameRectCount'],1)
 def test_textless_image_page_structure_is_unknown(self):
  flagged,evidence=self.assess(GeometryPage(images=[{'x0':0,'x1':600,'top':0,'bottom':800}]))
  self.assertTrue(flagged);self.assertIn('pdf_textless_nonempty_page_structure_unknown',evidence['reasons'])
 def test_real_pdf_grid_structure_blocks_despite_equal_extracted_text(self):
  report=module.inspect_pdf_direct(synthetic_layout_pdf(grid=True));page=report['pages'][0]
  self.assertTrue(page['allEnginesAgreeAfterWhitespaceNfkc']);self.assertEqual(page['imageCount'],0)
  self.assertTrue(page['hasUnverifiedStructure']);self.assertEqual(report['status'],'needs_review')
  self.assertTrue(any(reason in page['structureEvidence']['reasons'] for reason in ('pdf_table_detected','pdf_vector_grid_detected')))
 def test_real_borderless_pdf_structure_blocks_despite_equal_extracted_text(self):
  report=module.inspect_pdf_direct(synthetic_layout_pdf());page=report['pages'][0]
  self.assertTrue(page['allEnginesAgreeAfterWhitespaceNfkc']);self.assertEqual(page['imageCount'],0)
  self.assertTrue(page['hasUnverifiedStructure']);self.assertEqual(report['status'],'needs_review')
  self.assertTrue(any('gutter' in reason or 'column_gap' in reason for reason in page['structureEvidence']['reasons']))

class ActiveArchiveExtractionTests(unittest.TestCase):
 def database(self,path):
  database=sqlite3.connect(path);database.execute('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');return database
 def active_file(self,path,url='https://mcp.fda.gov.tw/active',**changes):
  source={'sourceUrl':url,'sourceKeySha256':module.sha_bytes(url.encode())};item={'fullLicense':'衛部藥製字第999991號','active':True,'sources':[source]};item.update(changes)
  path.write_text(json.dumps(item,ensure_ascii=False)+'\n',encoding='utf8');return item
 def test_policy_hashes_are_computed_from_actual_file_and_urls(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);active=root/'active.ndjson';self.active_file(active);database=self.database(root/'checkpoint.sqlite3')
   hashes,policy=module.bind_active_extraction_policy(database,active)
   self.assertEqual(policy['inventorySha256'],module.sha_file(active));self.assertEqual(hashes,{module.sha_bytes(b'https://mcp.fda.gov.tw/active')});self.assertEqual(policy['urlCount'],1)
   saved=dict(database.execute('select key,value from meta'));self.assertEqual(saved['active_extraction_inventory_sha256'],module.sha_file(active));database.close()
 def test_changed_active_inventory_cannot_reuse_old_checkpoint_binding(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);active=root/'active.ndjson';self.active_file(active);database=self.database(root/'checkpoint.sqlite3');module.bind_active_extraction_policy(database,active)
   self.active_file(active,url='https://mcp.fda.gov.tw/different')
   with self.assertRaisesRegex(module.SourceError,'active_extraction_inventory_changed'):module.bind_active_extraction_policy(database,active)
   database.close()
 def test_bound_policy_cannot_be_omitted_on_resume(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);active=root/'active.ndjson';self.active_file(active);database=self.database(root/'checkpoint.sqlite3');module.bind_active_extraction_policy(database,active)
   with self.assertRaisesRegex(module.SourceError,'flag_required'):module.bind_active_extraction_policy(database,None)
   database.close()
 def test_forged_declared_source_hash_cannot_mark_other_url_active(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);active=root/'active.ndjson';self.active_file(active,sources=[{'sourceUrl':'https://mcp.fda.gov.tw/actual','sourceKeySha256':'0'*64}]);database=self.database(root/'checkpoint.sqlite3')
   with self.assertRaisesRegex(module.SourceError,'source_key_hash_mismatch'):module.bind_active_extraction_policy(database,active)
   self.assertEqual(database.execute('select count(*) from meta').fetchone()[0],0);database.close()
 def test_nonactive_row_is_not_a_valid_active_inventory(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);active=root/'active.ndjson';self.active_file(active,active=False);database=self.database(root/'checkpoint.sqlite3')
   with self.assertRaisesRegex(module.SourceError,'nonactive'):module.bind_active_extraction_policy(database,active)
   database.close()
 def test_archive_raw_download_never_calls_pdf_or_html_inspection(self):
  for raw,kind in [(b'%PDF-synthetic-raw','pdf'),(b'<html>archive source</html>','html')]:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as directory:
    root=pathlib.Path(directory);job={'url_hash':module.sha_bytes(kind.encode()),'url':'https://mcp.fda.gov.tw/archive-'+kind,'rawOnlyArchive':True,'activeExtractionPolicy':{'inventorySha256':'a'*64,'urlSetSha256':'b'*64}}
    metadata={'finalUrl':job['url'],'httpStatus':200,'contentType':'application/pdf'if kind=='pdf'else'text/html','redirects':[]}
    with patch.object(module,'fetch_bounded',return_value=(raw,metadata)),patch.object(module,'inspect_pdf',side_effect=AssertionError('archive must not inspect PDF')),patch.object(module,'inspect_html',side_effect=AssertionError('archive must not inspect HTML')):
     result=module.process_source(job,root)
    self.assertEqual(result['status'],'downloaded_archive_raw');self.assertTrue(result['rawOnlyArchive']);self.assertEqual(result['sourceType'],kind);self.assertEqual(result['sourceBlobSha256'],module.sha_bytes(raw));self.assertIsNone(result['extractionPath']);self.assertIsNone(result['parserVersion']);self.assertFalse(result['publicationEligible'])
    self.assertEqual((root/result['blobPath']).read_bytes(),raw)
 def test_cached_archive_reextract_reuses_raw_and_never_inspects(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);blob=root/'raw.html';blob.write_bytes(b'<html>archive</html>');url='https://mcp.fda.gov.tw/archive';key=module.sha_bytes(url.encode())
   module.write_json(root/'records'/(key+'.json'),{'sourceUrl':url,'sourceBlobSha256':module.sha_file(blob),'blobPath':blob.name,'finalUrl':url,'contentType':'text/html','httpStatus':200,'redirects':[],'rawOnlyArchive':True})
   with patch.object(module,'fetch_bounded',side_effect=AssertionError('no network')),patch.object(module,'inspect_html',side_effect=AssertionError('no extraction')):
    result=module.process_source({'url_hash':key,'url':url,'reextractOnly':True,'rawOnlyArchive':True},root)
   self.assertEqual(result['attempts'],0);self.assertEqual(result['status'],'downloaded_archive_raw');self.assertTrue(result['resumedVerifiedRawCheckpoint'])
 def test_shared_active_and_archive_url_always_normal_extracts(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);active=root/'active.ndjson';item=self.active_file(active);url=item['sources'][0]['sourceUrl'];inventory=root/'all.ndjson';archive_only='https://mcp.fda.gov.tw/archive-only'
   inventory.write_text('\n'.join(json.dumps(row)for row in [item,{'fullLicense':'衛署藥製字第999992號','active':False,'sources':[{'sourceUrl':url},{'sourceUrl':archive_only}]}])+'\n',encoding='utf8');seen={}
   def worker(job,output):
    seen[job['url']]=job['rawOnlyArchive'];return {'urlHash':job['url_hash'],'sourceUrl':job['url'],'at':module.now(),'status':'failed_synthetic_no_network'}
   old_int=signal.getsignal(signal.SIGINT);old_term=signal.getsignal(signal.SIGTERM)
   try:
    with patch.object(module,'process_source',side_effect=worker),contextlib.redirect_stdout(io.StringIO()):
     result=module.main(['--inventory',str(inventory),'--output',str(root/'output'),'--extract-active-from',str(active),'--limit','5'])
   finally:signal.signal(signal.SIGINT,old_int);signal.signal(signal.SIGTERM,old_term)
   self.assertEqual(result,0);self.assertEqual(seen,{url:False,archive_only:True})

if __name__=='__main__':unittest.main(verbosity=2)
