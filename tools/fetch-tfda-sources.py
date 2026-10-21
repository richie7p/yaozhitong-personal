"""Resumable, local-only TFDA source acquisition and independent text evidence.

No credentials/.env, cloud writes, models, publication or clinical review.
The inventory is immutable for an output directory. --limit limits attempted
unique URLs per invocation; successful URLs are hash-verified and never fetched
again. --retry-failed explicitly permits a later retry of exhausted failures.
"""
from __future__ import annotations
import argparse, concurrent.futures, contextlib, datetime, hashlib, html.parser
import collections, io, json, math, os, pathlib, re, signal, socket, sqlite3, statistics, subprocess, sys, tempfile, threading
import time, unicodedata, urllib.error, urllib.parse, urllib.request

MAX_BYTES = 15_000_000
TIMEOUT_SECONDS = 25
MAX_ATTEMPTS = 2
MAX_REDIRECTS = 5
PDF_PARSER_VERSION = 'tfda-pdf-independent-v3'
PDF_STRUCTURE_VERSION = 'tfda-pdf-structure-v1'
PDF_PARSE_DEADLINE_SECONDS = 45
PAGE_TEXT_LIMIT = 22000

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha_bytes(raw): return hashlib.sha256(raw).hexdigest()
def sha_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for data in iter(lambda: stream.read(262144), b''): h.update(data)
    return h.hexdigest()
def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name+'.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

class SourceError(Exception): pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None

def validate_official_https(url):
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or '').lower()
    if parsed.scheme.lower() != 'https' or not (host == 'fda.gov.tw' or host.endswith('.fda.gov.tw')):
        raise SourceError('nonofficial_or_nonhttps_url')
    if parsed.username is not None or parsed.password is not None:
        raise SourceError('url_userinfo_not_allowed')
    if parsed.port not in (None, 443): raise SourceError('nonstandard_port_not_allowed')
    return urllib.parse.quote(url, safe=':/?=&%+;,@!$\'()*-._~')

def is_placeholder(url, disposition=''):
    p = urllib.parse.urlsplit(url)
    return p.path.rstrip('/').lower() in ('/insert/pdfcase', '/insert/pdfcasefile') or 'unresolved' in disposition.lower() or 'placeholder' in disposition.lower()

def fetch_bounded(url):
    """Validate before every request; never follow even an official HTTP hop."""
    start = time.monotonic(); redirects = []; current = url
    opener = urllib.request.build_opener(NoRedirect())
    for hop in range(MAX_REDIRECTS+1):
        quoted = validate_official_https(current)
        remaining = TIMEOUT_SECONDS-(time.monotonic()-start)
        if remaining <= 0: raise SourceError('download_deadline_exceeded')
        request = urllib.request.Request(quoted, headers={'User-Agent':'Yaozhitong-TFDA-local-source-audit/1.0','Accept-Encoding':'identity'})
        try:
            response = opener.open(request, timeout=max(0.1, remaining))
        except urllib.error.HTTPError as error:
            if error.code in (301,302,303,307,308):
                location = error.headers.get('Location')
                error.close()
                if not location: raise SourceError('redirect_missing_location')
                destination = urllib.parse.urljoin(current, location)
                # Validate BEFORE contacting the destination. Downgrades remain unresolved.
                validate_official_https(destination)
                redirects.append({'from':current,'to':destination,'httpStatus':error.code})
                current = destination
                continue
            code = error.code; error.close(); raise SourceError('download_http_'+str(code)) from None
        with response:
            status = response.status
            if status != 200: raise SourceError('unexpected_http_'+str(status))
            declared = response.headers.get('Content-Length')
            if declared and declared.isdigit() and int(declared)>MAX_BYTES: raise SourceError('source_exceeds_15mb')
            content_type = response.headers.get('Content-Type','').split(';',1)[0].strip().lower()
            chunks = []; total = 0
            while True:
                remaining = TIMEOUT_SECONDS-(time.monotonic()-start)
                if remaining <= 0: raise SourceError('download_deadline_exceeded')
                # Bound each body read by the same absolute deadline where exposed.
                with contextlib.suppress(AttributeError, OSError): response.fp.raw._sock.settimeout(max(0.1, remaining))
                chunk = response.read(min(65536, MAX_BYTES+1-total))
                if not chunk: break
                chunks.append(chunk); total += len(chunk)
                if total>MAX_BYTES: raise SourceError('source_exceeds_15mb')
            if not total: raise SourceError('empty_response')
            return b''.join(chunks), {'finalUrl':current,'httpStatus':status,'contentType':content_type,'redirects':redirects}
    raise SourceError('too_many_redirects')

class HtmlNode:
    def __init__(self, tag='', attrs=()): self.tag=tag; self.attrs=dict(attrs); self.children=[]; self.parent=None
    def has(self, cls): return cls in self.attrs.get('class','').split()
    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child,HtmlNode): yield from child.walk()
    def text(self):
        def raw(node):
            if isinstance(node,str): return node
            if node.tag in ('script','style'): return ''
            return ''.join(raw(c) for c in node.children)+ ('\n' if node.tag in ('p','tr','div','br','h1','h2','h3','li') else ' ' if node.tag in ('td','th') else '')
        return '\n'.join(s for line in raw(self).splitlines() if (s:=re.sub(r'\s+',' ',line).strip()))
class HtmlParser(html.parser.HTMLParser):
    def __init__(self): super().__init__(convert_charrefs=True); self.root=HtmlNode(); self.stack=[self.root]
    def handle_starttag(self,tag,attrs):
        node=HtmlNode(tag,attrs); node.parent=self.stack[-1]; self.stack[-1].children.append(node)
        if tag not in ('area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'): self.stack.append(node)
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i].tag==tag: self.stack=self.stack[:i]; break
    def handle_data(self,data): self.stack[-1].children.append(data)
def norm(text): return re.sub(r'\s+','',unicodedata.normalize('NFKC',text))
HTML_PARSER_VERSION='tfda-complete-dom-v4'
HTML_TABLE_SERIALIZATION_VERSION='tfda-simple-table-literal-v1'

