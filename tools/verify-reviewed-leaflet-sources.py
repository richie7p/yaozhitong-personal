"""Read official TFDA sources only; no cloud credentials, models or writes."""
from html.parser import HTMLParser
import pathlib, json, re, hashlib, datetime, urllib.request, urllib.parse, argparse, io, zipfile
from concurrent.futures import ThreadPoolExecutor

cli = argparse.ArgumentParser(description='Verify complete reviewed leaflet content against current official TFDA sources; no cloud writes.')
cli.add_argument('--manifest', required=True)
cli.add_argument('--output', required=True)
args = cli.parse_args()
manifest_path = pathlib.Path(args.manifest).resolve()
root = manifest_path.parent
output = pathlib.Path(args.output).resolve()
manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
def source_path(value):
 p=pathlib.Path(value)
 return p if p.is_absolute() else root/p
sha = lambda b: hashlib.sha256(b).hexdigest()
norm = lambda s: re.sub(r'\s+', '', __import__('unicodedata').normalize('NFKC', s))

class Node:
 def __init__(self, tag='', attrs=()): self.tag=tag; self.attrs=dict(attrs); self.children=[]
 def has(self, cls): return cls in self.attrs.get('class','').split()
 def walk(self):
  yield self
  for c in self.children:
   if isinstance(c,Node): yield from c.walk()
 def text(self):
  def raw(n):
   if isinstance(n,str): return n
   if n.tag in ('script','style'): return ''
   return ''.join(raw(c) for c in n.children)+ ('\n' if n.tag in ('p','tr','div','br','h1','h2','h3','li') else ' ' if n.tag in ('td','th') else '')
  return '\n'.join(s for line in raw(self).splitlines() if (s:=re.sub(r'\s+',' ',line).strip()))
class Parser(HTMLParser):
 def __init__(self): super().__init__(convert_charrefs=True); self.root=Node(); self.stack=[self.root]
 def handle_starttag(self,tag,attrs):
  n=Node(tag,attrs); self.stack[-1].children.append(n)
  if tag not in ('area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'): self.stack.append(n)
 def handle_endtag(self,tag):
  for i in range(len(self.stack)-1,0,-1):
   if self.stack[i].tag==tag: self.stack=self.stack[:i]; break
 def handle_data(self,d): self.stack[-1].children.append(d)

def html_canonical(raw, item):
 p=Parser(); p.feed(raw.decode('utf-8'))
 main=[n for n in p.root.walk() if n.has('toggle-all')][0]
 sections=[n for n in main.children if isinstance(n,Node) and n.has('toggle')]
 parts=[]
 for n in sections:
  title=next(c for c in n.walk() if c.has('title-name')).text()
  body=next(c for c in n.walk() if c.has('toggle-inner')).text()
  assert body, 'empty_section'
  parts.append(title+'\n'+body)
 text='\n\n'.join(parts)
 assert norm(main.text())==norm(text), 'main_text_missing'
 fields={}
 for n in p.root.walk():
  if n.has('page_name'):
   labels=[x for x in n.children if isinstance(x,Node) and x.tag=='label']
   values=[x for x in n.children if isinstance(x,Node) and x.tag=='span']
   if len(labels)==1 and len(values)==1: fields[labels[0].text()]=values[0].text()
 draft=json.loads(source_path(item['draftPath']).read_text(encoding='utf-8'))
 expected=draft['chunks'][0]['text']
 prefix=expected.split('\n\n',1)[0]
 assert norm(fields['許可證號'])==norm(item['licenseNo']), 'html_license_changed'
 for k, line in zip(['中文品名','英文品名','許可證號','藥品類別'],prefix.splitlines()):
  assert norm(fields[k])==norm(line), 'html_identity_changed_'+k
 assert not [n for n in main.walk() if n.tag=='img'], 'html_non_text_image_present'
 return prefix+'\n\n'+text+'\n',len(sections)

