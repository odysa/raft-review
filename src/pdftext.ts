// Server-side PDF text extraction with the same PDF.js version and the same
// joining rule as the browser, so offsets agree on both sides.

let lib: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | null = null;

export async function extractPdfText(data: Uint8Array): Promise<string> {
  lib ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = await lib;
  const doc = await pdfjs.getDocument({
    data: data.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? (item.str ?? "") + (item.hasEOL ? "\n" : "") : "")).join(""));
      page.cleanup();
    }
    return pages.join("\f");
  } finally {
    await doc.destroy();
  }
}