def html_table_evidence(table):
    """Describe source cells in DOM order; never infer or fill a missing cell."""
    reasons=[];row_nodes=[]
    def empty_layout(node):
        return not norm(node.text()) and not any(n.tag in ('img','svg','canvas','iframe','embed','object') for n in node.walk())
    is_empty=empty_layout(table)
    if any(n.tag=='table' and not empty_layout(n) for n in table.walk() if n is not table):reasons.append('nested_table')
    def collect_rows(parent):
        for child in parent.children:
            if isinstance(child,str):
                if child.strip():reasons.append('text_outside_table_cells')
            elif child.tag=='tr':row_nodes.append(child)
            elif child.tag in ('thead','tbody','tfoot'):collect_rows(child)
            elif child.tag not in ('script','style','col','colgroup') and child.text():reasons.append('unsupported_table_child_'+child.tag)
    collect_rows(table)
    rows=[];literal_rows=[]
    for row in row_nodes:
        cells=[];literal_cells=[]
        for child in row.children:
            if isinstance(child,str):
                if child.strip():reasons.append('text_outside_row_cells')
                continue
            if child.tag not in ('td','th'):
                if child.tag not in ('script','style'):reasons.append('unsupported_row_child_'+child.tag)
                continue
            row_span=child.attrs.get('rowspan','1');column_span=child.attrs.get('colspan','1')
            if row_span!='1':reasons.append('rowspan')
            if column_span!='1':reasons.append('colspan')
            # Internal cell whitespace is collapsed, while literal words/numbers
            # remain unchanged. Only separators between actual cells become tabs.
            literal=' '.join(child.text().split())
            cells.append({'tag':child.tag,'text':child.text(),'serializedCellText':literal,'rowspan':row_span,'colspan':column_span})
            literal_cells.append(literal)
        if not cells:reasons.append('empty_or_unmapped_row')
        rows.append(cells);literal_rows.append(literal_cells)
    column_counts=[len(row) for row in rows]
    if not rows and not is_empty:reasons.append('no_explicit_rows')
    if len(set(column_counts))>1:reasons.append('ragged_column_count')
    serialized='\n'.join('\t'.join(cells) for cells in literal_rows)
    original=table.text();conserved=norm(original)==norm(serialized)
    if not conserved:reasons.append('literal_cell_text_not_conserved')
    return {'text':original,'rows':rows,'rowCount':len(rows),'columnCounts':column_counts,'serializedText':serialized,'kind':'empty_layout_placeholder' if is_empty else 'source_table','simple':bool(rows) and not reasons and not is_empty,'complexReasons':list(dict.fromkeys(reasons)),'literalTextConserved':conserved,'originalNormalizedTextSha256':sha_bytes(norm(original).encode()),'serializedNormalizedTextSha256':sha_bytes(norm(serialized).encode())}

def html_literal_text(node, table_lookup):
    """Use tabs/newlines only for proven simple table cell/row boundaries."""
    def raw(current):
        if isinstance(current,str):return current.replace('\t',' ')
        if current.tag in ('script','style'):return ''
        evidence=table_lookup.get(id(current))
        if current.tag=='table' and evidence and evidence['simple']:
            return '\n'+evidence['serializedText']+'\n'
        suffix='\n' if current.tag in ('p','tr','div','br','h1','h2','h3','li') else ' ' if current.tag in ('td','th') else ''
        return ''.join(raw(child) for child in current.children)+suffix
    lines=[]
    for line in raw(node).splitlines():
        if '\t' in line:
            # Preserve empty leading/trailing cells and the exact cell count.
            lines.append('\t'.join(re.sub(r'\s+',' ',cell).strip() for cell in line.split('\t')))
        elif line.strip():lines.append(re.sub(r'\s+',' ',line).strip())
    return '\n'.join(lines)

def html_account_main_blocks(mains, selected_main, sections):
    """Only the exact known export option UI may duplicate retained headings."""
    evidence=[];ignored=[];unaccounted=0
    expected_titles=[norm(section['title']) for section in sections]
    for index,main in enumerate(mains):
        original=main.text();entry={'index':index,'normalizedTextSha256':sha_bytes(norm(original).encode()),'normalizedCharacters':len(norm(original))}
        if main is selected_main:
            entry['classification']='selected_complete_leaflet_body'
            evidence.append(entry);continue
        if not norm(original) and all(node.tag in ('div','span') for node in main.walk()):
            entry['classification']='verified_empty_layout_block';ignored.append(entry);evidence.append(entry);continue
        ancestors=[];ancestor=main.parent
        while ancestor is not None:ancestors.append(ancestor);ancestor=ancestor.parent
        known_popup=any(node.has('popup') and node.attrs.get('id')=='popupExportSelect' and node.attrs.get('data_popup')=='popup-export-select' for node in ancestors)
        known_form=any(node.tag=='form' and node.attrs.get('id')=='exportForm' for node in ancestors)
        children=[node for node in main.children if isinstance(node,HtmlNode)]
        rows=[];ui_valid=bool(children) and all(node.has('toggle') for node in children)
        for row in children:
            titles=[node for node in row.walk() if node.has('title-name')]
            checkboxes=[node for node in row.walk() if node.tag=='input' and node.attrs.get('type','').lower()=='checkbox']
            allowed_tags=all(node.tag in ('div','span','input','label') for node in row.walk())
            allowed_inputs=all(node.attrs.get('type','').lower()=='checkbox' for node in row.walk() if node.tag=='input')
            if len(titles)!=1 or len(checkboxes)!=1 or not allowed_tags or not allowed_inputs or norm(row.text())!=norm(titles[0].text()):
                ui_valid=False;break
            rows.append(norm(titles[0].text()))
        suffix=rows[len(expected_titles):]
        title_sequence=bool(expected_titles) and rows[:len(expected_titles)]==expected_titles
        known_suffix=suffix in ([],[norm('製造廠')],[norm('藥商')],[norm('製造廠'),norm('藥商')])
        same_whole_text=norm(original)==''.join(rows)
        if known_popup and known_form and ui_valid and title_sequence and known_suffix and same_whole_text:
            entry.update(classification='verified_export_pdf_option_list',exportPopupVerified=True,exportFormVerified=True,checkboxCount=len(rows),retainedSectionTitleCount=len(expected_titles),knownUiSuffix=suffix)
            ignored.append(entry)
        else:
            entry.update(classification='unaccounted_main_block',exportPopupVerified=known_popup,exportFormVerified=known_form,optionStructureVerified=ui_valid,retainedTitleSequenceVerified=title_sequence,knownUiSuffixVerified=known_suffix,wholeTextAccounted=same_whole_text)
            unaccounted+=1
        evidence.append(entry)
    return evidence,ignored,unaccounted
