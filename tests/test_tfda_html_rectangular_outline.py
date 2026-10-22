import importlib.util
from pathlib import Path
import unittest

_SPEC=importlib.util.spec_from_file_location('fetch_rectangular',Path(__file__).resolve().parents[1]/'tools/fetch-tfda-sources.py')
fetch=importlib.util.module_from_spec(_SPEC);_SPEC.loader.exec_module(fetch)
URL='https://mcp.fda.gov.tw/exportpdf/衛署藥製字第012345號'
def page(body):
    return ('<html><body><div class="toggle-all"><div class="toggle"><div class="toggle-title"><span class="title-name">5 警語及注意事項</span></div><div class="toggle-inner">'+body+'</div></div></div></body></html>').encode()
def outer(child):
    return '<table><tr><td>5.1</td><td>警語及注意事項</td></tr><tr><td></td><td>'+child+'</td></tr></table>'
def grid():
    return '<table><thead><tr><th>年齡</th><th>單次用量</th><th>頻次</th></tr></thead><tbody><tr><td>成人</td><td>10 mg</td><td>每日一次</td></tr><tr><td>兒童</td><td>不得使用</td><td>不得使用</td></tr></tbody></table>'
def figure(child):return '<figure class="table">'+child+'</figure>'
class RectangularOutlineTests(unittest.TestCase):
    def inspect(self,child):return fetch.inspect_html_outline(page(outer(child)),URL,True)
    def held(self,child):
        result=self.inspect(child);self.assertEqual(result['status'],'needs_review');self.assertTrue(result['hasUnverifiedNonTextContent'])
    def test_full_rectangular_grid_is_literal_not_numbered_hierarchy(self):
        result=self.inspect(figure(grid()));self.assertEqual(result['schemaVersion'],6);self.assertEqual(result['parserVersion'],'tfda-complete-dom-outline-v2');self.assertEqual(result['status'],'independent_dom_extracted_draft')
        proof=result['numberedOutlineEvidence'];self.assertEqual(proof['literalTableIndices'],[1]);self.assertEqual(proof['literalTableCount'],1)
        piece=proof['roots'][0]['table']['rows'][1]['rightPieces'][0];self.assertEqual(piece['kind'],'literal_table');self.assertEqual(piece['table']['columnCount'],3);self.assertEqual(piece['table']['rowCount'],3)
        self.assertIn('年齡\t單次用量\t頻次',piece['table']['serializedText']);self.assertIn('成人\t10 mg\t每日一次',piece['table']['serializedText']);self.assertEqual(piece['table']['rows'][0][0]['tag'],'th')
        self.assertEqual(result['originalNormalizedDomSha256'],result['serializedNormalizedDomSha256']);self.assertEqual(result['complexTableCount'],0)
    def test_direct_plain_subtable_is_supported_without_figure(self):
        result=self.inspect(grid());self.assertEqual(result['status'],'independent_dom_extracted_draft');self.assertIsNone(result['numberedOutlineEvidence']['roots'][0]['table']['rows'][1]['rightPieces'][0]['table']['wrapper'])
    def test_explicit_opt_in_does_not_change_old_v1(self):
        self.assertEqual(fetch.inspect_html_outline(page(outer(figure(grid()))),URL)['schemaVersion'],5)
        self.assertEqual(fetch.inspect_html_outline(page(outer(figure(grid()))),URL)['status'],'needs_review')
    def test_figure_layout_attrs_are_recorded_and_unknown_styles_held(self):
        result=self.inspect(figure(grid()).replace('class="table"','class="table" style="float:left;width:94.04%;"'));self.assertEqual(result['status'],'independent_dom_extracted_draft')
        self.held(figure(grid()).replace('class="table"','class="table" style="order:2;"'))
    def test_span_ragged_and_nested_grids_are_held(self):
        for child in [grid().replace('<td>成人','<td colspan="2">成人'),grid().replace('<td>10 mg</td>',''),grid().replace('<td>10 mg</td>','<td><table><tr><td>10 mg</td></tr></table></td>')]:
            with self.subTest(child=child):self.held(figure(child))
    def test_real_media_and_unknown_inline_content_are_held(self):
        for node in ['<img src="warning.png" alt="">','<svg></svg>','<canvas></canvas>','<iframe></iframe>','<script>正文</script>','<ul><li>條件</li></ul>']:
            with self.subTest(node=node):self.held(figure(grid().replace('10 mg','10 mg'+node)))
    def test_extra_figure_text_caption_or_sibling_table_cannot_disappear(self):
        for child in [figure(grid()+'不可略過的警語'),figure(grid()+'<figcaption>條件</figcaption>'),figure(grid()+grid()),'<figure>'+grid()+'</figure>']:
            with self.subTest(child=child):self.held(child)
    def test_literal_fallback_cannot_hide_bad_numbered_scope(self):
        for label in ['6.1.1','5.2.1','5.1.1.1']:
            with self.subTest(label=label):self.held('<table><tr><td>'+label+'</td><td>條件</td></tr></table>')
    def test_blank_top_level_still_has_no_scope(self):
        result=fetch.inspect_html_outline(page('<table><tr><td></td><td>'+figure(grid())+'</td></tr></table>'),URL,True);self.assertEqual(result['status'],'needs_review')
    def test_empty_layout_table_retains_full_zero_text_inventory(self):
        result=self.inspect('<table><tbody></tbody></table>'+figure(grid()));self.assertEqual(result['status'],'independent_dom_extracted_draft')
        piece=result['numberedOutlineEvidence']['roots'][0]['table']['rows'][1]['rightPieces'][0];self.assertEqual(piece['kind'],'literal_empty_table');self.assertEqual(piece['table']['rowCount'],0);self.assertEqual(piece['table']['nodeTagInventory'],['table','tbody'])
    def test_right_cell_containing_only_empty_layout_is_retained(self):
        result=fetch.inspect_html_outline(page('<table><tr><td>5.1</td><td>警語</td></tr><tr><td></td><td><table><tbody></tbody></table></td></tr><tr><td></td><td>'+figure(grid())+'</td></tr></table>'),URL,True);self.assertEqual(result['status'],'independent_dom_extracted_draft');self.assertEqual(result['numberedOutlineEvidence']['roots'][0]['table']['rows'][1]['rightPieces'][0]['kind'],'literal_empty_table')
    def test_empty_layout_cannot_hide_text_media_or_spans(self):
        for child in ['<table><script>不可略過正文</script></table>','<table><span hidden>不可略過正文</span></table>','<table><img src="warning.png"></table>','<table><tr><td rowspan="2"></td></tr></table>','<table><tr><td colspan="2"></td></tr></table>']:
            with self.subTest(child=child):self.held(child+figure(grid()))
    def test_numeric_dose_values_are_literal_cells(self):
        result=self.inspect(figure('<table><tr><td>體重</td><td>單次用量</td></tr><tr><td>0.5</td><td>10 mg</td></tr><tr><td>1.0</td><td>20 mg</td></tr></table>'));self.assertEqual(result['status'],'independent_dom_extracted_draft');self.assertIn('0.5\t10 mg',result['normalizedSectionText'])
if __name__=='__main__':unittest.main()
