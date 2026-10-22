"""No network: enforce the boundaries of administrative OCR drafts."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("scan_drafts", Path(__file__).resolve().parents[1] / "tools/transcribe-tfda-scans.py")
SCAN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCAN)


class ScanDraftTests(unittest.TestCase):
    def response(self, **changes):
        body = {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({
            "text": "每錠含200mg。初期1.5～3mg；維持0.5～1.5mg。",
            "uncertain_spans": [], "visual_objects": []})}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 40, "total_tokens": 140}}
        body.update(changes)
        return body

    def test_numeric_diagnostics_do_not_remove_leading_digits_or_decimals(self):
        text, _ = SCAN.validate_response(self.response())
        self.assertEqual(SCAN.numeric_inventory(text["text"]), ["200mg", "1.5～3mg", "0.5～1.5mg"])

    def test_cutoff_and_refusal_are_not_completed_transcripts(self):
        for finish, refusal in [("length", None), ("stop", "refused"), ("content_filter", None)]:
            body = self.response()
            body["choices"][0]["finish_reason"] = finish
            body["choices"][0]["message"]["refusal"] = refusal
            with self.assertRaisesRegex(ValueError, "incomplete_or_refused"):
                SCAN.validate_response(body)

    def test_missing_usage_and_unexpected_publishable_claim_fail(self):
        with self.assertRaisesRegex(ValueError, "missing_actual_token_usage"):
            SCAN.validate_response(self.response(usage={}))
        body = self.response()
        item = json.loads(body["choices"][0]["message"]["content"])
        item["publishable"] = True
        body["choices"][0]["message"]["content"] = json.dumps(item)
        with self.assertRaisesRegex(ValueError, "invalid_transcript_shape"):
            SCAN.validate_response(body)

    def test_changed_source_or_pixels_rejected_before_key_or_network(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            raw, image, plan = folder / "raw.pdf", folder / "page.png", folder / "plan.json"
            raw.write_bytes(b"%PDF-1.7 example")
            image.write_bytes(b"\x89PNG\r\n\x1a\nexample")
            data = {"schema": SCAN.SCHEMA, "purpose": "nonpublishable_ocr_drafts", "model": "gpt-6-luna", "pages": [{
                "licenseNo": "衛署藥製字第033934號", "page": 1,
                "rawPath": str(raw), "rawSha256": SCAN.digest(raw.read_bytes()),
                "imagePath": str(image), "imageSha256": SCAN.digest(image.read_bytes())}]}
            plan.write_text(json.dumps(data), encoding="utf-8")
            pin = SCAN.digest(plan.read_bytes())
            self.assertEqual(len(SCAN.load_plan(str(plan), pin)[1]), 1)
            image.write_bytes(image.read_bytes() + b"changed")
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                SCAN.load_plan(str(plan), pin)


if __name__ == "__main__":
    unittest.main()