def inspect_html(raw,url):
 parser=HtmlParser();decoded=raw.decode('utf-8-sig',errors='replace');parser.feed(decoded)
 identity_occurrences=[];field_values={}
 for node in parser.root.walk():
  if node.has('page_name'):
   labels=[x for x in node.children if isinstance(x,HtmlNode) and x.tag=='label']
   values=[x for x in node.children if isinstance(x,HtmlNode) and x.tag=='span']
   if len(labels)==len(values)==1:
    key=labels[0].text();value=values[0].text();identity_occurrences.append({'label':key,'value':value});field_values.setdefault(key,[])
    if value not in field_values[key]:field_values[key].append(value)
 fields={key:values[0] for key,values in field_values.items() if len(values)==1}
 ambiguous={key:values for key,values in field_values.items() if len(values)>1}
 mains=[n for n in parser.root.walk() if n.has('toggle-all')]
 candidates=[]
 for main in mains:
  section_nodes=[n for n in main.children if isinstance(n,HtmlNode) and n.has('toggle')]
  if section_nodes and all(len([n for n in section.walk() if n.has('toggle-inner')])==1 for section in section_nodes):candidates.append((main,section_nodes))
 sections=[];main_text='';source_main_text='';images=[];non_text=[];table_count=0;table_lookup={};all_tables=[]
 if len(candidates)==1:
  main,section_nodes=candidates[0];source_main_text=main.text()
  for node in main.walk():
   if node.tag=='table':table_lookup[id(node)]=html_table_evidence(node)
  main_text=html_literal_text(main,table_lookup)
  for section in section_nodes:
   header=[n for n in section.children if isinstance(n,HtmlNode) and n.has('toggle-title')]
   titles=[n for h in header for n in h.walk() if n.has('title-name')]
   body=next(n for n in section.walk() if n.has('toggle-inner'))
   title=titles[0].text() if titles else ''
   tables=[]
   for table in body.walk():
    if table.tag=='table':
     tables.append(table_lookup[id(table)])
   table_count+=len(tables)
   all_tables.extend(tables)
   sections.append({'title':title,'text':html_literal_text(body,table_lookup),'tables':tables})
  for node in main.walk():
   if node.tag=='img':images.append({'src':node.attrs.get('src',''),'alt':node.attrs.get('alt','')})
   if node.tag in ('svg','canvas','iframe','embed','object'):non_text.append({'tag':node.tag,'src':node.attrs.get('src',node.attrs.get('data',''))})
 complete='\n\n'.join(section['title']+'\n'+section['text'] for section in sections)
 conserved=len(candidates)==1 and bool(sections) and all(norm(s['title']) and norm(s['text']) for s in sections) and norm(source_main_text)==norm(main_text)==norm(complete)
 selected_main=candidates[0][0] if len(candidates)==1 else None
 main_evidence,ignored_main_blocks,unaccounted_main_count=html_account_main_blocks(mains,selected_main,sections)
 all_main_blocks_accounted=selected_main is not None and unaccounted_main_count==0
 conserved=conserved and all_main_blocks_accounted
 complex_count=sum(not table['simple'] and table['kind']!='empty_layout_placeholder' for table in all_tables)
 empty_count=sum(table['kind']=='empty_layout_placeholder' for table in all_tables)
 simple_conserved=conserved and all(table['literalTextConserved'] for table in all_tables if table['simple'])
 unverified=bool(images or non_text) or complex_count>0 or not simple_conserved
 paper=[];history=[]
 for popup in parser.root.walk():
  if not popup.has('popup'):continue
  titles=[n.text() for n in popup.walk() if n.has('pagetitle')]
  destination=paper if '紙本仿單樣式(自行上傳)' in titles else history if '歷史仿單' in titles else None
  if destination is None:continue
  for node in popup.walk():
   href=node.attrs.get('href','')
   if node.tag!='a' or node.has('popup_close') or not href or href.startswith(('#','javascript:')):continue
   resolved=urllib.parse.urljoin(url,href);parsed=urllib.parse.urlsplit(resolved)
   if parsed.path==urllib.parse.urlsplit(url).path:continue
   if not (parsed.path.lower().startswith(('/insert/pdfcasefile/','/fileshow/')) or parsed.path.lower().endswith('.pdf')):continue
   try:validate_official_https(resolved);destination.append(resolved)
   except (ValueError,Exception):continue
 return {'schemaVersion':4,'parserVersion':HTML_PARSER_VERSION,'sourceFormat':'html','identityFields':fields,'identityFieldOccurrences':identity_occurrences,'ambiguousIdentityFields':ambiguous,'toggleAllCount':len(mains),'bodyCandidateCount':len(candidates),'mainBlockEvidence':main_evidence,'ignoredMainBlocks':ignored_main_blocks,'unaccountedMainBlockCount':unaccounted_main_count,'allMainBlocksAccounted':all_main_blocks_accounted,'sections':sections,'completeDomText':main_text,'normalizedSectionText':complete,'fullDomConserved':conserved,'originalNormalizedDomSha256':sha_bytes(norm(source_main_text).encode()),'serializedNormalizedDomSha256':sha_bytes(norm(complete).encode()),'tableSerializationVersion':HTML_TABLE_SERIALIZATION_VERSION,'simpleTablesConserved':simple_conserved,'simpleTableCount':table_count-complex_count-empty_count,'complexTableCount':complex_count,'emptyLayoutTableCount':empty_count,'nonTextImages':images,'nonTextElements':non_text,'hasNonTextContent':bool(images or non_text),'hasUnverifiedNonTextContent':unverified,'tableCount':table_count,'paperLinks':list(dict.fromkeys(paper)),'historicalPaperLinks':list(dict.fromkeys(history)),'status':'independent_dom_extracted_draft' if conserved and not unverified and not ambiguous else 'needs_review','humanReviewed':False,'clinicalReviewed':False}

