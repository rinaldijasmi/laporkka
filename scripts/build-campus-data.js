// Menyalin public/js/campus-data.js menjadi modul TypeScript untuk Edge Function.
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../public/js/campus-data.js", import.meta.url), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const data = sandbox.window.LAPORKKA_CAMPUS;
const output = `// Dihasilkan oleh scripts/build-campus-data.js dari public/js/campus-data.js. Jangan diedit manual.
export const CAMPUS_DATA = ${JSON.stringify(data, null, 2)} as const;
`;
writeFileSync(new URL("../supabase/functions/_shared/campus-data.ts", import.meta.url), output);
console.log(`Fakultas: ${data.faculties.length}, kampus: ${data.campuses.length}`);