def fetch_one(item):
 result={'code':item['code'],'sourceUrl':item['sourceUrl'],'sourceFormat':item['sourceFormat']}
 try:
  url=urllib.parse.quote(item['sourceUrl'],safe=':/?=&%')
  req=urllib.request.Request(url,headers={'User-Agent':'Yaozhitong-source-verification/1.0'})
  with urllib.request.urlopen(req,timeout=25) as r:
   final=r.geturl(); status=r.status; ct=r.headers.get('Content-Type',''); raw=r.read(15000001)
  host=urllib.parse.urlparse(final).hostname
  assert final.startswith('https://') and (host=='fda.gov.tw' or host.endswith('.fda.gov.tw')), 'nonofficial_redirect'
  assert status==200 and 0<len(raw)<=15000000, 'invalid_official_response'
  result.update(httpStatus=status,finalUrl=final,contentType=ct,bytes=len(raw),retrievedSha256=sha(raw),rawHashMatchesFrozen=sha(raw)==item['sha256'])
  if item['sourceFormat']=='pdf':
   assert raw.startswith(b'%PDF-'), 'official_source_not_pdf'
   assert sha(raw)==item['sha256'], 'official_pdf_changed_requires_new_review'
   if item.get('indexPdfUrl') and item['indexPdfUrl']!=item['sourceUrl']:
    # TFDA's exportpdf endpoint is a redirect/generation entry point. Its
    # observed official current detail destination is queried directly here;
    # the independent fresh InfoId39 check still pins the index entry itself.
    current_page=item['indexPdfUrl'].replace('/exportpdf/','/im_detail_1/')+'?export=opendata'
    current_request=urllib.request.Request(urllib.parse.quote(current_page,safe=':/?=&%'),headers={'User-Agent':'Yaozhitong-source-verification/1.0'})
    with urllib.request.urlopen(current_request,timeout=25) as current_response:
     current_url=current_response.geturl(); current_raw=current_response.read(15_000_001)
    current_host=urllib.parse.urlparse(current_url).hostname
    assert current_url.startswith('https://') and current_host and current_host.endswith('.fda.gov.tw'), 'nonofficial_current_page_redirect'
    current=Parser(); current.feed(current_raw.decode('utf-8'))
    assert any(n.has('page_name') and norm(item['licenseNo']) in norm(n.text()) for n in current.root.walk()), 'current_paper_page_license_mismatch'
    paper=[n for n in current.root.walk() if n.has('popup') and any(c.has('pagetitle') and c.text()=='紙本仿單樣式(自行上傳)' for c in n.walk())]
    assert len(paper)==1, 'current_paper_leaflet_group_ambiguous'
    assert any(n.tag=='a' and urllib.parse.urljoin(current_url,n.attrs.get('href',''))==item['sourceUrl'] for n in paper[0].walk()), 'paper_source_not_listed_as_current'
    result['currentOfficialPaperLinkVerified']=True
   result['verifiedFrozenSourceStillCurrent']=True
  else:
   frozen=source_path(item['rawSourcePath']).read_bytes()
   frozen_text,_=html_canonical(frozen,item)
   assert sha(frozen_text.encode())==item['canonicalTextSha256'], 'frozen_html_parser_mismatch'
   text,sections=html_canonical(raw,item)
   result.update(canonicalTextSha256=sha(text.encode()),sections=sections)
   assert sha(text.encode())==item['canonicalTextSha256'], 'official_html_content_changed_requires_new_review'
   result['verifiedFrozenSourceStillCurrent']=True
  result['status']='passed'
 except Exception as e:
  # Never include response HTML, tokens, cookie headers or credential material.
  result['status']='failed'; result['errorType']=type(e).__name__
  result['errorCode']=str(e) if isinstance(e,AssertionError) else 'official_fetch_or_parse_failed'
 return result

def fetch_index(info_id):
 url=f'https://data.fda.gov.tw/opendata/exportDataList.do?method=ExportData&InfoId={info_id}&logType=5'
 with urllib.request.urlopen(url,timeout=45) as response:
  final=response.geturl(); host=urllib.parse.urlparse(final).hostname
  assert final.startswith('https://') and host and (host=='fda.gov.tw' or host.endswith('.fda.gov.tw')), 'official_index_redirect_mismatch'
  raw=response.read(150_000_001)
 assert len(raw)<=150_000_000, 'official_index_size_limit'
 if raw.startswith(b'PK'):
  with zipfile.ZipFile(io.BytesIO(raw)) as archive:
   names=[name for name in archive.namelist() if name.lower().endswith('.json')]
   assert len(names)==1, 'official_index_json_ambiguous'
   assert archive.getinfo(names[0]).file_size<=150_000_000, 'official_index_expanded_size_limit'
   raw=archive.read(names[0])
 return json.loads(raw.decode('utf-8-sig')),{'url':url,'jsonSha256':sha(raw)}

with ThreadPoolExecutor(max_workers=4) as pool: results=list(pool.map(fetch_one,manifest['items']))
index_status='passed'; index_error=None; index_evidence=[]
try:
 with ThreadPoolExecutor(max_workers=2) as pool:
  catalog_future=pool.submit(fetch_index,36); leaflet_future=pool.submit(fetch_index,39)
  catalog,catalog_evidence=catalog_future.result(); leaflet_index,leaflet_evidence=leaflet_future.result()
 index_evidence=[catalog_evidence,leaflet_evidence]
 today=datetime.datetime.now(datetime.UTC).date().isoformat().replace('-','/')
 for item,result in zip(manifest['items'],results):
  current=[row for row in catalog if row['許可證字號']==item['licenseNo']]
  indexed=[row for row in leaflet_index if row['許可證字號']==item['licenseNo']]
  assert len(current)==1 and len(indexed)==1, 'official_current_license_ambiguous'
  current=current[0]; indexed=indexed[0]
  assert not current.get('註銷狀態') and current['有效日期']>today, 'license_revoked_or_expired'
  assert norm(current['中文品名'])==norm(item['nameZh']) and norm(current['英文品名'])==norm(item['nameEn']), 'official_product_identity_changed'
  assert norm(current['劑型'])==norm(item['form']), 'official_product_form_changed'
  assert current['製造商名稱']==item['catalogVerifiedFromSnapshot']['manufacturer'], 'official_product_manufacturer_changed'
  assert indexed.get('仿單圖檔連結')==item['indexPdfUrl'], 'official_leaflet_index_url_changed'
  result.update(currentOfficialLicenseVerified=True,currentOfficialIndexVerified=True,currentEffectiveUntil=current['有效日期'],currentManufacturer=current['製造商名稱'])
except Exception as error:
 index_status='failed'
 index_error=str(error) if isinstance(error,AssertionError) else 'official_index_fetch_or_parse_failed'
report={'checkedAt':datetime.datetime.now(datetime.UTC).isoformat(),'manifestSha256':sha(manifest_path.read_bytes()),'status':'passed' if index_status=='passed' and all(r['status']=='passed' for r in results) else 'failed','networkScope':'official_TFDA_HTTPS_only','currentOfficialIndexesStatus':index_status,'currentOfficialIndexesError':index_error,'currentOfficialIndexes':index_evidence,'cloudCalls':0,'cloudWrites':0,'aiCalls':0,'items':results}
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'status':report['status'],'report':str(output),'items':[{'code':r['code'],'status':r['status'],'errorCode':r.get('errorCode'),'rawHashMatchesFrozen':r.get('rawHashMatchesFrozen')} for r in results]},ensure_ascii=True))
raise SystemExit(0 if report['status']=='passed' else 1)