def inspect_pdf_structure(page, width, height, text):
    """Conservative geometry suspicion, not proof of correct/clinical layout."""
    evidence={'version':PDF_STRUCTURE_VERSION,'status':'review_required','reasons':[],'tableCount':0,'tables':[],'vectorHorizontalCount':0,'vectorVerticalCount':0,'rectCount':0,'curveCount':0,'wordCount':0,'columnEvidence':[],'limitations':'Heuristic suspicion detection only; absence of a flag is not clinical or perfect layout verification.'}
    reasons=evidence['reasons']
    def reason(value):
        if value not in reasons:reasons.append(value)
    def finite(value):return isinstance(value,(int,float)) and math.isfinite(value)
    def box(value):
        coords=[value.get(key) for key in ('x0','top','x1','bottom')]
        if not all(finite(v) for v in coords):raise ValueError('bbox_missing_or_nonfinite')
        x0,top,x1,bottom=map(float,coords)
        if x1<x0 or bottom<top or x0 < -2 or top < -2 or x1 > width+2 or bottom > height+2:raise ValueError('bbox_invalid_or_outside_page')
        return (x0,top,x1,bottom)
    def rounded(values):return [round(float(value),3) for value in values]
    try:
        if page is None or not finite(width) or not finite(height) or width<=0 or height<=0:
            reason('pdf_structure_inventory_missing_or_invalid');return True,evidence
        inventories={key:getattr(page,key,None) for key in ('lines','rects','curves','chars','images')}
        if any(not isinstance(value,list) for value in inventories.values()):
            reason('pdf_structure_inventory_missing_or_invalid');return True,evidence
        lines=inventories['lines'];rects=inventories['rects'];curves=inventories['curves']
        evidence.update(rectCount=len(rects),curveCount=len(curves),characterGeometryCount=len(inventories['chars']))
        if len(lines)+len(rects)+len(curves)>2000:
            reason('pdf_excessive_vector_geometry_structure_uncertain');evidence['tableAnalysis']='skipped_excessive_vector_geometry';return True,evidence
        if any(char.get('upright') is False for char in inventories['chars']):reason('pdf_rotated_text_structure_uncertain')
        words=page.extract_words(x_tolerance=2,y_tolerance=3,keep_blank_chars=False,use_text_flow=False)
        if not isinstance(words,list):raise ValueError('word_inventory_not_list')
        boxes=[]
        for word in words:
            coords=box(word)
            if not isinstance(word.get('text'),str) or coords[2]<=coords[0] or coords[3]<=coords[1]:raise ValueError('word_geometry_invalid')
            boxes.append({'box':coords,'text':word['text'],'cy':(coords[1]+coords[3])/2})
        evidence['wordCount']=len(boxes)
        if text.strip() and (not boxes or not inventories['chars']):reason('pdf_word_geometry_missing')
        left=collections.Counter(norm(text));right=collections.Counter(norm(''.join(w['text'] for w in boxes)))
        coverage=sum((left&right).values())/max(sum(left.values()),sum(right.values()),1)
        evidence['wordCharacterCoverage']=1.0 if not left and not right else round(coverage,6)
        if (left or right) and coverage<0.995:reason('pdf_structure_coverage_uncertain')
        median_height=statistics.median(b['box'][3]-b['box'][1] for b in boxes) if boxes else 0
        gap_threshold=max(12.0,width*0.025);row_tolerance=max(2.0,median_height*0.4)
        evidence['thresholds']={'minimumGapPoints':round(gap_threshold,3),'rowCenterTolerancePoints':round(row_tolerance,3),'minimumGapSupportRows':2,'minimumVerticalSpanWordHeights':1.5,'minimumColumnSideWords':3,'maximumColumnCrossingWordsFraction':0.05,'wordCoverageMinimum':0.995}
        horizontal=[];vertical=[];ignored_frames=0
        for item in lines:
            x0,top,x1,bottom=box(item);dx=x1-x0;dy=bottom-top
            if dy<=1.5 and dx>=max(12,width*0.03):horizontal.append((x0,x1,(top+bottom)/2))
            if dx<=1.5 and dy>=max(12,height*0.02):vertical.append(((x0+x1)/2,top,bottom))
        for item in rects:
            x0,top,x1,bottom=box(item)
            if x1-x0>=width*0.90 and bottom-top>=height*0.90:
                ignored_frames+=1;continue
            if x1-x0>=12 and bottom-top>=8:
                horizontal.extend([(x0,x1,top),(x0,x1,bottom)]);vertical.extend([(x0,top,bottom),(x1,top,bottom)])
        evidence.update(vectorHorizontalCount=len(horizontal),vectorVerticalCount=len(vertical),ignoredPageFrameRectCount=ignored_frames)
        # A single enclosing rectangle is not a subdivided matrix. An internal
        # third horizontal/vertical separator is required for the grid heuristic.
        ys={round(item[2],1) for item in horizontal};xs={round(item[0],1) for item in vertical}
        intersections=sum(hx0-2<=vx<=hx1+2 and vy0-2<=hy<=vy1+2 for hx0,hx1,hy in horizontal for vx,vy0,vy1 in vertical)
        evidence['vectorGridIntersectionCount']=intersections
        if intersections>=6 and ((len(ys)>=3 and len(xs)>=2) or (len(ys)>=2 and len(xs)>=3)):
            reason('pdf_vector_grid_detected')
        if any(width*0.1<x<width*0.9 and bottom-top>=height*0.25 for x,top,bottom in vertical):reason('pdf_vertical_column_separator_detected')
        if len(lines)+len(rects)+len(curves)>2000:
            reason('pdf_excessive_vector_geometry_structure_uncertain')
            evidence['tableAnalysis']='skipped_excessive_vector_geometry'
        else:
            tables=page.find_tables()
            if not isinstance(tables,list):raise ValueError('table_inventory_not_list')
            for table in tables:
                coords=list(table.bbox)
                if len(coords)!=4 or not all(finite(v) for v in coords):raise ValueError('table_bbox_invalid')
                rows=len(table.rows);columns=len(table.columns);cells=len(table.cells)
                frame=rows==columns==1 and coords[2]-coords[0]>=width*0.90 and coords[3]-coords[1]>=height*0.90
                if frame:continue
                evidence['tables'].append({'bbox':rounded(coords),'rowCount':rows,'columnCount':columns,'cellCount':cells})
            evidence['tableCount']=len(evidence['tables']);evidence['tableAnalysis']='completed'
            if evidence['tableCount']:reason('pdf_table_detected')
        for curve in curves:box(curve)
        if curves:reason('pdf_unclassified_vector_path')
        rows=[]
        for word in sorted(boxes,key=lambda w:(w['cy'],w['box'][0])):
            if not rows or abs(word['cy']-rows[-1]['cy'])>row_tolerance:rows.append({'cy':word['cy'],'words':[word]})
            else:rows[-1]['words'].append(word)
        gaps=[]
        for row_id,row in enumerate(rows):
            ordered=sorted(row['words'],key=lambda w:w['box'][0])
            for a,b in zip(ordered,ordered[1:]):
                if b['box'][0]-a['box'][2]>=gap_threshold:
                    gaps.append({'row':row_id,'y':row['cy'],'x0':a['box'][2],'x1':b['box'][0]})
        for seed in gaps:
            x=(seed['x0']+seed['x1'])/2
            support={g['row']:g for g in gaps if g['x0']<=x<=g['x1']}
            if len(support)<2:continue
            values=list(support.values());y0=min(g['y'] for g in values);y1=max(g['y'] for g in values)
            if y1-y0<median_height*1.5:continue
            candidate={'kind':'repeated_row_gap','xInterval':rounded([max(g['x0'] for g in values),min(g['x1'] for g in values)]),'supportRows':len(values),'ySpan':rounded([y0,y1])}
            if candidate not in evidence['columnEvidence']:evidence['columnEvidence'].append(candidate)
            if len(evidence['columnEvidence'])>=8:break
        if evidence['columnEvidence']:reason('pdf_repeated_column_gap_detected')
        if len(boxes)>=6:
            # Global gutters also catch columns whose baselines are offset.
            for step in range(1,60):
                x=width*step/60
                lhs=[w for w in boxes if w['box'][2]<=x];rhs=[w for w in boxes if w['box'][0]>=x]
                crossed=len(boxes)-len(lhs)-len(rhs)
                if len(lhs)<3 or len(rhs)<3 or crossed>max(1,int(len(boxes)*0.05)):continue
                x0=max(w['box'][2] for w in lhs);x1=min(w['box'][0] for w in rhs)
                y0=max(min(w['cy'] for w in lhs),min(w['cy'] for w in rhs));y1=min(max(w['cy'] for w in lhs),max(w['cy'] for w in rhs))
                if x1-x0<gap_threshold or y1-y0<median_height*1.5:continue
                evidence['columnEvidence'].append({'kind':'global_column_gutter','xInterval':rounded([x0,x1]),'leftWords':len(lhs),'rightWords':len(rhs),'crossingWords':crossed,'overlappingYSpan':rounded([y0,y1])});reason('pdf_global_column_gutter_detected');break
        if not text.strip() and (inventories['images'] or lines or rects and not ignored_frames or curves):reason('pdf_textless_nonempty_page_structure_unknown')
        evidence['status']='review_required' if reasons else 'single_flow_no_detected_structure' if text.strip() else 'empty_page_no_structure'
        return bool(reasons),evidence
    except Exception as error:
        reason('pdf_structure_analysis_failed');evidence['errorType']=type(error).__name__
        return True,evidence

