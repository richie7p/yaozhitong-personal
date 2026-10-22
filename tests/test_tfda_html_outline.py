import importlib.util
from pathlib import Path
import unittest


_SPEC = importlib.util.spec_from_file_location('tfda_fetch_outline', Path(__file__).resolve().parents[1] / 'tools' / 'fetch-tfda-sources.py')
fetch = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(fetch)
URL = 'https://mcp.fda.gov.tw/exportpdf/衛署藥製字第012345號'


def page(body, title='5 警語及注意事項'):
    return ('<!doctype html><html><body><div class="toggle-all"><div class="toggle">'
            '<div class="toggle-title"><span class="title-name">' + title + '</span></div>'
            '<div class="toggle-inner"><div class="inner">' + body + '</div></div>'
            '</div></div></body></html>').encode()


def nested(child=None, outer='5.1'):
    child = child if child is not None else '<tr><td>5.1.1</td><td><p>駕車時須特別小心。</p></td></tr><tr><td>5.1.2</td><td>不可與酒精同用。</td></tr>'
    return '<table><tbody><tr><td>' + outer + '</td><td>警語/注意事項</td></tr><tr><td></td><td><table><tbody>' + child + '</tbody></table></td></tr></tbody></table>'


class HtmlNumberedOutlineTests(unittest.TestCase):
    def inspect(self, body):
        return fetch.inspect_html_outline(page(body), URL)

    def assert_held(self, body):
        result = self.inspect(body)
        self.assertEqual(result['status'], 'needs_review')
        self.assertTrue(result['hasUnverifiedNonTextContent'])
        return result

    def test_nested_section_outline_preserves_rows_cells_and_source(self):
        result = self.inspect(nested())
        self.assertEqual(result['schemaVersion'], 5)
        self.assertEqual(result['parserVersion'], 'tfda-complete-dom-outline-v1')
        self.assertEqual(result['tableSerializationVersion'], 'tfda-numbered-outline-literal-v1')
        self.assertEqual(result['status'], 'independent_dom_extracted_draft')
        self.assertEqual(result['complexTableCount'], 0)
        self.assertEqual(result['originalNormalizedDomSha256'], result['serializedNormalizedDomSha256'])
        proof = result['numberedOutlineEvidence']
        self.assertEqual(proof['status'], 'verified')
        self.assertEqual(proof['tableCount'], 2)
        self.assertEqual(proof['newlySupportedComplexTableCount'], 1)
        self.assertIn('5.1\t警語/注意事項', result['normalizedSectionText'])
        self.assertIn('\t5.1.1\t駕車時須特別小心。', result['normalizedSectionText'])
        self.assertIn('\t5.1.2\t不可與酒精同用。', result['normalizedSectionText'])
        self.assertFalse(result['sections'][0]['tables'][0]['simple'])

    def test_nested_blank_continuation_inherits_explicit_enclosing_row_only(self):
        result = self.inspect(nested('<tr><td></td><td>原始來源寫明的內容。</td></tr>'))
        self.assertEqual(result['status'], 'independent_dom_extracted_draft')
        child = result['numberedOutlineEvidence']['roots'][0]['table']['rows'][1]['rightPieces'][0]['table']
        self.assertTrue(child['inheritedScope'])
        self.assertEqual(child['scope'], '5.1')
        self.assertTrue(child['rows'][0]['continuation'])
        self.assertEqual(child['rows'][0]['scope'], '5.1')

    def test_top_level_blank_label_cannot_invent_an_enclosing_scope(self):
        self.assert_held('<table><tr><td></td><td>' + nested() + '</td></tr></table>')

    def test_multiple_top_level_outline_roots_keep_original_order(self):
        body = nested() + nested('<tr><td>5.2.1</td><td>另一個獨立項目。</td></tr>', '5.2')
        result = self.inspect(body)
        self.assertEqual(result['status'], 'independent_dom_extracted_draft')
        self.assertEqual([x['table']['rows'][0]['label'] for x in result['numberedOutlineEvidence']['roots']], ['5.1', '5.2'])

    def test_same_identifier_in_two_roots_is_not_deduplicated_or_accepted(self):
        self.assert_held(nested() + nested())

    def test_unordered_sibling_identifiers_are_held(self):
        self.assert_held(nested('<tr><td>5.1.2</td><td>甲。</td></tr><tr><td>5.1.1</td><td>乙。</td></tr>'))

    def test_wrong_section_or_hierarchy_depth_is_held(self):
        for label in ['6.1.1', '5.2.1', '5.1.1.1', '0.5', '5.1mg']:
            with self.subTest(label=label):
                self.assert_held(nested('<tr><td>' + label + '</td><td>有文字。</td></tr>'))

    def test_three_column_dose_matrix_is_not_an_outline(self):
        self.assert_held(nested('<tr><td>5.1.1</td><td>體重</td><td>每日劑量</td></tr><tr><td>10</td><td>20</td><td>30</td></tr>'))

    def test_unlabelled_numeric_dose_grid_is_held(self):
        self.assert_held(nested('<tr><td>0.5</td><td>10 mg</td></tr><tr><td>1.0</td><td>20 mg</td></tr>'))

    def test_spanning_or_ragged_cells_are_held(self):
        for child in ['<tr><td rowspan="2">5.1.1</td><td>甲。</td></tr>', '<tr><td colspan="2">5.1.1</td><td>甲。</td></tr>', '<tr><td>5.1.1</td></tr>']:
            with self.subTest(child=child):
                self.assert_held(nested(child))

    def test_media_or_unknown_markup_cannot_disappear_as_empty_text(self):
        for element in ['<img src="warning.png" alt="">', '<svg><text>警語</text></svg>', '<canvas>警語</canvas>', '<iframe src="x"></iframe>', '<object>警語</object>', '<figure>警語</figure>', '<script>醫療正文</script>', '<a href="x">醫療連結</a>']:
            with self.subTest(element=element):
                self.assert_held(nested('<tr><td>5.1.1</td><td>甲。' + element + '</td></tr>'))

    def test_unknown_text_outside_rows_or_cells_is_held(self):
        self.assert_held(nested().replace('<tbody>', '<tbody>不可略過的警語', 1))
        self.assert_held(nested().replace('<tr>', '<tr>不可略過的警語', 1))

    def test_nested_table_in_label_cell_is_held(self):
        self.assert_held(nested('<tr><td><table><tr><td>5.1.1</td><td>甲</td></tr></table></td><td>乙</td></tr>'))

    def test_real_cross_grid_sibling_remains_pending_even_with_one_valid_outline(self):
        grid = '<table><tr><td colspan="2">體重／劑量</td></tr><tr><td>10 kg</td><td>20 mg</td></tr></table>'
        result = self.assert_held(nested() + grid)
        self.assertGreater(result['complexTableCount'], 0)

    def test_empty_right_cell_is_not_replaced_with_missing_information(self):
        self.assert_held(nested('<tr><td>5.1.1</td><td></td></tr>'))

    def test_legacy_default_is_unchanged_and_never_claims_outline_proof(self):
        raw = page(nested())
        before = fetch.inspect_html(raw, URL)
        self.assertEqual(before['schemaVersion'], 4)
        self.assertEqual(before['tableSerializationVersion'], 'tfda-simple-table-literal-v1')
        self.assertEqual(before['status'], 'needs_review')
        self.assertEqual(before['complexTableCount'], 1)
        self.assertNotIn('numberedOutlineEvidence', before)
        fetch.inspect_html_outline(raw, URL)
        self.assertEqual(before, fetch.inspect_html(raw, URL))

    def test_plain_legacy_table_stays_simple_without_opt_in_capability(self):
        raw = page('<table><tr><td>成人</td><td>一錠</td></tr><tr><td>兒童</td><td>依醫師指示</td></tr></table>')
        report = fetch.inspect_html(raw, URL)
        self.assertEqual(report['status'], 'independent_dom_extracted_draft')
        self.assertTrue(report['sections'][0]['tables'][0]['simple'])
        self.assertEqual(report['tableSerializationVersion'], 'tfda-simple-table-literal-v1')
        self.assert_held('<table><tr><td>成人</td><td>一錠</td></tr></table>')


if __name__ == '__main__':
    unittest.main()
