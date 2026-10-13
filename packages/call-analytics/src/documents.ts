import type { KnowledgePage } from "./knowledge";
import { fileURLToPath } from "node:url";

export async function documentPages(file: Uint8Array, extension: string): Promise<KnowledgePage[]> {
  if (extension === ".txt" || extension === ".md") return [{ page: null, text: new TextDecoder("utf-8", { fatal: true }).decode(file) }];
  if (extension !== ".pdf" || new TextDecoder().decode(file.subarray(0, 5)) !== "%PDF-") throw new Error("PDF veya UTF-8 .txt/.md dokümanı gerekli.");
  // This module is used only by the importer, never bundled into the analysis Lambda.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const moduleUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(file), useSystemFonts: false,
    standardFontDataUrl: fileURLToPath(new URL("../../standard_fonts/", moduleUrl)),
    cMapUrl: fileURLToPath(new URL("../../cmaps/", moduleUrl)), cMapPacked: true });
  const document = await task.promise;
  try {
    if (document.numPages > 500) throw new Error("Doküman en fazla 500 sayfa olabilir.");
    const pages: KnowledgePage[] = [];
    for (let page = 1; page <= document.numPages; page++) {
      const content = await (await document.getPage(page)).getTextContent();
      let text = "", lastY: number | undefined;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform[5];
        if (lastY !== undefined && Math.abs(lastY - y) > 3 && !text.endsWith("\n")) text += "\n";
        text += item.str + (item.hasEOL ? "\n" : " "); lastY = y;
      }
      pages.push({ page, text });
    }
    return pages;
  } finally { await task.destroy(); }
}
