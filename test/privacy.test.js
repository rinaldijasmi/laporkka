import test from "node:test";
import assert from "node:assert/strict";
import { findRelevantArticles } from "../supabase/functions/_shared/ai-analysis.ts";
import { redactReportText, USER_ROLES } from "../supabase/functions/_shared/privacy.ts";

test("redacts reporter and reported identities, NIM, email and phone from narrative", () => {
  const text = "Rina Putri (NIM 12345678) menghubungi saya di rina@example.com atau 081234567890.";
  const safe = redactReportText(text, ["Rina Putri", "Budi Santoso", "12345678"]);

  assert.doesNotMatch(safe, /Rina Putri|12345678|rina@example\.com|081234567890/u);
  assert.match(safe, /\[DIHAPUS\]/u);
});

test("matches relevant articles using article text and title", () => {
  const articles = [
    { article: 11, title: "Perundungan dan mahasiswa", text: "larangan perundungan kekerasan ancaman" },
    { article: 15, title: "Proses pembelajaran", text: "kelas laboratorium akademik" },
  ];

  assert.deepEqual(
    findRelevantArticles(articles, "perundungan dan ancaman mahasiswa", 1).map((article) => article.article),
    [11],
  );
});

test("contains all configured institutional roles", () => {
  assert.equal(USER_ROLES.length, 16);
  assert.ok(USER_ROLES.includes("Kemahasiswaan TUP"));
});
