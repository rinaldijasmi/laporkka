import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Busboy = require("busboy");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 3000);
const appOrigin = process.env.APP_ORIGIN || `http://localhost:${port}`;
const secureCookies = process.env.SESSION_COOKIE_SECURE === "true";
const usernameEmailDomain = "login.laporkka.invalid";
const evidenceBucket = "laporkka-evidence";
const maxUploadBytes = 25 * 1024 * 1024;
const maxFiles = 5;
const sessionCookie = "laporkka_access";
const refreshCookie = "laporkka_refresh";
const categories = [
  "Akademik",
  "Etika dan perilaku sosial",
  "Kekerasan, perundungan, dan pelecehan",
  "Digital dan siber",
  "Organisasi dan kegiatan mahasiswa",
  "Fasilitas, lingkungan, dan keamanan",
  "Komersial, perjudian, dan politik",
];
const publicFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/admin.html", ["admin.html", "text/html; charset=utf-8"]],
  ["/css/styles.css", ["css/styles.css", "text/css; charset=utf-8"]],
  ["/css/admin.css", ["css/admin.css", "text/css; charset=utf-8"]],
  ["/js/app.js", ["js/app.js", "text/javascript; charset=utf-8"]],
  ["/js/admin.js", ["js/admin.js", "text/javascript; charset=utf-8"]],
  ["/assets/kode-etik-mahasiswa-2026.pdf", ["assets/kode-etik-mahasiswa-2026.pdf", "application/pdf"]],
]);
const requiredEnvironment = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const limitStore = new Map();
let analyzeReport = null;
let ethicsArticles = [];

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variabel ${name} belum dikonfigurasi.`);
  return value;
}

for (const name of requiredEnvironment) requiredEnv(name);
if (process.env.NODE_ENV === "production" && !secureCookies) {
  throw new Error("SESSION_COOKIE_SECURE harus true pada production.");
}

const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/+$/u, "");
const anonKey = requiredEnv("SUPABASE_ANON_KEY");
const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendError(res, status, message, headers = {}) {
  sendJson(res, status, { error: message }, headers);
}

function appendCookie(res, cookie) {
  const existing = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", existing ? [...[].concat(existing), cookie] : [cookie]);
}

function cookieHeader(name, value, maxAge) {
  const fields = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (secureCookies) fields.push("Secure");
  return fields.join("; ");
}

function clearSession(res) {
  appendCookie(res, cookieHeader(sessionCookie, "", 0));
  appendCookie(res, cookieHeader(refreshCookie, "", 0));
}

function parseCookies(req) {
  const cookies = new Map();
  for (const part of (req.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, "");
    }
  }
  return cookies;
}

function setSession(res, session) {
  appendCookie(res, cookieHeader(sessionCookie, session.access_token, session.expires_in || 3600));
  appendCookie(res, cookieHeader(refreshCookie, session.refresh_token, 60 * 60 * 24 * 30));
}

function requireSameOrigin(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== appOrigin) {
    sendError(res, 403, "Permintaan lintas origin ditolak.");
    return false;
  }
  return true;
}

function checkRateLimit(req, key, max, windowMs) {
  const now = Date.now();
  const forwarded = process.env.TRUST_PROXY === "true"
    ? req.headers["x-forwarded-for"]?.split(",").at(-1)?.trim()
    : null;
  const ip = forwarded || req.socket.remoteAddress || "unknown";
  const bucketKey = `${key}:${ip}`;
  let bucket = limitStore.get(bucketKey);
  if (!bucket || bucket.expiresAt <= now) {
    bucket = { count: 0, expiresAt: now + windowMs };
    limitStore.set(bucketKey, bucket);
  }
  bucket.count += 1;
  return bucket.count <= max;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of limitStore) {
    if (bucket.expiresAt <= now) limitStore.delete(key);
  }
}, 60_000).unref();

async function readRequestBuffer(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Ukuran permintaan terlalu besar.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, maxBytes = 100 * 1024) {
  const buffer = await readRequestBuffer(req, maxBytes);
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    const error = new Error("Format JSON tidak valid.");
    error.statusCode = 400;
    throw error;
  }
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: { fileSize: maxUploadBytes, files: maxFiles, fields: 20, fieldSize: 5000, parts: 25 },
      });
    } catch {
      const error = new Error("Format formulir unggahan tidak valid.");
      error.statusCode = 400;
      reject(error);
      return;
    }

    const fields = {};
    const files = [];
    let totalBytes = 0;
    let parseError = null;

    parser.on("field", (name, value, info) => {
      if (info.nameTruncated || info.valueTruncated) parseError = new Error("Kolom formulir terlalu panjang.");
      fields[name] = value;
    });
    parser.on("file", (name, stream, info) => {
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        totalBytes += chunk.length;
        if (totalBytes > maxUploadBytes) {
          parseError = new Error("Ukuran gabungan lampiran maksimal 25 MB.");
          return;
        }
        chunks.push(chunk);
      });
      stream.on("limit", () => {
        parseError = new Error("Ukuran setiap berkas maksimal 25 MB.");
      });
      stream.on("end", () => {
        if (!size) return;
        files.push({
          fieldName: name,
          originalName: path.basename(info.filename || "bukti"),
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks),
          size,
        });
      });
    });
    parser.on("filesLimit", () => { parseError = new Error(`Maksimal ${maxFiles} berkas bukti.`); });
    parser.on("fieldsLimit", () => { parseError = new Error("Jumlah kolom formulir melebihi batas."); });
    parser.on("partsLimit", () => { parseError = new Error("Jumlah bagian formulir melebihi batas."); });
    parser.on("error", (error) => reject(error));
    parser.on("close", () => {
      if (parseError) {
        parseError.statusCode = 400;
        reject(parseError);
      } else {
        resolve({ fields, files });
      }
    });
    req.pipe(parser);
  });
}

async function supabaseRequest(endpoint, options = {}) {
  const {
    method = "GET",
    body,
    headers = {},
    token = serviceKey,
    key = serviceKey,
    prefer,
    range,
    head = false,
  } = options;
  const requestHeaders = {
    apikey: key,
    Authorization: `Bearer ${token}`,
    ...headers,
  };
  if (body !== undefined && !Buffer.isBuffer(body)) requestHeaders["Content-Type"] = "application/json";
  if (prefer) requestHeaders.Prefer = prefer;
  if (range) {
    requestHeaders.Range = range;
    requestHeaders["Range-Unit"] = "items";
  }
  const response = await fetch(`${supabaseUrl}${endpoint}`, {
    method: head ? "HEAD" : method,
    headers: requestHeaders,
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = head || response.status === 204 ? "" : await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const errorMessage = typeof payload === "string"
      ? payload
      : payload?.message || payload?.msg || payload?.error_description || payload?.error || `Supabase mengembalikan HTTP ${response.status}.`;
    const error = new Error(String(errorMessage));
    error.statusCode = response.status;
    throw error;
  }
  return {
    data: payload,
    count: parseContentRange(response.headers.get("content-range")),
    response,
  };
}

function parseContentRange(header) {
  if (!header) return null;
  const total = header.split("/").at(-1);
  return total === "*" ? null : Number(total);
}

function restQuery(table, entries) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  return `/rest/v1/${table}?${query.toString()}`;
}

async function fetchActiveProfile(userId) {
  const { data } = await supabaseRequest(restQuery("profiles", {
    select: "id,username,role,active",
    id: `eq.${userId}`,
    limit: 1,
  }));
  const profile = data?.[0];
  return profile?.active ? profile : null;
}

async function authenticate(req, res) {
  const cookies = parseCookies(req);
  let accessToken = cookies.get(sessionCookie);
  const refreshToken = cookies.get(refreshCookie);
  const bearer = req.headers.authorization;
  if (!accessToken && bearer?.startsWith("Bearer ")) accessToken = bearer.slice(7);
  if (!accessToken && !refreshToken) {
    sendError(res, 401, "Silakan masuk dengan username Anda.");
    return null;
  }

  let user = null;
  if (accessToken) {
    try {
      const response = await supabaseRequest("/auth/v1/user", { token: accessToken, key: anonKey });
      user = response.data;
    } catch (error) {
      if (!refreshToken || error.statusCode !== 401) {
        clearSession(res);
        sendError(res, 401, "Sesi tidak valid. Silakan masuk kembali.");
        return null;
      }
    }
  }

  if (!user && refreshToken) {
    let refreshed;
    try {
      const response = await supabaseRequest("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        key: anonKey,
        token: anonKey,
        body: { refresh_token: refreshToken },
      });
      refreshed = response.data;
    } catch {
      clearSession(res);
      sendError(res, 401, "Sesi berakhir. Silakan masuk kembali.");
      return null;
    }
    setSession(res, refreshed);
    user = refreshed.user;
  }

  if (!user?.id) {
    clearSession(res);
    sendError(res, 401, "Sesi tidak valid. Silakan masuk kembali.");
    return null;
  }

  const profile = await fetchActiveProfile(user.id);
  if (!profile) {
    clearSession(res);
    sendError(res, 403, "Akun tidak aktif atau belum memiliki peran.");
    return null;
  }
  return { user, profile };
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function usernameEmail(username) {
  return `${username.toLowerCase()}@${usernameEmailDomain}`;
}

function validateReport(body) {
  const required = [
    ["reporterName", "Nama pelapor"],
    ["reporterNim", "NIM pelapor"],
    ["reporterEmail", "Email pelapor"],
    ["reporterStudyProgram", "Program studi pelapor"],
    ["reporterFaculty", "Fakultas pelapor"],
    ["reportedName", "Nama terlapor"],
    ["reportedNim", "NIM terlapor"],
    ["category", "Kategori"],
    ["incidentDate", "Tanggal kejadian"],
    ["description", "Kronologi kejadian"],
  ];
  for (const [key, label] of required) {
    if (typeof body[key] !== "string" || !body[key].trim()) return `${label} wajib diisi.`;
  }
  if (!categories.includes(body.category)) return "Kategori laporan tidak valid.";
  const dateParts = body.incidentDate.split("-").map(Number);
  const date = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]));
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(body.incidentDate) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== body.incidentDate
  ) return "Tanggal kejadian tidak valid.";
  if (body.description.trim().length < 30 || body.description.length > 3000) {
    return "Kronologi harus berisi 30-3000 karakter.";
  }
  if (body.reporterEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(body.reporterEmail)) {
    return "Alamat email pelapor tidak valid.";
  }
  if (body.reporterNim.length > 32 || body.reportedNim.length > 32) return "NIM terlalu panjang.";
  if (body.reporterName.length > 150 || body.reportedName.length > 150) return "Nama terlalu panjang.";
  if (body.reporterPhone?.length > 32) return "Nomor telepon terlalu panjang.";
  if (body.reporterStudyProgram.length > 150 || body.reporterFaculty.length > 150) return "Program studi atau fakultas terlalu panjang.";
  if (body.reportedStudyProgram?.length > 150 || body.reportedFaculty?.length > 150) return "Program studi atau fakultas terlapor terlalu panjang.";
  if (body.incidentLocation?.length > 250) return "Lokasi kejadian terlalu panjang.";
  if (body.incidentTime && !/^([01]\d|2[0-3]):[0-5]\d$/u.test(body.incidentTime)) return "Waktu kejadian tidak valid.";
  return null;
}

function allowedFile(file) {
  const extension = path.extname(file.originalName).toLowerCase();
  const signature = file.buffer;
  if (extension === ".pdf" && signature.subarray(0, 5).toString() === "%PDF-") {
    return { extension, mimeType: "application/pdf" };
  }
  if (extension === ".png" && signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension, mimeType: "image/png" };
  }
  if ((extension === ".jpg" || extension === ".jpeg") && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) {
    return { extension, mimeType: "image/jpeg" };
  }
  if (extension === ".zip" && signature.subarray(0, 2).toString() === "PK") {
    return { extension, mimeType: "application/zip" };
  }
  return null;
}

async function removeStoredFiles(paths) {
  if (!paths.length) return;
  try {
    await supabaseRequest(`/storage/v1/object/${evidenceBucket}`, {
      method: "DELETE",
      body: { prefixes: paths },
    });
  } catch (error) {
    console.error("Pembersihan lampiran gagal:", error.message);
  }
}

async function saveEvidence(reportId, files) {
  const storedPaths = [];
  const rows = [];
  try {
    for (const file of files) {
      const fileInfo = allowedFile(file);
      if (!fileInfo) throw new Error(`Isi berkas "${file.originalName}" tidak cocok dengan format PDF, PNG, JPG, atau ZIP.`);
      const storagePath = `${reportId}/${randomBytes(16).toString("hex")}${fileInfo.extension}`;
      await supabaseRequest(`/storage/v1/object/${evidenceBucket}/${storagePath.split("/").map(encodeURIComponent).join("/")}`, {
        method: "POST",
        body: file.buffer,
        headers: { "Content-Type": fileInfo.mimeType, "x-upsert": "false" },
      });
      storedPaths.push(storagePath);
      rows.push({
        report_id: reportId,
        storage_path: storagePath,
        file_name: file.originalName.slice(0, 250),
        file_type: fileInfo.mimeType,
        file_size: file.size,
      });
    }
    if (rows.length) {
      await supabaseRequest("/rest/v1/evidence", {
        method: "POST",
        body: rows,
        prefer: "return=minimal",
      });
    }
    return rows;
  } catch (error) {
    await removeStoredFiles(storedPaths);
    throw error;
  }
}

function reportView(row) {
  return {
    id: row.id,
    token: row.reference_code,
    reporter_name: row.reporter_name,
    reporter_nim: row.reporter_nim,
    reporter_email: row.reporter_email,
    reporter_phone: row.reporter_phone,
    reporter_study_program: row.reporter_study_program,
    reporter_faculty: row.reporter_faculty,
    reported_name: row.reported_name,
    reported_nim: row.reported_nim,
    reported_study_program: row.reported_study_program,
    reported_faculty: row.reported_faculty,
    category: row.category,
    incident_date: row.incident_date,
    incident_time: row.incident_time,
    incident_location: row.incident_location,
    description: row.description,
    status: row.status,
    ai_status: row.ai_status,
    ai_analysis: row.ai_analysis,
    assigned_role: row.assigned_role,
    assigned_to: row.assigned_to,
    created_at: row.created_at,
    updated_at: row.updated_at,
    evidence: row.evidence || [],
    follow_ups: row.follow_ups || [],
  };
}

async function loadReport(reportId) {
  const { data } = await supabaseRequest(restQuery("reports", {
    select: "*,evidence(*),follow_ups(*)",
    id: `eq.${reportId}`,
    limit: 1,
  }));
  return data?.[0] || null;
}

function canAccessReport(profile, report) {
  return profile.role === "Admin" ||
    report.assigned_to === profile.id ||
    (!report.assigned_to && report.assigned_role === profile.role);
}

function listQueryForProfile(profile) {
  return profile.role === "Admin"
    ? null
    : `(${`assigned_to.eq.${profile.id}`},and(assigned_to.is.null,assigned_role.eq."${profile.role}"))`;
}

async function adminReports(req, res, url, profile) {
  const requestedPage = /^\d+$/u.test(url.searchParams.get("page") || "")
    ? Number(url.searchParams.get("page"))
    : 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 1_000_000
    ? requestedPage
    : 1;
  const pageSize = 25;
  const search = (url.searchParams.get("search") || "").replace(/[,%_*()"\\]/gu, " ").trim().slice(0, 80);
  const category = categories.includes(url.searchParams.get("category")) ? url.searchParams.get("category") : null;
  const status = ["masuk", "diproses", "selesai"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : null;
  const roleScope = listQueryForProfile(profile);

  const listParams = {
    select: "*,evidence(*),follow_ups(*,profiles!follow_ups_admin_id_fkey(username,role))",
    order: "created_at.desc",
    limit: pageSize,
    offset: (page - 1) * pageSize,
  };
  if (roleScope) listParams.or = roleScope;
  if (category) listParams.category = `eq.${category}`;
  if (status) listParams.status = `eq.${status}`;
  if (search) {
    const pattern = `*${search}*`;
    listParams.and = `(${[
      `reference_code.ilike.${pattern}`,
      `reported_name.ilike.${pattern}`,
      `reported_nim.ilike.${pattern}`,
      `reporter_name.ilike.${pattern}`,
      `reporter_nim.ilike.${pattern}`,
    ].join(",")})`;
  }

  const baseParams = { select: "id", ...(roleScope ? { or: roleScope } : {}) };
  const [listResult, totalResult, incomingResult, processingResult, completedResult] = await Promise.all([
    supabaseRequest(restQuery("reports", listParams), { prefer: "count=exact" }),
    supabaseRequest(restQuery("reports", baseParams), { prefer: "count=exact", head: true }),
    supabaseRequest(restQuery("reports", { ...baseParams, status: "eq.masuk" }), { prefer: "count=exact", head: true }),
    supabaseRequest(restQuery("reports", { ...baseParams, status: "eq.diproses" }), { prefer: "count=exact", head: true }),
    supabaseRequest(restQuery("reports", { ...baseParams, status: "eq.selesai" }), { prefer: "count=exact", head: true }),
  ]);
  const total = listResult.count || 0;

  sendJson(res, 200, {
    reports: listResult.data.map(reportView),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    stats: {
      total: totalResult.count || 0,
      incoming: incomingResult.count || 0,
      processing: processingResult.count || 0,
      completed: completedResult.count || 0,
    },
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    if (!checkRateLimit(req, "login", 10, 15 * 60 * 1000)) {
      sendError(res, 429, "Terlalu banyak percobaan masuk. Coba kembali dalam 15 menit.");
      return;
    }
    if (!requireSameOrigin(req, res)) return;
    const body = await readJson(req);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[a-zA-Z0-9._-]{3,32}$/u.test(username) || !password || password.length > 256) {
      sendError(res, 400, "Username atau password tidak valid.");
      return;
    }
    let session;
    try {
      const response = await supabaseRequest("/auth/v1/token?grant_type=password", {
        method: "POST",
        key: anonKey,
        token: anonKey,
        body: { email: usernameEmail(username), password },
      });
      session = response.data;
    } catch {
      sendError(res, 401, "Username atau password salah.");
      return;
    }
    const profile = await fetchActiveProfile(session.user.id);
    if (!profile) {
      sendError(res, 403, "Akun belum diaktifkan atau belum diberi peran.");
      return;
    }
    setSession(res, session);
    sendJson(res, 200, { username: profile.username, role: profile.role });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    if (!requireSameOrigin(req, res)) return;
    const refreshToken = parseCookies(req).get(refreshCookie);
    if (refreshToken) {
      try {
        const token = parseCookies(req).get(sessionCookie);
        await supabaseRequest("/auth/v1/logout?scope=local", {
          method: "POST",
          key: anonKey,
          token: token || anonKey,
        });
      } catch (error) {
        console.error("Sesi Supabase gagal dicabut saat logout:", error.message);
      }
    }
    clearSession(res);
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const auth = await authenticate(req, res);
    if (auth) sendJson(res, 200, { username: auth.profile.username, role: auth.profile.role });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reports") {
    if (!checkRateLimit(req, "report", 10, 60 * 60 * 1000)) {
      sendError(res, 429, "Batas pengiriman laporan sementara tercapai. Coba kembali nanti.");
      return;
    }
    const { fields, files } = await parseMultipart(req);
    const invalid = validateReport(fields);
    if (invalid) {
      sendError(res, 400, invalid);
      return;
    }
    const invalidFile = files.find((file) => !allowedFile(file));
    if (invalidFile) {
      sendError(res, 400, `Isi berkas "${invalidFile.originalName}" tidak cocok dengan format PDF, PNG, JPG, atau ZIP.`);
      return;
    }

    const token = `LK-${randomBytes(16).toString("hex").toUpperCase()}`;
    const reportData = {
      token_hash: hashToken(token),
      reference_code: `LP-${randomBytes(6).toString("hex").toUpperCase()}`,
      reporter_name: fields.reporterName.trim(),
      reporter_nim: fields.reporterNim.trim(),
      reporter_email: fields.reporterEmail.trim(),
      reporter_phone: fields.reporterPhone?.trim() || null,
      reporter_study_program: fields.reporterStudyProgram.trim(),
      reporter_faculty: fields.reporterFaculty.trim(),
      reported_name: fields.reportedName.trim(),
      reported_nim: fields.reportedNim.trim(),
      reported_study_program: fields.reportedStudyProgram?.trim() || null,
      reported_faculty: fields.reportedFaculty?.trim() || null,
      category: fields.category,
      incident_date: fields.incidentDate,
      incident_time: fields.incidentTime || null,
      incident_location: fields.incidentLocation?.trim() || null,
      description: fields.description.trim(),
    };
    const insertResult = await supabaseRequest("/rest/v1/reports?select=id", {
      method: "POST",
      body: reportData,
      prefer: "return=representation",
    });
    const reportId = insertResult.data?.[0]?.id;
    if (!reportId) throw new Error("Supabase tidak mengembalikan ID laporan setelah penyimpanan.");

    try {
      await saveEvidence(reportId, files);
    } catch (error) {
      try {
        await supabaseRequest(restQuery("reports", { id: `eq.${reportId}` }), { method: "DELETE", prefer: "return=minimal" });
      } catch (cleanupError) {
        console.error("Pembersihan laporan setelah unggahan gagal:", cleanupError.message);
      }
      throw error;
    }

    let aiStatus = "failed";
    const message = "Simpan token rahasia ini untuk melacak status laporan.";
    try {
      if (!analyzeReport) throw new Error("Layanan analisis Kode Etik belum siap.");
      const analysis = await analyzeReport(reportData, {
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        articles: ethicsArticles,
      });
      await supabaseRequest(restQuery("reports", { id: `eq.${reportId}` }), {
        method: "PATCH",
        body: { ai_status: "completed", ai_analysis: analysis },
        prefer: "return=minimal",
      });
      aiStatus = "completed";
    } catch (error) {
      console.error(`Analisis AI gagal untuk laporan ${reportId}:`, error);
      try {
        await supabaseRequest(restQuery("reports", { id: `eq.${reportId}` }), {
          method: "PATCH",
          body: { ai_status: "failed" },
          prefer: "return=minimal",
        });
      } catch (updateError) {
        console.error("Status kegagalan AI gagal disimpan:", updateError.message);
      }
    }
    sendJson(res, 201, { token, status: "masuk", aiStatus, message });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reports/track") {
    if (!checkRateLimit(req, "tracking", 20, 15 * 60 * 1000)) {
      sendError(res, 429, "Terlalu banyak percobaan pelacakan. Coba kembali nanti.");
      return;
    }
    const body = await readJson(req);
    const token = typeof body.token === "string" ? body.token.trim().toUpperCase() : "";
    if (!/^LK-[A-F0-9]{32}$/u.test(token)) {
      sendError(res, 400, "Format token laporan tidak valid.");
      return;
    }
    const { data } = await supabaseRequest(restQuery("reports", {
      select: "id,status,category,created_at,updated_at",
      token_hash: `eq.${hashToken(token)}`,
      limit: 1,
    }));
    const report = data?.[0];
    if (!report) {
      sendError(res, 404, "Laporan tidak ditemukan. Periksa kembali token Anda.");
      return;
    }
    const { data: followUps } = await supabaseRequest(restQuery("follow_ups", {
      select: "note,status_new,created_at",
      report_id: `eq.${report.id}`,
      order: "created_at.asc",
    }));
    sendJson(res, 200, {
      status: report.status,
      category: report.category,
      submittedAt: report.created_at,
      updatedAt: report.updated_at,
      updates: followUps.map((update) => ({ note: update.note, status: update.status_new, createdAt: update.created_at })),
    });
    return;
  }

  if (!url.pathname.startsWith("/api/admin/")) {
    sendError(res, 404, "Endpoint API tidak ditemukan.");
    return;
  }

  const auth = await authenticate(req, res);
  if (!auth) return;
  const { profile } = auth;

  if (req.method === "GET" && url.pathname === "/api/admin/users") {
    if (profile.role !== "Admin") {
      sendError(res, 403, "Anda tidak memiliki akses untuk melihat daftar petugas.");
      return;
    }
    const { data } = await supabaseRequest(restQuery("profiles", {
      select: "id,username,role",
      active: "eq.true",
      order: "role.asc,username.asc",
    }));
    sendJson(res, 200, { users: data });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/reports") {
    await adminReports(req, res, url, profile);
    return;
  }

  const reportRoute = url.pathname.match(/^\/api\/admin\/reports\/([0-9a-f-]{36})(?:\/(assignment))?$/iu);
  if (reportRoute) {
    const reportId = reportRoute[1];
    const assignment = reportRoute[2] === "assignment";
    const report = await loadReport(reportId);
    if (!report) {
      sendError(res, 404, "Laporan tidak ditemukan.");
      return;
    }
    if (!canAccessReport(profile, report)) {
      sendError(res, 403, "Laporan ini belum ditugaskan kepada peran Anda.");
      return;
    }

    if (req.method === "GET" && !assignment) {
      sendJson(res, 200, { report: reportView(report) });
      return;
    }
    if (req.method === "PATCH" && assignment) {
      if (profile.role !== "Admin") {
        sendError(res, 403, "Hanya Admin yang dapat menugaskan laporan.");
        return;
      }
      if (!requireSameOrigin(req, res)) return;
      const body = await readJson(req);
      const username = typeof body.username === "string" ? body.username.trim() : "";
      if (!username) {
        sendError(res, 400, "Pilih username petugas untuk penugasan.");
        return;
      }
      const { data: targets } = await supabaseRequest(restQuery("profiles", {
        select: "id,username,role",
        username: `eq.${username}`,
        active: "eq.true",
        limit: 1,
      }));
      const target = targets?.[0];
      if (!target || target.role === "Admin") {
        sendError(res, 400, "Pilih akun aktif selain Admin.");
        return;
      }
      await supabaseRequest(restQuery("reports", { id: `eq.${reportId}` }), {
        method: "PATCH",
        body: { assigned_role: target.role, assigned_to: target.id, updated_at: new Date().toISOString() },
        prefer: "return=minimal",
      });
      sendJson(res, 200, { assignedTo: target.username, assignedRole: target.role });
      return;
    }
    if (req.method === "PATCH" && !assignment) {
      if (!requireSameOrigin(req, res)) return;
      const body = await readJson(req);
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (!["masuk", "diproses", "selesai"].includes(body.status)) {
        sendError(res, 400, "Status laporan tidak valid.");
        return;
      }
      if (note.length < 2 || note.length > 1000) {
        sendError(res, 400, "Catatan tindak lanjut harus berisi 2-1000 karakter.");
        return;
      }
      await supabaseRequest("/rest/v1/rpc/add_report_follow_up", {
        method: "POST",
        body: { p_report_id: report.id, p_admin_id: profile.id, p_status: body.status, p_note: note },
        prefer: "return=minimal",
      });
      sendJson(res, 200, { status: body.status, message: "Status dan catatan tindak lanjut tersimpan." });
      return;
    }
  }

  const evidenceRoute = url.pathname.match(/^\/api\/admin\/evidence\/([0-9a-f-]{36})$/iu);
  if (req.method === "GET" && evidenceRoute) {
    const { data: evidenceRows } = await supabaseRequest(restQuery("evidence", {
      select: "id,report_id,storage_path",
      id: `eq.${evidenceRoute[1]}`,
      limit: 1,
    }));
    const evidence = evidenceRows?.[0];
    if (!evidence) {
      sendError(res, 404, "Bukti laporan tidak ditemukan.");
      return;
    }
    const report = await loadReport(evidence.report_id);
    if (!report || !canAccessReport(profile, report)) {
      sendError(res, 403, "Anda tidak memiliki akses ke bukti laporan ini.");
      return;
    }
    const { data } = await supabaseRequest(
      `/storage/v1/object/sign/${evidenceBucket}/${evidence.storage_path.split("/").map(encodeURIComponent).join("/")}`,
      { method: "POST", body: { expiresIn: 60 } },
    );
    const signedUrl = data.signedURL.startsWith("http")
      ? data.signedURL
      : `${supabaseUrl}/storage/v1${data.signedURL}`;
    sendJson(res, 200, { url: signedUrl });
    return;
  }

  sendError(res, 404, "Endpoint API tidak ditemukan.");
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendError(res, 405, "Metode permintaan tidak didukung.");
    return;
  }
  const asset = publicFiles.get(url.pathname);
  if (!asset) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Tidak ditemukan.");
    return;
  }
  const filePath = path.join(publicDir, asset[0]);
  try {
    const fileInfo = await stat(filePath);
    res.writeHead(200, {
      "Content-Type": asset[1],
      "Content-Length": fileInfo.size,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": asset[1] === "application/pdf" ? "private, max-age=3600" : "no-cache",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Tidak ditemukan.");
      return;
    }
    throw error;
  }
}

const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  try {
    const url = new URL(req.url || "/", appOrigin);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    console.error("Permintaan gagal:", error);
    if (!res.headersSent) {
      sendError(res, error.statusCode || 500, error.statusCode ? error.message : "Terjadi kesalahan pada server. Silakan coba lagi atau hubungi pengelola.");
    } else {
      res.destroy(error);
    }
  }
});

server.listen(port, () => {
  console.log(`LaporKKA berjalan di ${appOrigin}`);
  if (!process.env.OPENAI_API_KEY) console.warn("OPENAI_API_KEY belum diatur; analisis AI tidak aktif.");
});

setImmediate(async () => {
  try {
    const ai = await import("./lib/ai-analysis.js");
    analyzeReport = ai.analyzeReport;
    const pdfPath = path.resolve(root, process.env.CODE_OF_ETHICS_PDF || "public/assets/kode-etik-mahasiswa-2026.pdf");
    ethicsArticles = await ai.readEthicsArticles(pdfPath);
    console.log(`Dokumen Kode Etik dimuat: ${ethicsArticles.length} pasal.`);
  } catch (error) {
    console.error("Dokumen Kode Etik atau modul analisis gagal dimuat:", error);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close((error) => {
      if (error) {
        console.error("Server gagal berhenti dengan bersih:", error);
        process.exitCode = 1;
      }
    });
  });
}
