import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const root = path.resolve("public");
const port = Number(process.env.PORT || 5173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/u, "");
  const filePath = path.resolve(root, relative);
  try {
    if (!filePath.startsWith(`${root}${path.sep}`) || !(await stat(filePath)).isFile()) throw new Error("not found");
    res.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Tidak ditemukan.");
  }
}).listen(port, () => console.log(`Pratinjau frontend: http://localhost:${port}`));
