"""Offline, complete raw-DOM evidence for one explicit current paper attachment.

This extractor proves no child PDF identity or clinical/layout eligibility. It
never fetches a URL and never imports the filtering inspect_html.paperLinks.
"""
from __future__ import annotations
import argparse,hashlib,importlib.util,json,pathlib,re,sys,urllib.parse

sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[1]
FETCH_PATH=ROOT/'tools/fetch-tfda-sources.py'
SCHEMA='tfda-parent-paper-association/v2'
SCHEMA_VERSION=2
PARSER_VERSION='tfda-parent-paper-strict-v2'
SCOPE='single_current_paper_excluding_explicit_history'
MAX_PARENT_BYTES=15_000_000
CURRENT_TITLE='紙本仿單樣式(自行上傳)'
HISTORY_TITLE='歷史仿單'
REQUIRED_LABELS=('許可證號','中文品名','藥品類別')
spec=importlib.util.spec_from_file_location('tfda_parent_fetch_dependency',FETCH_PATH)
fetch=importlib.util.module_from_spec(spec);spec.loader.exec_module(fetch)
HtmlParser,HtmlNode,norm=fetch.HtmlParser,fetch.HtmlNode,fetch.norm

class SourceDOMParser(HtmlParser):
    """Retain attribute multiplicity before the dependency's dict conversion."""
    def __init__(self):
        super().__init__();self.duplicate_attributes=[];self.base_elements=[];self.start_tag_count=0
    def handle_starttag(self,tag,attrs):
        parent=self.stack[-1];line,column=self.getpos();source_index=self.start_tag_count;self.start_tag_count+=1
        super().handle_starttag(tag,attrs);node=parent.children[-1];node.original_attrs=list(attrs)
        names=dict.fromkeys(name for name,_ in attrs)
        for name in names:
            items=[value for key,value in attrs if key==name]
            if len(items)>1:
                benign=tag=='a'and name=='rel'and all(value=='noopener noreferrer'for value in items)
                evidence={'sourceTagIndex':source_index,'tag':tag,'line':line,'column':column,'attribute':name,'classification':'identical_rel_no_routing_effect'if benign else'duplicate_attribute_rejected','fatal':not benign,'valueSha256':[sha(json.dumps(value,ensure_ascii=False).encode())for value in items]}
                if name in('href','src','data-src','data','class','id','data_popup','data-popup_close','rel'):evidence['literalValues']=items
                self.duplicate_attributes.append(evidence)
        if tag=='base':self.base_elements.append({'sourceTagIndex':source_index,'line':line,'column':column,'hrefOccurrences':[value for key,value in attrs if key=='href']})

def sha(raw):return hashlib.sha256(raw).hexdigest()
def append_unique(items,value):
    if value not in items:items.append(value)
def location(node):
    parts=[]
    while node.parent is not None:
        siblings=[child for child in node.parent.children if isinstance(child,HtmlNode)]
        parts.append((node.tag or 'document')+'['+str(siblings.index(node)+1)+']');node=node.parent
    return '/'+ '/'.join(reversed(parts))
def normalize_official(url):
    fetch.validate_official_https(url)
    parsed=urllib.parse.urlsplit(url)
    path=urllib.parse.quote(parsed.path,safe="/%:@!$&'()*+,;=-._~")
    query=urllib.parse.quote(parsed.query,safe="/%?:@!$&'()*+,;=-._~")
    path=re.sub(r'%[0-9a-fA-F]{2}',lambda m:m.group(0).upper(),path)
    query=re.sub(r'%[0-9a-fA-F]{2}',lambda m:m.group(0).upper(),query)
    return urllib.parse.urlunsplit(('https',parsed.hostname.lower(),path,query,parsed.fragment))
def is_paper_url(url):
    try:parts=urllib.parse.urlsplit(url);path=parts.path.lower()
    except ValueError:return False
    return (path.startswith('/insert/pdfcasefile/')and bool(path[len('/insert/pdfcasefile/'):].strip('/')))or(path.startswith('/fileshow/')and bool(path[len('/fileshow/'):].strip('/')))or(path=='/fileshow'and bool(parts.query))or path.endswith('.pdf')
