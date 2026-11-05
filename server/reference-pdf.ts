import { Worker } from "node:worker_threads";
import { AdmissionGate } from "./admission.js";

const pdfGate = new AdmissionGate(1, 8, 10000);
export const REFERENCE_PDF_BYTE_LIMIT = 1_000_000;
const textLimit = 24000;

// Self-contained JavaScript is evaluated in an isolated, memory-bounded worker.
// Keeping it inline lets the existing server bundle deploy without loose assets.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const mul = (a,b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
(async () => {
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(workerData), useSystemFonts: false, disableFontFace: true,
    isEvalSupported: false, stopAtErrors: true, verbosity: 0,
    cMapUrl: path.resolve('node_modules/pdfjs-dist/cmaps').replace(/\\/g, '/') + '/',
    cMapPacked: true,
    standardFontDataUrl: path.resolve('node_modules/pdfjs-dist/standard_fonts').replace(/\\/g, '/') + '/',
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages < 1 || pdf.numPages > 20) throw Error('pdf_page_limit');
    const pages = [];
    let total = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      try {
        const content = await page.getTextContent();
        if (content.items.length > 10000) throw Error('pdf_item_limit');
        const items = content.items.filter(x => 'str' in x && x.str.trim());
        if (!items.length) throw Error('pdf_image_only_page');
        const positioned = items.map(item => {
          const t = item.transform;
          if (!Array.isArray(t) || t.length !== 6 || t.some(n => !Number.isFinite(n)) ||
            // A bounded italic shear keeps a horizontal baseline; rotation or
            // vertical text does not. Some hospital titles use this matrix.
            item.dir === 'ttb' || Math.abs(t[1]) > 0.1 || Math.abs(t[2]) > Math.abs(t[3]) * 0.5 + 0.1 || t[0] <= 0 || t[3] <= 0)
            throw Error('pdf_ambiguous_text_direction');
          const height = Math.max(1, Math.abs(item.height || t[3]));
          if (!Number.isFinite(height) || !Number.isFinite(item.width) || item.width < 0)
            throw Error('pdf_invalid_text_geometry');
          return { str: item.str, x: t[4], y: t[5], right: t[4] + item.width, height };
        });
        // Only marginal headers/footers may be painted separately. A reset
        // inside the main text can be a second column, so do not repair it.
        const view = page.view, pageHeight = Math.abs(view[3] - view[1]);
        let priorBody;
        for (const item of positioned) {
          if (item.y <= view[1] + pageHeight * 0.1 || item.y >= view[3] - pageHeight * 0.15) continue;
          if (priorBody && item.y > priorBody.y + Math.max(5, item.height * 0.9))
            throw Error('pdf_ambiguous_reading_order');
          priorBody = item;
        }
        // PDF drawing order is not reading order: a single-column document may
        // paint its footer first. Recover only the order visible in its text
        // coordinates, retaining every item and every physical page.
        const rows = [];
        for (const item of positioned.sort((a,b) => b.y - a.y || a.x - b.x)) {
          let row = rows[rows.length - 1];
          if (!row || Math.abs(item.y - row.y) > Math.max(2, Math.min(item.height, row.height) * 0.35)) {
            row = { y: item.y, height: item.height, items: [] };
            rows.push(row);
          }
          row.items.push(item);
        }
        // Check spatial layout before concatenation. Repeated separated cells
        // remain ambiguous tables/parallel columns regardless of stream order.
        const wideGapRows = new Set();
        for (const [index,row] of rows.entries()) {
          row.items.sort((a,b) => a.x - b.x);
          if (row.items.some((item,i) => i && item.x - row.items[i-1].right > Math.max(36, item.height * 4)))
            wideGapRows.add(index);
          row.left = row.items[0].x;
          row.right = Math.max(...row.items.map(item => item.right));
        }
        // Parallel columns may have slightly staggered baselines. Adjacent
        // rows that occupy disjoint horizontal bands are still ambiguous.
        for (let i = 1; i < rows.length; i++) {
          const above = rows[i-1], below = rows[i];
          const height = Math.max(above.height, below.height);
          if (above.y - below.y <= height * 0.9 &&
            Math.max(below.left - above.right, above.left - below.right) > Math.max(36, height * 4))
            wideGapRows.add(i);
        }
        if (wideGapRows.size >= 3) throw Error('pdf_ambiguous_columns_or_table');
        let text = '';
        for (const row of rows) {
          text += row.items.map(item => item.str).join(' ') + '\n';
          if (text.length + total > 24000) throw Error('pdf_text_limit');
        }
        if (text.trim().length < 40 || /\uFFFD/.test(text)) throw Error('pdf_incomplete_text');
        // Reject dominant scanned regions; small logos may accompany real text.
        const ops = await page.getOperatorList();
        if (ops.fnArray.length > 30000) throw Error('pdf_operator_limit');
        const area = Math.abs((view[2] - view[0]) * (view[3] - view[1]));
        let matrix = [1,0,0,1,0,0], stack = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i], args = ops.argsArray[i];
          if (fn === OPS.save) stack.push([...matrix]);
          else if (fn === OPS.restore) matrix = stack.pop() || [1,0,0,1,0,0];
          else if (fn === OPS.transform) matrix = mul(matrix, args);
          else if ([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(fn)) {
            if (Math.abs(matrix[0]*matrix[3] - matrix[1]*matrix[2]) > area * 0.3)
              throw Error('pdf_dominant_image');
          } else if ([OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintInlineImageXObjectGroup].includes(fn))
            throw Error('pdf_complex_images');
        }
        const complete = text.trim();
        pages.push(complete);
        total += complete.length + 2;
        if (total > 24000) throw Error('pdf_text_limit');
      } finally { page.cleanup(); }
    }
    parentPort.postMessage({ text: pages.join('\n\n') });
  } finally { await task.destroy(); }
})().catch(() => parentPort.postMessage({ error: 'unreadable_reference_pdf' }));
`;

function extractInWorker(bytes: Buffer, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true, workerData: new Uint8Array(bytes), stdout: true, stderr: true,
      // The self-contained CommonJS worker must not inherit test loaders or an
      // interactive parent's --input-type=module flag.
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    worker.stdout?.on("data", () => {});
    worker.stderr?.on("data", () => {});
    let settled = false;
    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      // Do not release the single-worker slot before the parser is terminated.
      void worker.terminate().then(
        () => error ? reject(error) : resolve(text!),
        () => reject(new Error("reference_pdf_cleanup_failed")),
      );
    };
    const abort = () => finish(new Error("reference_pdf_aborted"));
    const timer = setTimeout(() => finish(new Error("reference_pdf_deadline")), 7000);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("error", () => finish(new Error("unreadable_reference_pdf")));
    worker.once("exit", () => { if (!settled) finish(new Error("unreadable_reference_pdf")); });
    worker.once("message", (value: { text?: unknown }) => {
      if (typeof value?.text !== "string" || !value.text || value.text.length > textLimit)
        finish(new Error("unreadable_reference_pdf"));
      else finish(undefined, value.text);
    });
    if (signal.aborted) abort();
  });
}

/** Complete single-column text in spatial order; no OCR, clipping or generated replacement. */
export async function readReferencePdf(bytes: Buffer, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (bytes.length > REFERENCE_PDF_BYTE_LIMIT || bytes.subarray(0, 5).toString() !== "%PDF-")
    throw Error("invalid_reference_pdf");
  let abort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("reference_pdf_aborted"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      pdfGate.run(() => extractInWorker(bytes, signal)), deadline,
    ]);
  } finally { signal.removeEventListener("abort", abort); }
}