def inspect_pdf_direct(path):
    """Keep physical blank pages; extraction evidence never implies reading order."""
    from pypdf import PdfReader
    try: import pdfplumber
    except ImportError: pdfplumber=None
    # The internal CLI reads once. Both engines parse exactly those same bytes,
    # rather than reopening a path which might have changed after hash capture.
    source_raw=path if isinstance(path,bytes) else pathlib.Path(path).read_bytes()
    reader=PdfReader(io.BytesIO(source_raw)); count=len(reader.pages); pages=[]
    if count>200:
        return {'schemaVersion':3,'sourceFormat':'pdf','physicalPageCount':count,'pages':[],'status':'needs_review','error':'over_200_physical_pages','allPhysicalPagesExtracted':False,'humanReviewed':False,'clinicalReviewed':False}
    plumber=pdfplumber.open(io.BytesIO(source_raw)) if pdfplumber else None
    try:
        for number,page in enumerate(reader.pages,1):
            width=float(page.mediabox.width);height=float(page.mediabox.height)
            try: secondary=page.extract_text() or ''; secondary_error=None
            except Exception as error: secondary=''; secondary_error=type(error).__name__
            image_areas=[]; image_unknown=False; primary_error=None
            if plumber:
                pp=plumber.pages[number-1]
                try: text=pp.extract_text() or ''
                except Exception as error: text=''; primary_error=type(error).__name__
                for image in pp.images:
                    try:
                        image_areas.append(max(0,min(width,float(image['x1']))-max(0,float(image['x0'])))*max(0,min(height,float(image['bottom']))-max(0,float(image['top'])))/max(width*height,1))
                    except (KeyError,ValueError,TypeError): image_unknown=True
                image_count=len(pp.images)
            else:
                text=secondary
                try: image_count=len(page.images); image_unknown=image_count>0
                except Exception: image_count=0;image_unknown=True
            image_large=any(area>0.10 for area in image_areas) or sum(image_areas)>0.15 or image_unknown
            unverified_structure,structure_evidence=inspect_pdf_structure(pp if plumber else None,width,height,text)
            char_counts={'primary':len(norm(text)),'pypdf':len(norm(secondary))}
            characters=len(text);too_large=characters>PAGE_TEXT_LIMIT or len(secondary)>PAGE_TEXT_LIMIT
            pages.append({'page':number,'text':'' if too_large else text,'characters':characters,'normalizedCharacters':char_counts['primary'],'width':width,'height':height,'primaryEngine':'pdfplumber' if plumber else 'pypdf','pypdfText':'' if too_large else secondary,'pypdfCharacters':char_counts['pypdf'],'primaryParseError':primary_error,'pypdfParseError':secondary_error,'imageCount':image_count,'imageAreaRatios':image_areas,'imageAreaSum':sum(image_areas),'imageLarge':image_large,'imageGeometryUnknown':image_unknown,'hasUnverifiedStructure':unverified_structure,'structureEvidence':structure_evidence,'pageCharacterLimitExceeded':too_large,'textOmittedReason':'page_text_over_22000_character_limit_raw_preserved' if too_large else None,'blankClassification':'text_empty_image_present_requires_review' if not text.strip() and image_count else 'text_empty_requires_render_confirmation' if not text.strip() else 'text_present','replacementCharacters':text.count('\ufffd'),'allEnginesAgreeAfterWhitespaceNfkc':norm(text)==norm(secondary)})
    finally:
        if plumber: plumber.close()
    needs=any(p['primaryParseError'] or p['imageLarge'] or p['hasUnverifiedStructure'] or p['pageCharacterLimitExceeded'] or not p['text'].strip() or p['replacementCharacters'] for p in pages)
    complete=all(not p['primaryParseError'] and not p['pageCharacterLimitExceeded'] for p in pages)
    return {'schemaVersion':3,'sourceFormat':'pdf','physicalPageCount':count,'allPhysicalPagesExtracted':complete,'pages':pages,'status':'needs_review' if needs else 'independent_text_extracted_draft','humanReviewed':False,'clinicalReviewed':False,'limitation':'Character coverage and conservative structure suspicion do not establish identity, perfect column/table order, cross-page conditions or clinical correctness.'}

