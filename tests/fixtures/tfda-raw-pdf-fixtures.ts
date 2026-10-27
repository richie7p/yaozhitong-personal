/** Genuine, deterministic PDFs built without a PDF library. All medicine text is synthetic. */
export const PDF_FIXTURE_NAME_EN = "RAW VERIFIED SYNTHETIC TABLETS 5MG";
export function buildTfdaRawPdf(options: { blankSecondPage?: boolean; largeImage?: boolean; tableGrid?: boolean; twoColumns?: boolean } = {}): Buffer {
  const objects: Buffer[] = [Buffer.alloc(0), Buffer.alloc(0)];
  const add = (text: string | Buffer) => { objects.push(Buffer.isBuffer(text) ? text : Buffer.from(text, "ascii")); return objects.length; };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const image = options.largeImage ? add("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream") : null;
  const first = [PDF_FIXTURE_NAME_EN, "INDICATIONS - SYNTHETIC TEST MATERIAL ONLY",
    "This complete synthetic source exists only for software verification.",
    "Every condition, exception and ordered sentence must remain intact.",
    "Never substitute invented text while retaining an original byte hash.",
    "No sentence in this fixture provides real medication instructions."];
  const second = options.blankSecondPage ? [] : ["WARNINGS AND PRECAUTIONS - SYNTHETIC FIXTURE",
    "Preserve the complete second physical page and its original order.",
    "The synthetic exception applies only when synthetic condition A holds.",
    "This document is test data and does not describe an actual medicine."];
  const pageIds: number[] = [];
  for (const [index, lines] of [first, second].entries()) {
    const escaped = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
    let content = lines.length ? "BT\n/F1 10 Tf\n50 750 Td\n" + lines.map((line, i) => `${i ? "0 -18 Td\n" : ""}(${escaped(line)}) Tj`).join("\n") + "\nET\n" : "q\nQ\n";
    if (image && index === 0) content += "q\n450 0 0 450 50 50 cm\n/Im1 Do\nQ\n";
    if (options.tableGrid && index === 0) {
      content += "q\n1 w\n";
      for (const y of [600, 570, 540, 510, 480]) content += `50 ${y} m 550 ${y} l S\n`;
      for (const x of [50, 300, 550]) content += `${x} 480 m ${x} 600 l S\n`;
      content += "Q\n";
      for (let row = 0; row < 4; row++) {
        const y = 582 - row * 30;
        content += `BT /F1 10 Tf 60 ${y} Td (Condition ${row + 1}) Tj ET\n`;
        content += `BT /F1 10 Tf 310 ${y} Td (Exception ${row + 1}) Tj ET\n`;
      }
    }
    if (options.twoColumns && index === 0) {
      for (let row = 0; row < 20; row++) {
        const y = 620 - row * 18;
        content += `BT /F1 10 Tf 50 ${y} Td (Condition A retains source order.) Tj ET\n`;
        content += `BT /F1 10 Tf 330 ${y} Td (Exception B preserves original scope.) Tj ET\n`;
      }
    }
    const contentId = add(`<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}endstream`);
    const resources = `<< /Font << /F1 ${font} 0 R >> ${image && index === 0 ? `/XObject << /Im1 ${image} 0 R >>` : ""} >>`;
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${contentId} 0 R >>`));
  }
  objects[0] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "ascii");
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`, "ascii");
  const parts = [Buffer.from("%PDF-1.7\n%SYNTHETIC-RAW-FIXTURE\n", "ascii")], offsets: number[] = [];
  let offset = parts[0].length;
  for (const [i, object] of objects.entries()) {
    offsets.push(offset);
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "ascii"), object, Buffer.from("\nendobj\n", "ascii")]);
    parts.push(part); offset += part.length;
  }
  const entries = offsets.map((value) => value.toString().padStart(10, "0") + " 00000 n ").join("\n");
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`, "ascii"));
  return Buffer.concat(parts);
}