def is_known_history_electronic(url,source_url):
    try:
        target=urllib.parse.urlsplit(url);source=urllib.parse.urlsplit(normalize_official(source_url));pairs=urllib.parse.parse_qsl(target.query,keep_blank_values=True)
        return target.scheme=='https'and target.hostname==source.hostname and urllib.parse.unquote(target.path)==urllib.parse.unquote(source.path)and target.path.startswith('/im_detail_1/')and not target.fragment and len(pairs)==1 and pairs[0][0]=='item'and bool(re.fullmatch(r'[0-9]+',pairs[0][1]))
    except (ValueError,fetch.SourceError):return False
def collision_key(url):
    try:
        p=urllib.parse.urlsplit(url)
        return (p.scheme.lower(),(p.hostname or '').lower(),urllib.parse.unquote(p.path),tuple(sorted(urllib.parse.parse_qsl(p.query,keep_blank_values=True))))
    except ValueError:return ('invalid',url)

def inspect_parent(raw,source_url):
    reasons=[]
    def invalid(reason):append_unique(reasons,reason)
    result={'schema':SCHEMA,'schemaVersion':SCHEMA_VERSION,'parserVersion':PARSER_VERSION,'scope':SCOPE,'rawSha256':sha(raw),'rawBytes':len(raw),'sourceUrl':source_url,'parserHelperSha256':sha(pathlib.Path(__file__).read_bytes()),'fetchDependencySha256':sha(FETCH_PATH.read_bytes()),'requiredIdentityLabels':list(REQUIRED_LABELS),'identityFieldOccurrences':[],'identityFields':{},'ambiguousIdentityFields':{},'identityHeaderEvidence':[],'duplicateAttributeEvidence':[],'baseElementEvidence':[],'orderedPopups':[],'orderedAnchors':[],'orderedScopedResources':[],'currentPaperUrls':[],'currentOtherUrls':[],'historicalPaperUrls':[],'historicalOtherUrls':[],'excludedHistoricalElectronicUrls':[],'excludedHistoricalPaperUrls':[],'invalidReasons':reasons,'associationValid':False,'humanReviewed':False,'clinicalReviewed':False,'networkRequests':0}
    if len(raw)>MAX_PARENT_BYTES:invalid('parent_raw_exceeds_15mb');return result
    try:
        normalized_source=normalize_official(source_url)
        if urllib.parse.urlsplit(normalized_source).fragment:invalid('source_url_fragment_not_supported')
    except (ValueError,fetch.SourceError):invalid('source_url_not_official_https');normalized_source=source_url
    decoded=raw.decode('utf-8-sig',errors='replace')
    if '\ufffd'in decoded:invalid('parent_utf8_replacement_character')
    parser=SourceDOMParser()
    try:parser.feed(decoded);parser.close()
    except Exception:invalid('parent_dom_parse_failed');return result
    result.update(duplicateAttributeEvidence=parser.duplicate_attributes,baseElementEvidence=parser.base_elements,rawStartTagCount=parser.start_tag_count)
    if any(evidence['fatal']for evidence in parser.duplicate_attributes):invalid('duplicate_html_attribute')
    if parser.base_elements:invalid('html_base_element_not_supported')
    nodes=list(parser.root.walk());indices={id(node):index for index,node in enumerate(nodes)}
    values={}
    for node in nodes:
        if not node.has('page_name'):continue
        labels=[child for child in node.children if isinstance(child,HtmlNode)and child.tag=='label'];spans=[child for child in node.children if isinstance(child,HtmlNode)and child.tag=='span']
        header={'domIndex':indices[id(node)],'domPath':location(node),'tag':node.tag,'labelCount':len(labels),'valueCount':len(spans),'textSha256':sha(node.text().encode())}
        # The actual template has an h2.page_name UI heading without fields.
        if node.tag=='h2'and not labels and not spans and node.text()=='登入':header['classification']='known_login_ui_heading'
        elif len(labels)==len(spans)==1:
            label,value=labels[0].text(),spans[0].text();header.update(classification='identity_field',label=label,value=value)
            result['identityFieldOccurrences'].append({'label':label,'value':value,'domIndex':indices[id(node)],'domPath':location(node)})
            values.setdefault(label,[])
            if value not in values[label]:values[label].append(value)
            if not label:invalid('empty_identity_label')
        else:header['classification']='unaccounted_identity_header';invalid('unaccounted_identity_header')
        result['identityHeaderEvidence'].append(header)
    result['identityFields']={label:items[0]for label,items in values.items()if len(items)==1}
    result['ambiguousIdentityFields']={label:items for label,items in values.items()if len(items)>1}
    if result['ambiguousIdentityFields']:invalid('conflicting_duplicate_identity_label')
    for label in REQUIRED_LABELS:
        if not norm(result['identityFields'].get(label,'')):invalid('missing_required_identity_'+label)
    popups=[node for node in nodes if node.has('popup')];popup_index={id(node):index for index,node in enumerate(popups)}
    def closest_popup(node):
        node=node.parent
        while node is not None:
            if id(node)in popup_index:return popup_index[id(node)]
            node=node.parent
        return None
    popup_roles={}
    for index,node in enumerate(popups):
        titles=[child.text()for child in node.walk()if child.has('pagetitle')and closest_popup(child)==index]
        marker=node.attrs.get('data_popup','');current=marker=='popup-new2'and titles==[CURRENT_TITLE];history=marker=='popup-history'and titles==[HISTORY_TITLE]
        paper_hint=marker in('popup-new2','popup-history')or any('紙本仿單'in title or HISTORY_TITLE in title for title in titles)
        role='current'if current else'historical'if history else'unaccounted_paper'if paper_hint else'other'
        entry={'popupIndex':index,'domIndex':indices[id(node)],'domPath':location(node),'id':node.attrs.get('id'),'dataPopup':marker,'originalDataPopupOccurrences':[value for key,value in getattr(node,'original_attrs',[])if key=='data_popup'],'classes':node.attrs.get('class',''),'titleTexts':titles,'role':role,'anchorIndices':[]}
        if role in('current','historical')and titles!=[CURRENT_TITLE if role=='current'else HISTORY_TITLE]:invalid('mixed_missing_or_duplicate_'+role+'_popup_title')
        if role=='unaccounted_paper':invalid('unaccounted_paper_popup')
        if role in('current','historical')and any(child is not node and child.has('popup')for child in node.walk()):invalid('nested_popup_in_paper_scope')
        result['orderedPopups'].append(entry);popup_roles[index]=role
    result['currentPopupCount']=sum(role=='current'for role in popup_roles.values());result['historicalPopupCount']=sum(role=='historical'for role in popup_roles.values())
    if result['currentPopupCount']!=1:invalid('current_popup_count_not_one')
    if result['historicalPopupCount']>1:invalid('multiple_historical_popups')
    current_role_urls=[];history_role_urls=[]
    for node in nodes:
        popup=closest_popup(node);role=popup_roles.get(popup,'outside');scoped=role in('current','historical','unaccounted_paper')
        if node.tag!='a':
            if scoped and(node.tag in('iframe','embed','object','img','source','video','canvas','svg','button','input')or any(key in node.attrs for key in('src','data-src'))):
                resource={'domIndex':indices[id(node)],'domPath':location(node),'popupIndex':popup,'role':role,'tag':node.tag,'attributes':{key:node.attrs.get(key)for key in('src','data','data-src','type')if key in node.attrs},'classification':'unaccounted_scoped_resource_or_control'}
                result['orderedScopedResources'].append(resource);invalid('unaccounted_'+role+'_resource_or_control')
            continue
        index=len(result['orderedAnchors']);literal=node.attrs.get('href');entry={'anchorIndex':index,'domIndex':indices[id(node)],'domPath':location(node),'popupIndex':popup,'role':role,'literalHref':literal,'hrefOccurrences':[value for key,value in getattr(node,'original_attrs',[])if key=='href'],'text':node.text(),'classes':node.attrs.get('class',''),'resolvedUrl':None,'officialHttps':False,'classification':'outside_scope_nonpaper_anchor','invalidReasons':[]}
        if popup is not None:result['orderedPopups'][popup]['anchorIndices'].append(index)
        def anchor_invalid(reason):append_unique(entry['invalidReasons'],reason);invalid(reason)
        known_close=node.has('popup_close')and literal=='#'and'data-popup_close'in node.attrs and node.text()in('','✖')
        if scoped and known_close:entry['classification']='ignored_exact_popup_close_ui';result['orderedAnchors'].append(entry);continue
        if not isinstance(literal,str)or not literal.strip():
            if scoped:entry['classification']='unaccounted_anchor';anchor_invalid('missing_or_empty_'+role+'_anchor_href')
            result['orderedAnchors'].append(entry);continue
        if scoped and any(ord(character)<32 for character in literal):anchor_invalid('control_character_in_'+role+'_href')
        try:resolved=urllib.parse.urljoin(normalized_source,literal)
        except ValueError:
            entry['classification']='malformed_anchor_url'
            if scoped:anchor_invalid('malformed_'+role+'_anchor_url')
            result['orderedAnchors'].append(entry);continue
        entry['resolvedUrl']=resolved
        try:
            normalized=normalize_official(resolved);entry.update(resolvedUrl=normalized,officialHttps=True)
            if urllib.parse.urlsplit(normalized).fragment and scoped:anchor_invalid('unsupported_'+role+'_link_fragment')
        except (ValueError,fetch.SourceError):
            normalized=resolved
            if scoped:anchor_invalid(role+'_link_not_official_https')
        paper=is_paper_url(normalized)
        if role=='current':
            append_unique(current_role_urls,normalized)
            if paper:entry['classification']='current_paper_attachment';append_unique(result['currentPaperUrls'],normalized)
            else:entry['classification']='unsupported_current_link';append_unique(result['currentOtherUrls'],normalized);anchor_invalid('unsupported_current_link')
        elif role=='historical':
            append_unique(history_role_urls,normalized)
            if paper:
                append_unique(result['historicalPaperUrls'],normalized)
                if entry['officialHttps']and not entry['invalidReasons']:
                    entry['classification']='excluded_history_paper';append_unique(result['excludedHistoricalPaperUrls'],normalized)
                else:entry['classification']='unsupported_historical_paper_link';anchor_invalid('unsupported_historical_paper_link')
            else:
                append_unique(result['historicalOtherUrls'],normalized)
                if entry['officialHttps']and is_known_history_electronic(normalized,normalized_source):entry['classification']='excluded_history_electronic';append_unique(result['excludedHistoricalElectronicUrls'],normalized)
                else:entry['classification']='unsupported_historical_link';anchor_invalid('unsupported_historical_link')
        elif role=='unaccounted_paper':entry['classification']='unaccounted_paper_popup_anchor';anchor_invalid('unaccounted_paper_popup_anchor')
        elif paper:entry['classification']='orphan_paper_anchor';anchor_invalid('orphan_paper_anchor')
        elif entry['officialHttps']and is_known_history_electronic(normalized,normalized_source):entry['classification']='orphan_history_electronic_anchor';anchor_invalid('orphan_history_electronic_anchor')
        result['orderedAnchors'].append(entry)
    if len(result['currentPaperUrls'])!=1:invalid('current_paper_url_count_not_one')
    history_keys={collision_key(url)for url in history_role_urls}
    if any(collision_key(url)in history_keys for url in current_role_urls):invalid('current_historical_url_role_collision')
    result['allScopedAnchorsAccounted']=not any(entry['invalidReasons']for entry in result['orderedAnchors'])and not result['orderedScopedResources']
    result['associationValid']=not reasons
    result['limitation']='Only literal raw-DOM attachment association and complete branch inventory are established. Child identity, PDF content/layout, active index binding and publication eligibility require independent verification.'
    return result

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--raw',type=pathlib.Path,required=True);parser.add_argument('--source-url',required=True);args=parser.parse_args(argv)
    with args.raw.open('rb')as stream:raw=stream.read(MAX_PARENT_BYTES+1)
    if len(raw)>MAX_PARENT_BYTES:
        print(json.dumps({'schema':SCHEMA,'schemaVersion':SCHEMA_VERSION,'parserVersion':PARSER_VERSION,'scope':SCOPE,'sourceUrl':args.source_url,'rawSha256':None,'rawBytes':None,'rawBytesObservedAtLeast':len(raw),'associationValid':False,'invalidReasons':['parent_raw_exceeds_15mb'],'networkRequests':0}));return 0
    print(json.dumps(inspect_parent(raw,args.source_url),ensure_ascii=False));return 0
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as error:print(json.dumps({'associationValid':False,'errorType':type(error).__name__,'error':'parent_raw_inspection_failed'}),file=sys.stderr);sys.exit(1)