def inspect_pdf(path):
    try:
        child=subprocess.run([sys.executable,'-X','utf8',str(pathlib.Path(__file__).resolve()),'--inspect-pdf-internal',str(path)],capture_output=True,timeout=PDF_PARSE_DEADLINE_SECONDS,check=False)
    except subprocess.TimeoutExpired:
        return {'schemaVersion':3,'parserVersion':PDF_PARSER_VERSION,'sourceFormat':'pdf','status':'needs_review','error':'independent_pdf_parse_deadline_45s','pages':[],'allPhysicalPagesExtracted':False,'humanReviewed':False,'clinicalReviewed':False}
    warnings=len(child.stderr.splitlines())
    if child.returncode:
        return {'schemaVersion':3,'parserVersion':PDF_PARSER_VERSION,'sourceFormat':'pdf','status':'needs_review','error':'independent_pdf_parse_child_failed','childExitCode':child.returncode,'warningLineCount':warnings,'pages':[],'allPhysicalPagesExtracted':False,'humanReviewed':False,'clinicalReviewed':False}
    try:report=json.loads(child.stdout.decode('utf-8'))
    except (ValueError,UnicodeDecodeError):
        return {'schemaVersion':3,'parserVersion':PDF_PARSER_VERSION,'sourceFormat':'pdf','status':'needs_review','error':'independent_pdf_child_invalid_json','warningLineCount':warnings,'pages':[],'allPhysicalPagesExtracted':False,'humanReviewed':False,'clinicalReviewed':False}
    report.update(parserVersion=PDF_PARSER_VERSION,warningLineCount=warnings,parseDeadlineSeconds=PDF_PARSE_DEADLINE_SECONDS)
    return report

