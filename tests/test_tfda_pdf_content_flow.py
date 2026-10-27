"""Complete single-flow recovery; source order and independent agreement stay required."""
import copy
import importlib.util
import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fetch_tfda_content_flow", ROOT / "tools/fetch-tfda-sources.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def glyph(text, x, baseline, width=8):
    return {"text": text, "x0": x, "x1": x + width,
            "top": 200 - baseline - 8, "bottom": 200 - baseline + 2,
            "matrix": (1, 0, 0, 1, x, baseline), "upright": True}


def page():
    return SimpleNamespace(width=200, height=200,
                           chars=[glyph("A", 10, 150), glyph("B", 20, 150),
                                  glyph("C", 10, 130), glyph("D", 20, 130)],
                           extract_text=Mock(return_value="AB\nCD"))


class PdfContentFlowTests(unittest.TestCase):
    def test_complete_original_stream_and_independent_order_are_required(self):
        p = page()
        text, evidence = module.select_pdf_content_flow_text(p, "CD\nAB", "AB\nCD", False)
        self.assertEqual(text, "AB\nCD")
        self.assertTrue(evidence["used"])
        self.assertEqual(evidence["geometry"]["rows"], 2)
        self.assertEqual(evidence["geometry"]["characters"], 4)
        self.assertEqual([g["text"] for g in p.chars], list("ABCD"))
        p.extract_text.assert_called_once_with(use_text_flow=True)

    def test_default_agreement_is_unchanged_and_never_calls_an_alternative(self):
        p = page()
        text, evidence = module.select_pdf_content_flow_text(p, "A B\nC D", "AB CD", False)
        self.assertEqual(text, "A B\nC D")
        self.assertIsNone(evidence)
        p.extract_text.assert_not_called()

    def test_existing_table_column_or_unknown_structure_cannot_use_recovery(self):
        for flag in (True, None, 0, "unknown"):
            p = page()
            self.assertEqual(module.select_pdf_content_flow_text(p, "CD AB", "AB CD", flag), ("CD AB", None))
            p.extract_text.assert_not_called()

    def test_normal_font_kerning_preserves_origins_and_centers(self):
        p = page()
        p.chars[1] = glyph("B", 16, 150)  # Font advance boxes intersect; origins do not stack.
        self.assertTrue(module.prove_pdf_content_flow_geometry(p.chars, 200, 200)["passed"])
        self.assertTrue(module.select_pdf_content_flow_text(p, "CD AB", "AB CD", False)[1]["used"])

    def test_same_line_backtracking_overprints_and_near_stacks_are_rejected(self):
        for x in (5, 10, 10.1):
            with self.subTest(x=x):
                p = page()
                p.chars[1] = glyph("B", x, 150)
                self.assertFalse(module.prove_pdf_content_flow_geometry(p.chars, 200, 200)["passed"])
                self.assertFalse(module.select_pdf_content_flow_text(p, "CD AB", "AB CD", False)[1]["used"])
                p.extract_text.assert_not_called()

    def test_floating_brand_or_second_column_cannot_jump_back_up(self):
        p = page()
        p.chars.extend([glyph("E", 100, 150), glyph("F", 110, 150)])
        self.assertFalse(module.prove_pdf_content_flow_geometry(p.chars, 200, 200)["passed"])

    def test_baseline_anchor_rejects_accumulated_small_upward_moves(self):
        chars = [glyph(chr(65 + n), 10 + n * 12, 100 + n) for n in range(5)]
        self.assertFalse(module.prove_pdf_content_flow_geometry(chars, 200, 200)["passed"])

    def test_missing_raw_character_or_changed_pypdf_or_flow_text_cannot_pass(self):
        for change in (lambda p: p.chars.pop(),
                       lambda p: p.extract_text.configure_mock(return_value="AB\nCE")):
            p = page()
            change(p)
            self.assertFalse(module.select_pdf_content_flow_text(p, "CD AB", "AB CD", False)[1]["used"])
        self.assertFalse(module.select_pdf_content_flow_text(page(), "CD AB", "AB CE", False)[1]["used"])

    def test_character_inventory_is_preserved_not_just_third_engine_agreement(self):
        text, evidence = module.select_pdf_content_flow_text(page(), "ABC", "AB CD", False)
        self.assertEqual(text, "ABC")
        self.assertFalse(evidence["used"])
        self.assertEqual(evidence["reason"], "spatial_character_inventory_changed")

    def test_nonfinite_outside_reversed_or_rotated_geometry_fails_closed(self):
        changes = [lambda c: c.update(x0=float("nan")), lambda c: c.update(x0=-1),
                   lambda c: c.update(x1=0), lambda c: c.update(bottom=c["top"]),
                   lambda c: c.update(matrix=(1, 0, 0, 1, 10, float("inf"))),
                   lambda c: c.update(matrix=(1, .1, 0, 1, 10, 150)),
                   lambda c: c.update(upright=False)]
        for change in changes:
            with self.subTest(change=change):
                chars = copy.deepcopy(page().chars)
                change(chars[0])
                self.assertFalse(module.prove_pdf_content_flow_geometry(chars, 200, 200)["passed"])

    def test_missing_inventory_or_extraction_error_cannot_create_text(self):
        for chars in (None, [], [None], [{"text": "A"}]):
            self.assertFalse(module.prove_pdf_content_flow_geometry(chars, 200, 200)["passed"])
        p = page()
        p.extract_text.side_effect = ValueError("invalid source")
        text, evidence = module.select_pdf_content_flow_text(p, "CD AB", "AB CD", False)
        self.assertEqual(text, "CD AB")
        self.assertFalse(evidence["used"])


if __name__ == "__main__":
    unittest.main()
