"""Raw parent association, exhaustive branch inventory and parser divergence."""
import pathlib,importlib.util,unittest,hashlib,json,sys,subprocess,tempfile
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('parent_paper',ROOT/'tools/inspect-tfda-parent-paper.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
SOURCE='https://mcp.fda.gov.tw/im_detail_1/test'
HEADERS='<h2 class="page_name">登入</h2><div class="page_name"><label>許可證號</label><span>衛署藥製字第011202號</span></div><div class="page_name"><label>中文品名</label><span>測試錠</span></div><div class="page_name"><label>藥品類別</label><span>醫師處方藥</span></div>'
CLOSE='<a class="popup_close tstn_3" data-popup_close href="#">✖</a>'
def popup(content,title=module.CURRENT_TITLE,marker='popup-new2'):
    return '<div class="popup" data_popup="'+marker+'"><span class="pagetitle">'+title+'</span>'+content+CLOSE+'</div>'
def document(current='<a href="/fileshow/child?c=2">child.pdf</a>',history='',extra=''):
    return ('<html>'+HEADERS+popup(current)+history+extra+'</html>').encode('utf8')
def inspect(raw):return module.inspect_parent(raw,SOURCE)

class ParentPaperTests(unittest.TestCase):
    def test_single_current_and_exact_close_inventory_without_leaflet_body(self):
        raw=document();r=inspect(raw)
        self.assertTrue(r['associationValid']);self.assertEqual(r['schema'],'tfda-parent-paper-association/v1');self.assertEqual(r['rawSha256'],hashlib.sha256(raw).hexdigest());self.assertEqual(r['rawBytes'],len(raw))
        self.assertEqual(r['currentPaperUrls'],['https://mcp.fda.gov.tw/fileshow/child?c=2']);self.assertTrue(r['allScopedAnchorsAccounted']);self.assertEqual(len(r['orderedAnchors']),2);self.assertEqual(r['orderedAnchors'][1]['classification'],'ignored_exact_popup_close_ui')
        self.assertEqual(r['identityFields']['許可證號'],'衛署藥製字第011202號');self.assertEqual(r['parserHelperSha256'],hashlib.sha256((ROOT/'tools/inspect-tfda-parent-paper.py').read_bytes()).hexdigest());self.assertEqual(r['fetchDependencySha256'],hashlib.sha256((ROOT/'tools/fetch-tfda-sources.py').read_bytes()).hexdigest());self.assertEqual(r['networkRequests'],0)

    def test_explicit_history_electronic_is_excluded_and_fully_inventoried(self):
        history=popup('<a href="/im_detail_1/test?item=123">檢視</a>',module.HISTORY_TITLE,'popup-history');r=inspect(document(history=history))
        self.assertTrue(r['associationValid']);self.assertEqual(r['historicalOtherUrls'],['https://mcp.fda.gov.tw/im_detail_1/test?item=123']);self.assertEqual(r['historicalOtherUrls'],r['excludedHistoricalElectronicUrls']);self.assertEqual(r['historicalPaperUrls'],[])
        self.assertEqual([a['classification']for a in r['orderedAnchors']].count('excluded_history_electronic'),1)

    def test_history_paper_always_blocks_first_scope(self):
        r=inspect(document(history=popup('<a href="/fileshow/old">old.pdf</a>',module.HISTORY_TITLE,'popup-history')))
        self.assertFalse(r['associationValid']);self.assertIn('historical_paper_present_outside_first_scope',r['invalidReasons']);self.assertEqual(r['historicalPaperUrls'],['https://mcp.fda.gov.tw/fileshow/old'])

    def test_every_unsupported_current_anchor_is_retained_and_blocks(self):
        r=inspect(document(current='<a href="/fileshow/good">good</a><a href="https://evil.example/other.pdf">other</a><a href="/unexpected">unknown</a>'))
        self.assertFalse(r['associationValid']);self.assertEqual(len(r['orderedAnchors']),4);self.assertIn('current_link_not_official_https',r['invalidReasons']);self.assertIn('unsupported_current_link',r['invalidReasons']);self.assertEqual(r['currentOtherUrls'],['https://mcp.fda.gov.tw/unexpected'])

    def test_mixed_titles_unknown_marker_and_multiple_current_popups_block(self):
        for raw in [document(extra=popup('<a href="/fileshow/other">other</a>')),('<html>'+HEADERS+popup('<span class="pagetitle">歷史仿單</span><a href="/fileshow/child">x</a>')+'</html>').encode(),('<html>'+HEADERS+popup('<a href="/fileshow/child">x</a>',marker='unrelated')+'</html>').encode()]:
            with self.subTest(raw=raw[:40]):
                r=inspect(raw);self.assertFalse(r['associationValid']);self.assertTrue(r['invalidReasons'])

    def test_orphan_pdf_and_unknown_popup_are_not_silently_dropped(self):
        for extra in ['<a href="/fileshow/orphan">orphan</a>',popup('<a href="/insert/pdfcasefile/x">x</a>',title='未知分支',marker='unrelated')]:
            r=inspect(document(extra=extra));self.assertFalse(r['associationValid']);self.assertIn('orphan_paper_anchor',r['invalidReasons'])

    def test_role_collision_blocks_even_when_pdf_query_order_differs(self):
        r=inspect(document(current='<a href="/fileshow/child?a=1&b=2">c</a>',history=popup('<a href="/fileshow/child?b=2&a=1">h</a>',module.HISTORY_TITLE,'popup-history')))
        self.assertIn('current_historical_url_role_collision',r['invalidReasons']);self.assertFalse(r['associationValid'])

    def test_history_nonofficial_unknown_and_wrong_detail_path_are_inventory_failures(self):
        for href in ['https://evil.example/history','/unrecognized?item=123','/im_detail_1/other?item=123','/im_detail_1/test?item=not_numeric','/im_detail_1/test?item=1&item=2']:
            r=inspect(document(history=popup('<a href="'+href+'">h</a>',module.HISTORY_TITLE,'popup-history')));self.assertFalse(r['associationValid']);self.assertEqual(len(r['historicalOtherUrls']),1);self.assertEqual(r['excludedHistoricalElectronicUrls'],[])

    def test_duplicate_href_browser_first_and_parser_last_cannot_pass(self):
        r=inspect(document(current='<a href="/fileshow/other-child" href="/fileshow/child">x</a>'))
        self.assertFalse(r['associationValid']);self.assertIn('duplicate_html_attribute',r['invalidReasons']);self.assertEqual(r['orderedAnchors'][0]['hrefOccurrences'],['/fileshow/other-child','/fileshow/child']);self.assertEqual(r['duplicateAttributeEvidence'][0]['literalValues'],['/fileshow/other-child','/fileshow/child'])

    def test_duplicate_role_marker_browser_first_and_parser_last_cannot_pass(self):
        raw=document().replace(b'data_popup="popup-new2"',b'data_popup="popup-history" data_popup="popup-new2"');r=inspect(raw)
        self.assertFalse(r['associationValid']);self.assertIn('duplicate_html_attribute',r['invalidReasons']);self.assertEqual(r['orderedPopups'][0]['originalDataPopupOccurrences'],['popup-history','popup-new2'])

    def test_only_identical_rel_duplicate_has_explicit_nonrouting_exception(self):
        r=inspect(document(current='<a rel="noopener noreferrer" rel="noopener noreferrer" href="/fileshow/child">x</a>'))
        self.assertTrue(r['associationValid']);e=r['duplicateAttributeEvidence'][0];self.assertEqual(e['classification'],'identical_rel_no_routing_effect');self.assertFalse(e['fatal']);self.assertEqual(e['valueSha256'][0],e['valueSha256'][1])
        for current in ['<a rel="noopener" rel="noreferrer" href="/fileshow/child">x</a>','<a rel rel href="/fileshow/child">x</a>','<a rel="" rel="" href="/fileshow/child">x</a>','<a rel="noopener" rel="noopener" href="/fileshow/child">x</a>','<a href="/fileshow/child" href="/fileshow/child">x</a>','<a class="download" class="download" href="/fileshow/child">x</a>']:
            r=inspect(document(current=current));self.assertFalse(r['associationValid']);self.assertIn('duplicate_html_attribute',r['invalidReasons'])

    def test_base_element_is_rejected_even_with_official_base(self):
        for target in ['https://example.invalid/','https://mcp.fda.gov.tw/']:
            r=inspect(document(extra='<base href="'+target+'">'));self.assertFalse(r['associationValid']);self.assertIn('html_base_element_not_supported',r['invalidReasons']);self.assertEqual(len(r['baseElementEvidence']),1)

    def test_duplicate_identity_conflict_and_unknown_heading_block(self):
        for extra in ['<div class="page_name"><label>中文品名</label><span>其他錠</span></div>','<h2 class="page_name">未交代品項</h2>']:
            r=inspect(document(extra=extra));self.assertFalse(r['associationValid'])
        self.assertIn('conflicting_duplicate_identity_label',inspect(document(extra='<div class="page_name"><label>中文品名</label><span>其他錠</span></div>'))['invalidReasons'])

    def test_unknown_hash_ui_fragment_malformed_and_nonanchor_controls_block(self):
        for current in ['<a href="#">unaccounted</a>','<a href="/fileshow/child#page=3">x</a>','<a href="https://[malformed">x</a>','<a href="/fileshow/child">x</a><iframe src="/fileshow/other"></iframe>','<a href="/fileshow/child">x</a><button data-id="other">other</button>']:
            r=inspect(document(current=current));self.assertFalse(r['associationValid']);self.assertTrue(r['invalidReasons'])

    def test_duplicate_nonpublic_attribute_evidence_uses_hashes(self):
        r=inspect(document(extra='<input value="secret-a" value="secret-b">'))
        self.assertFalse(r['associationValid']);e=r['duplicateAttributeEvidence'][0];self.assertEqual(e['attribute'],'value');self.assertNotIn('literalValues',e);self.assertEqual(len(e['valueSha256']),2)

    def test_raw_cli_deterministic_hash_and_no_local_path_in_report(self):
        with tempfile.TemporaryDirectory()as temporary:
            path=pathlib.Path(temporary)/'parent.html';path.write_bytes(document());command=[sys.executable,'-X','utf8','-B',str(ROOT/'tools/inspect-tfda-parent-paper.py'),'--raw',str(path),'--source-url',SOURCE]
            a=subprocess.run(command,capture_output=True,timeout=10,check=True);b=subprocess.run(command,capture_output=True,timeout=10,check=True)
            self.assertEqual(a.stdout,b.stdout);self.assertNotIn(str(path).encode(),a.stdout);self.assertTrue(json.loads(a.stdout)['associationValid'])

    def test_source_http_and_oversize_fail_closed(self):
        self.assertFalse(module.inspect_parent(document(),'http://mcp.fda.gov.tw/im_detail_1/test')['associationValid'])
        r=inspect(b'x'*(module.MAX_PARENT_BYTES+1));self.assertFalse(r['associationValid']);self.assertEqual(r['invalidReasons'],['parent_raw_exceeds_15mb'])

if __name__=='__main__':unittest.main()