def process_source(job, root):
    result={'schemaVersion':1,'urlHash':job['url_hash'],'sourceUrl':job['url'],'at':now(),'status':'failed','attempts':0,'humanReviewed':False,'clinicalReviewed':False}
    if is_placeholder(job['url'],job.get('disposition','')):
        return {**result,'status':'unresolved_placeholder','error':'placeholder_not_requested'}
    try: validate_official_https(job['url'])
    except (SourceError,ValueError): return {**result,'status':'unresolved_nonofficial_or_nonhttps','error':'initial_url_policy_failed'}
    raw=None
    # A raw-only checkpoint also survives a hard stop during independent parsing.
    cached_record=root/'records'/(job['url_hash']+'.json')
    if cached_record.is_file():
        with contextlib.suppress(OSError,ValueError,KeyError,TypeError):
            cached=json.loads(cached_record.read_text(encoding='utf-8'))
            cached_blob=root/cached['blobPath']
            if cached.get('sourceUrl')==job['url'] and cached_blob.is_file() and sha_file(cached_blob)==cached['sourceBlobSha256']:
                raw=cached_blob.read_bytes()
                result.update({k:cached[k] for k in ('finalUrl','httpStatus','contentType','redirects','fetchedAt') if k in cached})
                result['resumedVerifiedRawCheckpoint']=True
    if raw is None and job.get('reextractOnly'):
        return {**result,'status':'failed_cached_blob_integrity','error':'reextract_requires_verified_raw_checkpoint'}
    for attempt in range(0 if raw is not None else MAX_ATTEMPTS):
        result['attempts']=attempt+1
        try:
            raw, metadata=fetch_bounded(job['url']);result.update(metadata); break
        except (SourceError,urllib.error.URLError,TimeoutError,socket.timeout,OSError,ValueError) as error:
            result['error']=str(error) if isinstance(error,SourceError) else type(error).__name__
    if raw is None: return result
    digest=sha_bytes(raw)
    file_type='pdf' if raw.startswith(b'%PDF-') else 'html' if b'<html' in raw[:4096].lower() or b'<!doctype html' in raw[:4096].lower() or result['contentType']=='text/html' else 'other'
    blob=root/'objects'/digest[:2]/(digest+'.'+('bin' if file_type=='other' else file_type))
    blob.parent.mkdir(parents=True,exist_ok=True)
    if not blob.exists() or sha_file(blob)!=digest:
        fd,tmp=tempfile.mkstemp(prefix=digest+'.',suffix='.tmp',dir=blob.parent)
        try:
            with os.fdopen(fd,'wb') as stream: stream.write(raw);stream.flush();os.fsync(stream.fileno())
            os.replace(tmp,blob)
        finally:
            if os.path.exists(tmp): os.unlink(tmp)
    result.update(sourceBlobSha256=digest,sourceType=file_type,bytes=len(raw),blobPath=str(blob.relative_to(root)),error=None,status='downloaded_'+file_type+'_draft')
    result.update(requestedUrl=job['url'],redirectChain=result.get('redirects',[]),fetchedAt=result.get('fetchedAt',result['at']),sha256=digest,mediaType=result.get('contentType',''),rawPath=str(blob))
    write_json(cached_record,{**result,'status':'raw_downloaded_pending_independent_extraction'})
    report_path=root/'extraction'/(job['url_hash']+'.json')
    try:
        report=inspect_pdf(blob) if file_type=='pdf' else inspect_html(raw,result['finalUrl']) if file_type=='html' else {'status':'needs_review','error':'unsupported_source_media','sourceFormat':'other'}
    except Exception as error:
        report={'status':'needs_review','error':'independent_parse_'+type(error).__name__,'sourceFormat':file_type,'humanReviewed':False,'clinicalReviewed':False}
    report.update(urlHash=job['url_hash'],sourceBlobSha256=digest,at=now())
    write_json(report_path,report)
    result.update(extractionPath=str(report_path.relative_to(root)),extractionStatus=report['status'],parserVersion=report.get('parserVersion'))
    if report['status']=='needs_review': result['status']='downloaded_'+file_type+'_needs_review'
    if file_type=='pdf':
        result['physicalPageCount']=report.get('physicalPageCount')
        result['pdfPages']=[{**p,'independentText':p['text']} for p in report.get('pages',[])]
        result['allPhysicalPagesExtracted']=report.get('allPhysicalPagesExtracted',False)
    write_json(cached_record,result)
    return result

