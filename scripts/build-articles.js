import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function readEthicsArticles(pdfPath) {
  const parser = new PDFParse({ data: await readFile(pdfPath) });
  try {
    const { text } = await parser.getText();
    const matches = Array.from(text.matchAll(/(?:^|\n)[ \t]*Pasal\s+(\d+)\b([^\n]*)/gu));
    const headings = matches.filter((match) => {
      const continuation = match[2].trim();
      return !/^(?:ayat|angka|huruf|sebagaimana|di atas)\b/iu.test(continuation);
    });
    const articles = new Map();

    for (let index = 0; index < headings.length; index += 1) {
      const match = headings[index];
      const articleNumber = Number(match[1]);
      if (articles.has(articleNumber)) continue;
      const start = match.index + match[0].indexOf("Pasal");
      const end = headings[index + 1]?.index ?? text.length;
      const body = text.slice(start, end)
        .replace(/--\s+\d+\s+of\s+\d+\s+--/gu, "")
        .replace(/Lampiran:\s*PERATURAN UNIVERSITAS TELKOM[\s\S]*?(?=Pasal\s+\d+|$)/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
      const continuation = match[2].trim();
      const title = continuation && !/^\d+\./u.test(continuation)
        ? continuation
        : `Pasal ${articleNumber}`;
      articles.set(articleNumber, {
        article: articleNumber,
        title: title.slice(0, 150),
        text: body.slice(0, 5000),
      });
    }

    if (articles.size === 0) throw new Error("Tidak ditemukan teks pasal pada PDF kode etik.");
    return [...articles.values()];
  } finally {
    await parser.destroy();
  }
}

const pdfPath = path.resolve("public/assets/kode-etik-mahasiswa-2026.pdf");
const outputPath = path.resolve("supabase/functions/_shared/articles.json");
const articles = await readEthicsArticles(pdfPath);
await writeFile(outputPath, `${JSON.stringify(articles, null, 2)}\n`);
console.log(`${articles.length} pasal ditulis ke ${path.relative(process.cwd(), outputPath)}`);
