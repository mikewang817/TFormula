import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  disposeReaderDocument,
  loadReaderDocument,
  toggleReaderPageView,
  type ReaderDocument
} from "../src/reader-document.js";

function minimalPdf(text: string): Buffer {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n`;
  value += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) value += `${String(offset).padStart(10, "0")} 00000 n \n`;
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value, "ascii");
}

const hasPoppler = ["pdfinfo", "pdftotext", "pdftoppm"].every((command) =>
  spawnSync(command, ["-v"], { stdio: "ignore" }).error === undefined);

describe("PDF reader adapter", () => {
  it.runIf(hasPoppler)("extracts reflow text and lazily renders the selected page", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tformula-reader-pdf-test-"));
    const path = join(directory, "paper.pdf");
    await writeFile(path, minimalPdf("Hello from PDF"));
    let document: ReaderDocument | undefined;
    try {
      document = await loadReaderDocument(path);
      expect(document).toMatchObject({ kind: "pdf", label: "PDF reflow" });
      expect(document.source).toContain("Hello from PDF");
      expect(document.pages).toMatchObject({ count: 1, mode: "reflow" });
      expect(document.temporaryPaths).toEqual([]);

      await expect(toggleReaderPageView(document)).resolves.toBe(true);
      expect(document.pages?.mode).toBe("page");
      expect(document.images.size).toBe(1);
      expect([...document.images.values()][0]).toEqual(expect.objectContaining({
        width: expect.any(Number),
        height: expect.any(Number)
      }));
      expect(document.temporaryPaths).toHaveLength(1);
    } finally {
      if (document) await disposeReaderDocument(document);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