class OutputLock:
    def __init__(self,path):self.path=path
    def __enter__(self):
        self.stream=open(self.path,'a+b');self.stream.seek(0)
        if self.path.stat().st_size==0:self.stream.write(b' ');self.stream.flush()
        self.stream.seek(0)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(self.stream.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            self.stream.close(); raise SourceError('output_already_locked') from None
        return self
    def __exit__(self,*args):self.stream.close()

def load_inventory(database, path):
    digest=sha_file(path)
    previous=database.execute("select value from meta where key='inventory_sha256'").fetchone()
    if previous and previous[0]!=digest: raise SourceError('inventory_changed_use_a_new_output_directory')
    if previous:return digest
    with open(path,encoding='utf-8-sig') as stream:
        for line in stream:
            if not line.strip():continue
            product=json.loads(line);license_no=product['fullLicense']
            for source in product.get('sources',[]):
                url=source.get('sourceUrl','');key=sha_bytes(url.encode())
                disposition=source.get('sourceDisposition','')
                database.execute('insert or ignore into sources(url_hash,url,disposition,status) values(?,?,?,?)',(key,url,disposition,'pending'))
                database.execute('insert or ignore into product_sources(full_license,url_hash) values(?,?)',(license_no,key))
    database.execute("insert into meta(key,value) values('inventory_sha256',?)",(digest,))
    database.execute("insert into meta(key,value) values('inventory_path',?)",(str(path),))
    database.commit();return digest

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory',type=pathlib.Path)
    parser.add_argument('--output',type=pathlib.Path)
    parser.add_argument('--inspect-pdf-internal',type=pathlib.Path,help=argparse.SUPPRESS)
    parser.add_argument('--inspect-html-internal',nargs=2,metavar=('FILE','URL'),help=argparse.SUPPRESS)
    parser.add_argument('--limit',type=int,default=50,help='Maximum unique URLs attempted during this invocation (default 50).')
    parser.add_argument('--workers',type=int,default=4)
    parser.add_argument('--all',action='store_true',help='Explicitly process all remaining URLs in the frozen inventory.')
    parser.add_argument('--retry-failed',action='store_true')
    parser.add_argument('--reextract-cached',action='store_true',help='Re-extract cached successful sources with the current parser; no network requests.')
    parser.add_argument('--reextract-format',choices=('html','pdf','all'),default='all',help='Source format to re-extract; valid only with --reextract-cached.')
    args=parser.parse_args(argv)
    if args.inspect_html_internal:
        filename,url=args.inspect_html_internal
        raw=pathlib.Path(filename).read_bytes()
        report=inspect_html(raw,url)
        report.update(rawSha256=sha_bytes(raw),rawBytes=len(raw),sourceUrl=url)
        print(json.dumps(report,ensure_ascii=False));return 0
    if args.inspect_pdf_internal:
        raw=args.inspect_pdf_internal.read_bytes()
        try:report=inspect_pdf_direct(raw)
        except Exception as error:report={'schemaVersion':3,'sourceFormat':'pdf','status':'needs_review','error':'independent_parse_'+type(error).__name__,'pages':[],'allPhysicalPagesExtracted':False,'humanReviewed':False,'clinicalReviewed':False}
        report.update(parserVersion=PDF_PARSER_VERSION,rawSha256=sha_bytes(raw),rawBytes=len(raw))
        print(json.dumps(report,ensure_ascii=False));return 0
    if args.inventory is None or args.output is None:parser.error('--inventory and --output are required')
    if args.reextract_format!='all' and not args.reextract_cached:parser.error('--reextract-format requires --reextract-cached')
    if args.limit<1:parser.error('--limit must be positive')
    if not 1<=args.workers<=4:parser.error('--workers must be between 1 and 4')
    root=args.output.resolve();root.mkdir(parents=True,exist_ok=True)
    stopped=threading.Event()
    def stop(*unused):stopped.set();print('Interrupt received; finishing in-flight sources and saving checkpoints.',file=sys.stderr,flush=True)
    signal.signal(signal.SIGINT,stop)
    if hasattr(signal,'SIGTERM'):signal.signal(signal.SIGTERM,stop)
    with OutputLock(root/'fetch.lock'):
        database=sqlite3.connect(root/'checkpoint.sqlite3');database.row_factory=sqlite3.Row
        database.executescript('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sources(url_hash TEXT PRIMARY KEY,url TEXT NOT NULL,disposition TEXT,status TEXT NOT NULL,result_json TEXT); CREATE TABLE IF NOT EXISTS product_sources(full_license TEXT NOT NULL,url_hash TEXT NOT NULL,PRIMARY KEY(full_license,url_hash));')
        inventory_hash=load_inventory(database,args.inventory.resolve())
        # Verify known objects locally; corrupt/missing blobs are never silently refetched.
        verified=0;invalidated=0
        for row in database.execute("select url_hash,result_json from sources where status like 'downloaded_%'").fetchall():
            result=json.loads(row['result_json']);blob=root/result['blobPath']
            if blob.is_file() and sha_file(blob)==result['sourceBlobSha256']:verified+=1
            else:
                result.update(status='failed_cached_blob_integrity',error='cached_blob_missing_or_sha256_mismatch',at=now())
                database.execute('update sources set status=?,result_json=? where url_hash=?',(result['status'],json.dumps(result,ensure_ascii=False),row['url_hash']));invalidated+=1
        database.commit()
        query="select url_hash,url,disposition,result_json from sources where status like 'downloaded_%' order by rowid" if args.reextract_cached else "select url_hash,url,disposition from sources where status='pending'"+(" or status like 'failed%'" if args.retry_failed else '')+" order by rowid"
        jobs=[dict(row) for row in database.execute(query)]
        if args.reextract_cached and args.reextract_format!='all':
            jobs=[job for job in jobs if json.loads(job['result_json']).get('sourceType')==args.reextract_format]
        for job in jobs:job.pop('result_json',None)
        if not args.all:jobs=jobs[:args.limit]
        if args.reextract_cached:
            for job in jobs:job['reextractOnly']=True
        cursor=iter(jobs);inflight={};completed=0
        journal=open(root/'events.jsonl','a',encoding='utf-8',newline='\n')
        def submit(pool):
            if stopped.is_set():return False
            try:job=next(cursor)
            except StopIteration:return False
            inflight[pool.submit(process_source,job,root)]=job;return True
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
                for _ in range(args.workers):submit(pool)
                while inflight:
                    done,_=concurrent.futures.wait(inflight,return_when=concurrent.futures.FIRST_COMPLETED)
                    for future in done:
                        job=inflight.pop(future)
                        try:result=future.result()
                        except Exception as error:result={'urlHash':job['url_hash'],'sourceUrl':job['url'],'at':now(),'status':'failed_worker','error':type(error).__name__}
                        result.setdefault('requestedUrl',job['url']);result.setdefault('fetchedAt',result['at']);result.setdefault('redirectChain',result.get('redirects',[]))
                        write_json(root/'records'/(job['url_hash']+'.json'),result)
                        encoded=json.dumps(result,ensure_ascii=False)
                        database.execute('update sources set status=?,result_json=? where url_hash=?',(result['status'],encoded,job['url_hash']));database.commit()
                        journal.write(encoded+'\n');journal.flush();os.fsync(journal.fileno());completed+=1
                        print(json.dumps({'completed':completed,'scheduledThisRun':len(jobs),'urlHash':job['url_hash'],'status':result['status'],'bytes':result.get('bytes',0)},ensure_ascii=False),flush=True)
                        submit(pool)
        finally:journal.close()
        counts={row['status']:row['n'] for row in database.execute('select status,count(*) n from sources group by status')}
        summary={'schemaVersion':3,'at':now(),'inventorySha256':inventory_hash,'output':str(root),'operation':'reextract_cached_no_network' if args.reextract_cached else 'acquire_sources','reextractFormat':args.reextract_format if args.reextract_cached else None,'htmlParserVersion':HTML_PARSER_VERSION,'htmlTableSerializationVersion':HTML_TABLE_SERIALIZATION_VERSION,'pdfParserVersion':PDF_PARSER_VERSION,'scheduledThisRun':len(jobs),'completedThisRun':completed,'interrupted':stopped.is_set(),'cachedObjectsHashVerified':verified,'cachedObjectIntegrityFailures':invalidated,'uniqueSourceCount':sum(counts.values()),'productCount':database.execute('select count(distinct full_license) from product_sources').fetchone()[0],'statusCounts':counts,'aiCalls':0,'cloudWrites':0,'publicationActions':0,'humanReviewed':False,'clinicalReviewed':False}
        write_json(root/'summary.json',summary);database.close();print(json.dumps(summary,ensure_ascii=False),flush=True)
    return 130 if stopped.is_set() else 0

if __name__=='__main__':
    try:sys.exit(main())
    except (SourceError,OSError,sqlite3.Error) as error:
        print(json.dumps({'status':'fatal','error':str(error) if isinstance(error,SourceError) else type(error).__name__}),file=sys.stderr);sys.exit(1)
