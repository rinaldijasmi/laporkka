import { CAMPUS_DATA } from "../_shared/campus-data.ts";
import { createHash, randomBytes } from "node:crypto";
import articlesData from "../_shared/articles.json" with { type: "json" };
import { analyzeReport } from "../_shared/ai-analysis.ts";
import type { Article } from "../_shared/ai-analysis.ts";

const ethicsArticles = articlesData as Article[];
const env = (name: string) => Deno.env.get(name) || "";
const supabaseUrl = env("SUPABASE_URL").replace(/\/+$/u, "");
const anonKey = env("SUPABASE_ANON_KEY");
const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
const allowedOrigins = env("ALLOWED_ORIGINS").split(",").map((origin) => origin.trim()).filter(Boolean);
const evidenceBucket = "laporkka-evidence";
const usernameEmailDomain = "login.laporkka.invalid";
const maxUploadBytes = 25 * 1024 * 1024;
const maxFiles = 5;
const categories = [
  "Akademik",
  "Etika dan perilaku sosial",
  "Kekerasan, perundungan, dan pelecehan",
  "Digital dan siber",
  "Organisasi dan kegiatan mahasiswa",
  "Fasilitas, lingkungan, dan keamanan",
  "Komersial, perjudian, dan politik",
];

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowedOrigins.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(request: Request, status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Best-effort per isolate; Supabase Auth applies its own limits to logins.
const limitStore = new Map<string, { count: number; expiresAt: number }>();
function checkRateLimit(request: Request, key: string, max: number, windowMs: number) {
  const now = Date.now();
  for (const [storedKey, bucket] of limitStore) {
    if (bucket.expiresAt <= now) limitStore.delete(storedKey);
  }
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const bucketKey = `${key}:${ip}`;
  let bucket = limitStore.get(bucketKey);
  if (!bucket) {
    bucket = { count: 0, expiresAt: now + windowMs };
    limitStore.set(bucketKey, bucket);
  }
  bucket.count += 1;
  return bucket.count <= max;
}

async function supabaseRequest(endpoint: string, options: Record<string, any> = {}) {
  const {
    method = "GET",
    body,
    headers = {},
    token = serviceKey,
    key = serviceKey,
    prefer,
    head = false,
  } = options;
  const isBinary = body instanceof Uint8Array;
  const requestHeaders: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${token}`,
    ...headers,
  };
  if (body !== undefined && !isBinary) requestHeaders["Content-Type"] = "application/json";
  if (prefer) requestHeaders.Prefer = prefer;
  const response = await fetch(`${supabaseUrl}${endpoint}`, {
    method: head ? "HEAD" : method,
    headers: requestHeaders,
    body: body === undefined ? undefined : isBinary ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = head || response.status === 204 ? "" : await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const message = typeof payload === "string"
      ? payload
      : payload?.message || payload?.msg || payload?.error_description || payload?.error || `Supabase mengembalikan HTTP ${response.status}.`;
    throw new Error(`Supabase ${response.status}: ${message}`);
  }
  const range = response.headers.get("content-range")?.split("/").at(-1);
  return { data: payload, count: range && range !== "*" ? Number(range) : null };
}

async function roleExists(name: string) {
  if (!name) return false;
  const { data } = await supabaseRequest(restQuery("roles", { select: "name", name: `eq.${name}`, limit: 1 }));
  return Boolean(data?.length);
}

function cleanRoleName(value: unknown) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
  if (!/^[\p{L}\p{N} ._-]{2,40}$/u.test(name)) {
    throw new HttpError(400, "Nama peran 2-40 karakter: huruf, angka, spasi, titik, garis bawah, atau tanda hubung.");
  }
  if (name.toLowerCase() === "admin") throw new HttpError(400, "Nama peran Admin dicadangkan.");
  return name;
}

async function countRows(table: string, filter: Record<string, string>) {
  const { count } = await supabaseRequest(restQuery(table, { select: "id", ...filter }), { prefer: "count=exact", head: true });
  return count || 0;
}

async function loadManagedUser(id: string) {
  const { data } = await supabaseRequest(restQuery("profiles", { select: "id,username,role", id: `eq.${id}`, limit: 1 }));
  const user = data?.[0];
  if (!user) throw new HttpError(404, "Akun tidak ditemukan.");
  return user;
}

function restQuery(table: string, entries: Record<string, unknown>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  return `/rest/v1/${table}?${query.toString()}`;
}

async function readJson(request: Request) {
  const text = await request.text();
  if (text.length > 100 * 1024) throw new HttpError(413, "Ukuran permintaan terlalu besar.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Format JSON tidak valid.");
  }
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const usernameEmail = (username: string) => `${username.toLowerCase()}@${usernameEmailDomain}`;

async function fetchActiveProfile(userId: string) {
  const { data } = await supabaseRequest(restQuery("profiles", {
    select: "id,username,role,active",
    id: `eq.${userId}`,
    limit: 1,
  }));
  const profile = data?.[0];
  return profile?.active ? profile : null;
}

async function authenticate(request: Request) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Silakan masuk dengan username Anda.");
  let user;
  try {
    ({ data: user } = await supabaseRequest("/auth/v1/user", { token, key: anonKey }));
  } catch {
    throw new HttpError(401, "Sesi tidak valid. Silakan masuk kembali.");
  }
  const profile = user?.id ? await fetchActiveProfile(user.id) : null;
  if (!profile) throw new HttpError(403, "Akun tidak aktif atau belum memiliki peran.");
  return { user, profile };
}

const OTHER_OPTION = CAMPUS_DATA.other;

function invalidAcademicUnit(faculty: string, program: string, who: string) {
  if (!faculty && !program) return null;
  const known = CAMPUS_DATA.faculties.find((item) => item.name === faculty);
  if (!known && faculty !== OTHER_OPTION) return `Fakultas ${who} tidak valid. Pilih dari daftar.`;
  if (program && program !== OTHER_OPTION && !(known?.programs as readonly string[] | undefined)?.includes(program)) {
    return `Program Studi/Unit ${who} tidak sesuai dengan fakultasnya.`;
  }
  return null;
}

function otherDetailError(body: Record<string, string>, prefix: string, who: string) {
  for (const [field, label] of [["Faculty", "Fakultas/Direktorat"], ["StudyProgram", "Program Studi/Unit"]]) {
    if (body[`${prefix}${field}`]?.trim() !== OTHER_OPTION) continue;
    const detail = (body[`${prefix}${field}Other`] || "").trim();
    if (!detail) return `${label} ${who} wajib diisi saat memilih Lainnya.`;
    if (detail.length > 100) return `${label} ${who} (Lainnya) terlalu panjang.`;
  }
  return null;
}

function withOtherDetail(body: Record<string, string>, field: string) {
  const value = body[field]?.trim() || "";
  return value === OTHER_OPTION ? `Lainnya: ${(body[`${field}Other`] || "").trim()}` : value;
}

function validateReport(body: Record<string, string>) {
  const required: [string, string][] = [
    ["reporterName", "Nama pelapor"],
    ["reporterNim", "NIM/NIP/Nomor Identitas pelapor"],
    ["reporterEmail", "Email pelapor"],
    ["reporterStudyProgram", "Program Studi/Unit pelapor"],
    ["reporterFaculty", "Fakultas/Direktorat pelapor"],
    ["reportedName", "Nama terlapor"],
    ["reportedNim", "NIM/NIP/Nomor Identitas terlapor"],
    ["category", "Kategori"],
    ["incidentCampus", "Lokasi kampus"],
    ["incidentDate", "Tanggal kejadian"],
    ["description", "Kronologi kejadian"],
  ];
  for (const [key, label] of required) {
    if (typeof body[key] !== "string" || !body[key].trim()) return `${label} wajib diisi.`;
  }
  if (!categories.includes(body.category)) return "Kategori laporan tidak valid.";
  if (!(CAMPUS_DATA.campuses as readonly string[]).includes(body.incidentCampus.trim())) return "Lokasi kampus tidak valid.";
  const unitError = otherDetailError(body, "reporter", "pelapor") || otherDetailError(body, "reported", "terlapor") ||
    invalidAcademicUnit(body.reporterFaculty.trim(), body.reporterStudyProgram.trim(), "pelapor") ||
    invalidAcademicUnit((body.reportedFaculty || "").trim(), (body.reportedStudyProgram || "").trim(), "terlapor");
  if (unitError) return unitError;
  const dateParts = body.incidentDate.split("-").map(Number);
  const date = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]));
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(body.incidentDate) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== body.incidentDate
  ) return "Tanggal kejadian tidak valid.";
  const todayJakarta = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  if (body.incidentDate > todayJakarta) return "Tanggal kejadian tidak boleh di masa depan.";
  if (!["on", "true", "1"].includes(String(body.goodFaith ?? "").toLowerCase())) {
    return "Anda harus menyatakan bahwa laporan dibuat dengan itikad baik.";
  }
  if (body.description.trim().length < 30 || body.description.length > 3000) {
    return "Kronologi harus berisi 30-3000 karakter.";
  }
  if (body.reporterEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(body.reporterEmail)) {
    return "Alamat email pelapor tidak valid.";
  }
  if (body.reporterNim.length > 32 || body.reportedNim.length > 32) return "Nomor identitas terlalu panjang.";
  if (body.reporterName.length > 150 || body.reportedName.length > 150) return "Nama terlalu panjang.";
  if (body.reporterPhone?.length > 32) return "Nomor telepon terlalu panjang.";
  if (body.reporterStudyProgram.length > 150 || body.reporterFaculty.length > 150) return "Program studi atau fakultas terlalu panjang.";
  if (body.reportedStudyProgram?.length > 150 || body.reportedFaculty?.length > 150) return "Program studi atau fakultas terlapor terlalu panjang.";
  if (body.incidentLocation?.length > 250) return "Lokasi kejadian terlalu panjang.";
  if (body.incidentTime && !/^([01]\d|2[0-3]):[0-5]\d$/u.test(body.incidentTime)) return "Waktu kejadian tidak valid.";
  return null;
}

type UploadedFile = { name: string; bytes: Uint8Array; size: number };

function detectFileType(file: UploadedFile) {
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  const b = file.bytes;
  const startsWith = (...signature: number[]) => signature.every((value, index) => b[index] === value);
  if (extension === ".pdf" && startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) return { extension, mimeType: "application/pdf" };
  if (extension === ".png" && startsWith(137, 80, 78, 71, 13, 10, 26, 10)) return { extension, mimeType: "image/png" };
  if ((extension === ".jpg" || extension === ".jpeg") && startsWith(0xff, 0xd8, 0xff)) return { extension, mimeType: "image/jpeg" };
  if (extension === ".zip" && startsWith(0x50, 0x4b)) return { extension, mimeType: "application/zip" };
  return null;
}

const encodePath = (storagePath: string) => storagePath.split("/").map(encodeURIComponent).join("/");

async function removeStoredFiles(paths: string[]) {
  if (!paths.length) return;
  try {
    await supabaseRequest(`/storage/v1/object/${evidenceBucket}`, { method: "DELETE", body: { prefixes: paths } });
  } catch (error) {
    console.error("Pembersihan lampiran gagal:", (error as Error).message);
  }
}

async function saveEvidence(reportId: string, files: UploadedFile[]) {
  const storedPaths: string[] = [];
  const rows = [];
  try {
    for (const file of files) {
      const fileInfo = detectFileType(file)!;
      const storagePath = `${reportId}/${randomBytes(16).toString("hex")}${fileInfo.extension}`;
      await supabaseRequest(`/storage/v1/object/${evidenceBucket}/${encodePath(storagePath)}`, {
        method: "POST",
        body: file.bytes,
        headers: { "Content-Type": fileInfo.mimeType, "x-upsert": "false" },
      });
      storedPaths.push(storagePath);
      rows.push({
        report_id: reportId,
        storage_path: storagePath,
        file_name: file.name.slice(0, 250),
        file_type: fileInfo.mimeType,
        file_size: file.size,
      });
    }
    if (rows.length) {
      await supabaseRequest("/rest/v1/evidence", { method: "POST", body: rows, prefer: "return=minimal" });
    }
  } catch (error) {
    await removeStoredFiles(storedPaths);
    throw error;
  }
}

function reportView(row: Record<string, any>) {
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
    incident_campus: row.incident_campus,
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

async function loadReport(reportId: string) {
  const { data } = await supabaseRequest(restQuery("reports", {
    select: "*,evidence(*),follow_ups(*)",
    id: `eq.${reportId}`,
    limit: 1,
  }));
  return data?.[0] || null;
}

function canAccessReport(profile: Record<string, any>, report: Record<string, any>) {
  return profile.role === "Admin" ||
    report.assigned_to === profile.id ||
    (!report.assigned_to && report.assigned_role === profile.role);
}

async function listReports(request: Request, url: URL, profile: Record<string, any>) {
  const requestedPage = /^\d+$/u.test(url.searchParams.get("page") || "") ? Number(url.searchParams.get("page")) : 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 1_000_000 ? requestedPage : 1;
  const pageSize = 25;
  const search = (url.searchParams.get("search") || "").replace(/[,%_*()"\\]/gu, " ").trim().slice(0, 80);
  const categoryParam = url.searchParams.get("category") || "";
  const statusParam = url.searchParams.get("status") || "";
  const category = categories.includes(categoryParam) ? categoryParam : null;
  const status = ["masuk", "diproses", "selesai"].includes(statusParam) ? statusParam : null;
  const roleScope = profile.role === "Admin"
    ? null
    : `(assigned_to.eq.${profile.id},and(assigned_to.is.null,assigned_role.eq."${profile.role}"))`;

  const listParams: Record<string, unknown> = {
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
    listParams.and = `(or(${[
      `reference_code.ilike.${pattern}`,
      `reported_name.ilike.${pattern}`,
      `reported_nim.ilike.${pattern}`,
      `reporter_name.ilike.${pattern}`,
      `reporter_nim.ilike.${pattern}`,
    ].join(",")}))`;
  }

  const baseParams = { select: "id", ...(roleScope ? { or: roleScope } : {}) };
  const countOptions = { prefer: "count=exact", head: true };
  const [list, total, incoming, processing, completed] = await Promise.all([
    supabaseRequest(restQuery("reports", listParams), { prefer: "count=exact" }),
    supabaseRequest(restQuery("reports", baseParams), countOptions),
    supabaseRequest(restQuery("reports", { ...baseParams, status: "eq.masuk" }), countOptions),
    supabaseRequest(restQuery("reports", { ...baseParams, status: "eq.diproses" }), countOptions),
    supabaseRequest(restQuery("reports", { ...baseParams, status: "eq.selesai" }), countOptions),
  ]);
  const matching = list.count || 0;
  return json(request, 200, {
    reports: list.data.map(reportView),
    page,
    pageSize,
    total: matching,
    totalPages: Math.max(1, Math.ceil(matching / pageSize)),
    stats: {
      total: total.count || 0,
      incoming: incoming.count || 0,
      processing: processing.count || 0,
      completed: completed.count || 0,
    },
  });
}

function clientIp(request: Request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Batas longgar per IP (satu kelas di WiFi yang sama tetap aman); disimpan di database dengan IP ter-hash.
async function checkReportIpLimit(request: Request) {
  const bucket = `report:${(await sha256Hex(clientIp(request))).slice(0, 32)}`;
  try {
    const allowed = await supabaseRequest("/rest/v1/rpc/hit_rate_limit", {
      method: "POST",
      body: { p_bucket: bucket, p_max: 60, p_window_seconds: 3600 },
    });
    return allowed !== false;
  } catch {
    return true;
  }
}

async function verifyTurnstile(request: Request, token: string) {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return;
  if (!token) throw new HttpError(400, "Verifikasi keamanan belum selesai. Muat ulang halaman lalu coba lagi.");
  const body = new URLSearchParams({ secret, response: token });
  const ip = clientIp(request);
  if (ip !== "unknown") body.set("remoteip", ip);
  let result: { success?: boolean; "error-codes"?: string[] } = {};
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(10_000),
    });
    result = await response.json();
  } catch {
    throw new HttpError(503, "Verifikasi keamanan sementara tidak tersedia. Coba lagi sebentar.");
  }
  if (!result.success) {
    const codes = (result["error-codes"] || []).join(", ");
    throw new HttpError(400, `Verifikasi keamanan gagal atau kedaluwarsa. Silakan coba lagi.${codes ? ` (${codes})` : ""}`);
  }
}

async function reportStats(request: Request, profile: Record<string, any>) {
  const roleScope = profile.role === "Admin"
    ? ""
    : `(assigned_to.eq.${profile.id},and(assigned_to.is.null,assigned_role.eq."${profile.role}"))`;
  const rows: Record<string, any>[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data } = await supabaseRequest(restQuery("reports", {
      select: "category,status,assigned_role,reporter_faculty,reported_faculty,incident_campus,created_at",
      order: "created_at.asc",
      ...(roleScope ? { or: roleScope } : {}),
    }), { headers: { Range: `${from}-${from + 999}`, "Range-Unit": "items" } });
    rows.push(...data);
    if (data.length < 1000) break;
  }

  const tally = (pick: (row: Record<string, any>) => string | null | undefined) => {
    const map = new Map<string, number>();
    for (const row of rows) {
      const key = pick(row);
      if (key) map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  };

  const roles = new Map<string, { name: string; masuk: number; diproses: number; selesai: number; total: number }>();
  for (const row of rows) {
    const name = row.assigned_role || "Belum diserahkan";
    const entry = roles.get(name) || { name, masuk: 0, diproses: 0, selesai: 0, total: 0 };
    entry[row.status as "masuk" | "diproses" | "selesai"] += 1;
    entry.total += 1;
    roles.set(name, entry);
  }

  const facultyMap = new Map<string, { name: string; reporter: number; reported: number }>();
  const bump = (name: string | null, key: "reporter" | "reported") => {
    if (!name) return;
    const entry = facultyMap.get(name) || { name, reporter: 0, reported: 0 };
    entry[key] += 1;
    facultyMap.set(name, entry);
  };
  for (const row of rows) {
    bump(row.reporter_faculty, "reporter");
    bump(row.reported_faculty, "reported");
  }

  const monthly = new Map<string, number>();
  for (const row of rows) {
    const key = new Date(new Date(row.created_at).getTime() + 7 * 3_600_000).toISOString().slice(0, 7);
    monthly.set(key, (monthly.get(key) || 0) + 1);
  }

  return json(request, 200, {
    total: rows.length,
    categories: tally((row) => row.category),
    campuses: tally((row) => row.incident_campus || "Belum diisi"),
    roles: [...roles.values()].sort((a, b) => b.total - a.total),
    faculties: [...facultyMap.values()].sort((a, b) => b.reporter + b.reported - (a.reporter + a.reported)),
    months: [...monthly].map(([month, count]) => ({ month, count })).slice(-6),
  });
}

async function submitReport(request: Request) {
  if (!(await checkReportIpLimit(request))) {
    throw new HttpError(429, "Terlalu banyak laporan dari jaringan ini dalam satu jam. Coba kembali nanti.");
  }
  if (Number(request.headers.get("content-length") || 0) > maxUploadBytes + 200 * 1024) {
    throw new HttpError(413, "Ukuran permintaan terlalu besar.");
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "Format formulir unggahan tidak valid.");
  }

  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];
  let totalBytes = 0;
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      if (value.length > 5000) throw new HttpError(400, "Kolom formulir terlalu panjang.");
      fields[name] = value;
    } else if (value.size > 0) {
      totalBytes += value.size;
      if (value.size > maxUploadBytes) throw new HttpError(400, "Ukuran setiap berkas maksimal 25 MB.");
      if (totalBytes > maxUploadBytes) throw new HttpError(400, "Ukuran gabungan lampiran maksimal 25 MB.");
      files.push({ name: value.name.split(/[\\/]/u).pop() || "bukti", bytes: new Uint8Array(await value.arrayBuffer()), size: value.size });
    }
  }
  if (files.length > maxFiles) throw new HttpError(400, `Maksimal ${maxFiles} berkas bukti.`);

  await verifyTurnstile(request, fields["cf-turnstile-response"] || "");

  const invalid = validateReport(fields);
  if (invalid) throw new HttpError(400, invalid);
  const invalidFile = files.find((file) => !detectFileType(file));
  if (invalidFile) {
    throw new HttpError(400, `Isi berkas "${invalidFile.name}" tidak cocok dengan format PDF, PNG, JPG, atau ZIP.`);
  }

  const token = `LK-${randomBytes(16).toString("hex").toUpperCase()}`;
  const reportData = {
    token_hash: hashToken(token),
    reference_code: `LP-${randomBytes(6).toString("hex").toUpperCase()}`,
    reporter_name: fields.reporterName.trim(),
    reporter_nim: fields.reporterNim.trim(),
    reporter_email: fields.reporterEmail.trim(),
    reporter_phone: fields.reporterPhone?.trim() || null,
    reporter_study_program: withOtherDetail(fields, "reporterStudyProgram"),
    reporter_faculty: withOtherDetail(fields, "reporterFaculty"),
    reported_name: fields.reportedName.trim(),
    reported_nim: fields.reportedNim.trim(),
    reported_study_program: withOtherDetail(fields, "reportedStudyProgram") || null,
    reported_faculty: withOtherDetail(fields, "reportedFaculty") || null,
    category: fields.category,
    incident_date: fields.incidentDate,
    incident_time: fields.incidentTime || null,
    incident_campus: fields.incidentCampus.trim(),
    incident_location: fields.incidentLocation?.trim() || null,
    description: fields.description.trim(),
  };
  const inserted = await supabaseRequest("/rest/v1/reports?select=id", {
    method: "POST",
    body: reportData,
    prefer: "return=representation",
  });
  const reportId = inserted.data?.[0]?.id;
  if (!reportId) throw new Error("Supabase tidak mengembalikan ID laporan setelah penyimpanan.");

  try {
    await saveEvidence(reportId, files);
  } catch (error) {
    try {
      await supabaseRequest(restQuery("reports", { id: `eq.${reportId}` }), { method: "DELETE", prefer: "return=minimal" });
    } catch (cleanupError) {
      console.error("Pembersihan laporan setelah unggahan gagal:", (cleanupError as Error).message);
    }
    throw error;
  }

  let aiStatus = "failed";
  try {
    const analysis = await analyzeReport(reportData, {
      apiKey: env("OPENAI_API_KEY"),
      model: env("OPENAI_MODEL") || "gpt-4.1-mini",
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
      console.error("Status kegagalan AI gagal disimpan:", (updateError as Error).message);
    }
  }
  return { token, status: "masuk", aiStatus, message: "Simpan token rahasia ini untuk melacak status laporan." };
}

async function route(request: Request, url: URL, path: string) {
  const method = request.method;

  if (method === "GET" && path === "/health") return json(request, 200, { status: "ok" });

  if (method === "POST" && path === "/auth/login") {
    if (!checkRateLimit(request, "login", 10, 15 * 60 * 1000)) {
      throw new HttpError(429, "Terlalu banyak percobaan masuk. Coba kembali dalam 15 menit.");
    }
    const body = await readJson(request);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[a-zA-Z0-9._-]{3,32}$/u.test(username) || !password || password.length > 256) {
      throw new HttpError(400, "Username atau password tidak valid.");
    }
    let session;
    try {
      ({ data: session } = await supabaseRequest("/auth/v1/token?grant_type=password", {
        method: "POST",
        key: anonKey,
        token: anonKey,
        body: { email: usernameEmail(username), password },
      }));
    } catch {
      throw new HttpError(401, "Username atau password salah.");
    }
    const profile = await fetchActiveProfile(session.user.id);
    if (!profile) throw new HttpError(403, "Akun belum diaktifkan atau belum diberi peran.");
    return json(request, 200, {
      username: profile.username,
      role: profile.role,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    });
  }

  if (method === "POST" && path === "/auth/refresh") {
    const body = await readJson(request);
    if (typeof body.refreshToken !== "string" || !body.refreshToken) throw new HttpError(401, "Sesi berakhir. Silakan masuk kembali.");
    let session;
    try {
      ({ data: session } = await supabaseRequest("/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        key: anonKey,
        token: anonKey,
        body: { refresh_token: body.refreshToken },
      }));
    } catch {
      throw new HttpError(401, "Sesi berakhir. Silakan masuk kembali.");
    }
    const profile = await fetchActiveProfile(session.user.id);
    if (!profile) throw new HttpError(403, "Akun tidak aktif atau belum memiliki peran.");
    return json(request, 200, {
      username: profile.username,
      role: profile.role,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    });
  }

  if (method === "POST" && path === "/auth/logout") {
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/u, "");
    if (token) {
      try {
        await supabaseRequest("/auth/v1/logout?scope=local", { method: "POST", key: anonKey, token });
      } catch (error) {
        console.error("Sesi Supabase gagal dicabut saat logout:", (error as Error).message);
      }
    }
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (method === "GET" && path === "/auth/me") {
    const { profile } = await authenticate(request);
    return json(request, 200, { username: profile.username, role: profile.role });
  }

  if (method === "POST" && path === "/reports") {
    return json(request, 201, await submitReport(request));
  }

  if (method === "POST" && path === "/reports/track") {
    if (!checkRateLimit(request, "tracking", 20, 15 * 60 * 1000)) {
      throw new HttpError(429, "Terlalu banyak percobaan pelacakan. Coba kembali nanti.");
    }
    const body = await readJson(request);
    const token = typeof body.token === "string" ? body.token.trim().toUpperCase() : "";
    if (!/^LK-[A-F0-9]{32}$/u.test(token)) throw new HttpError(400, "Format token laporan tidak valid.");
    const { data } = await supabaseRequest(restQuery("reports", {
      select: "id,status,category,created_at,updated_at",
      token_hash: `eq.${hashToken(token)}`,
      limit: 1,
    }));
    const report = data?.[0];
    if (!report) throw new HttpError(404, "Laporan tidak ditemukan. Periksa kembali token Anda.");
    const { data: followUps } = await supabaseRequest(restQuery("follow_ups", {
      select: "note,status_new,created_at",
      report_id: `eq.${report.id}`,
      order: "created_at.asc",
    }));
    return json(request, 200, {
      status: report.status,
      category: report.category,
      submittedAt: report.created_at,
      updatedAt: report.updated_at,
      updates: followUps.map((update: any) => ({ note: update.note, status: update.status_new, createdAt: update.created_at })),
    });
  }

  if (!path.startsWith("/admin/")) throw new HttpError(404, "Endpoint API tidak ditemukan.");

  const { profile } = await authenticate(request);

  if (method === "GET" && path === "/admin/users") {
    if (profile.role !== "Admin") throw new HttpError(403, "Anda tidak memiliki akses untuk melihat daftar petugas.");
    const { data } = await supabaseRequest(restQuery("profiles", {
      select: "id,username,role",
      active: "eq.true",
      order: "role.asc,username.asc",
    }));
    return json(request, 200, { users: data });
  }

  if (method === "POST" && path === "/admin/users") {
    if (profile.role !== "Admin") throw new HttpError(403, "Hanya Admin yang dapat membuat akun petugas.");
    const body = await readJson(request);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const role = typeof body.role === "string" ? body.role : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[a-zA-Z0-9._-]{3,32}$/u.test(username)) {
      throw new HttpError(400, "Username harus 3-32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.");
    }
    if (role === "Admin" || !(await roleExists(role))) throw new HttpError(400, "Pilih peran selain Admin.");
    if (password.length < 12 || password.length > 72) throw new HttpError(400, "Password harus 12-72 karakter.");

    const { data: existing } = await supabaseRequest(restQuery("profiles", {
      select: "id",
      username: `ilike.${username.replace(/[\\%_*]/gu, "")}`,
      limit: 1,
    }));
    if (existing?.length) throw new HttpError(409, "Username sudah dipakai.");

    const { data: created } = await supabaseRequest("/auth/v1/admin/users", {
      method: "POST",
      body: { email: usernameEmail(username), password, email_confirm: true, user_metadata: { username } },
    });
    try {
      await supabaseRequest("/rest/v1/profiles", {
        method: "POST",
        body: { id: created.id, username, role },
        prefer: "return=minimal",
      });
    } catch (error) {
      try {
        await supabaseRequest(`/auth/v1/admin/users/${created.id}`, { method: "DELETE" });
      } catch (cleanupError) {
        console.error("Pembersihan akun Auth gagal:", (cleanupError as Error).message);
      }
      throw error;
    }
    return json(request, 201, { username, role });
  }

  if (method === "GET" && path === "/admin/roles") {
    if (profile.role !== "Admin") throw new HttpError(403, "Hanya Admin yang dapat melihat daftar peran.");
    const [{ data: roles }, { data: users }] = await Promise.all([
      supabaseRequest(restQuery("roles", { select: "name", order: "name.asc" })),
      supabaseRequest(restQuery("profiles", { select: "role", active: "eq.true" })),
    ]);
    const counts = new Map<string, number>();
    for (const user of users) counts.set(user.role, (counts.get(user.role) || 0) + 1);
    return json(request, 200, {
      roles: roles.map((role: { name: string }) => ({ name: role.name, users: counts.get(role.name) || 0, locked: role.name === "Admin" })),
    });
  }

  if (method === "POST" && path === "/admin/roles") {
    if (profile.role !== "Admin") throw new HttpError(403, "Hanya Admin yang dapat menambah peran.");
    const name = cleanRoleName((await readJson(request)).name);
    const { data: existing } = await supabaseRequest(restQuery("roles", { select: "name", name: `ilike.${name.replace(/[\\%_*]/gu, "")}`, limit: 1 }));
    if (existing?.length) throw new HttpError(409, "Peran dengan nama itu sudah ada.");
    await supabaseRequest("/rest/v1/roles", { method: "POST", body: { name }, prefer: "return=minimal" });
    return json(request, 201, { name });
  }

  const roleRoute = path.match(/^\/admin\/roles\/([^/]+)$/u);
  if (roleRoute) {
    if (profile.role !== "Admin") throw new HttpError(403, "Hanya Admin yang dapat mengelola peran.");
    let current: string;
    try {
      current = decodeURIComponent(roleRoute[1]);
    } catch {
      throw new HttpError(400, "Nama peran tidak valid.");
    }
    if (current === "Admin") throw new HttpError(400, "Peran Admin tidak dapat diubah atau dihapus.");
    if (!(await roleExists(current))) throw new HttpError(404, "Peran tidak ditemukan.");

    if (method === "PATCH") {
      const name = cleanRoleName((await readJson(request)).name);
      if (name !== current) {
        const { data: existing } = await supabaseRequest(restQuery("roles", { select: "name", name: `ilike.${name.replace(/[\\%_*]/gu, "")}`, limit: 1 }));
        if (existing?.length && existing[0].name !== current) throw new HttpError(409, "Peran dengan nama itu sudah ada.");
        await supabaseRequest(restQuery("roles", { name: `eq.${current}` }), { method: "PATCH", body: { name }, prefer: "return=minimal" });
      }
      return json(request, 200, { name });
    }

    if (method === "DELETE") {
      const [accounts, reports] = await Promise.all([
        countRows("profiles", { role: `eq.${current}` }),
        countRows("reports", { assigned_role: `eq.${current}` }),
      ]);
      if (accounts) throw new HttpError(409, `Peran masih dipakai ${accounts} akun. Pindahkan atau hapus akun tersebut dulu.`);
      if (reports) throw new HttpError(409, `Peran masih menerima ${reports} laporan. Serahkan laporan itu ke peran lain dulu.`);
      await supabaseRequest(restQuery("roles", { name: `eq.${current}` }), { method: "DELETE", prefer: "return=minimal" });
      return json(request, 200, { deleted: current });
    }
  }

  const userRoute = path.match(/^\/admin\/users\/([0-9a-f-]{36})$/iu);
  if (userRoute) {
    if (profile.role !== "Admin") throw new HttpError(403, "Hanya Admin yang dapat mengelola akun petugas.");
    const target = await loadManagedUser(userRoute[1]);
    const isSelf = target.id === profile.id;

    if (method === "PATCH") {
      const body = await readJson(request);
      const changes: string[] = [];
      if (body.role !== undefined) {
        const role = typeof body.role === "string" ? body.role : "";
        if (target.role === "Admin") throw new HttpError(400, "Peran akun Admin tidak dapat diubah.");
        if (role === "Admin" || !(await roleExists(role))) throw new HttpError(400, "Pilih peran selain Admin.");
        if (role !== target.role) {
          await supabaseRequest(restQuery("profiles", { id: `eq.${target.id}` }), { method: "PATCH", body: { role }, prefer: "return=minimal" });
          changes.push("peran");
        }
      }
      if (body.password !== undefined) {
        const password = typeof body.password === "string" ? body.password : "";
        if (target.role === "Admin" && !isSelf) throw new HttpError(403, "Password akun Admin lain tidak dapat direset.");
        if (password.length < 12 || password.length > 72) throw new HttpError(400, "Password harus 12-72 karakter.");
        await supabaseRequest(`/auth/v1/admin/users/${target.id}`, { method: "PUT", body: { password } });
        changes.push("password");
      }
      if (!changes.length && body.role === undefined && body.password === undefined) throw new HttpError(400, "Tidak ada perubahan yang dikirim.");
      return json(request, 200, { username: target.username, changed: changes });
    }

    if (method === "DELETE") {
      if (isSelf || target.role === "Admin") throw new HttpError(400, "Akun Admin tidak dapat dihapus.");
      await supabaseRequest(`/auth/v1/admin/users/${target.id}`, { method: "DELETE" });
      return json(request, 200, { deleted: target.username });
    }
  }

  if (method === "GET" && path === "/admin/stats") return await reportStats(request, profile);

  if (method === "GET" && path === "/admin/reports") return await listReports(request, url, profile);

  const reportRoute = path.match(/^\/admin\/reports\/([0-9a-f-]{36})(?:\/(assignment))?$/iu);
  if (reportRoute) {
    const reportId = reportRoute[1];
    const assignment = reportRoute[2] === "assignment";
    const report = await loadReport(reportId);
    if (!report) throw new HttpError(404, "Laporan tidak ditemukan.");
    if (!canAccessReport(profile, report)) throw new HttpError(403, "Laporan ini belum ditugaskan kepada peran Anda.");

    if (method === "GET" && !assignment) return json(request, 200, { report: reportView(report) });

    if (method === "PATCH" && assignment) {
      if (profile.role !== "Admin") throw new HttpError(403, "Hanya Admin yang dapat menugaskan laporan.");
      const body = await readJson(request);
      const role = typeof body.role === "string" ? body.role.trim() : "";
      if (role === "Admin" || !(await roleExists(role))) throw new HttpError(400, "Pilih peran penerima selain Admin.");
      await supabaseRequest(restQuery("reports", { id: `eq.${reportId}` }), {
        method: "PATCH",
        body: { assigned_role: role, assigned_to: null, updated_at: new Date().toISOString() },
        prefer: "return=minimal",
      });
      return json(request, 200, { assignedRole: role });
    }

    if (method === "PATCH" && !assignment) {
      const body = await readJson(request);
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (!["masuk", "diproses", "selesai"].includes(body.status)) throw new HttpError(400, "Status laporan tidak valid.");
      if (note.length < 2 || note.length > 1000) throw new HttpError(400, "Catatan tindak lanjut harus berisi 2-1000 karakter.");
      await supabaseRequest("/rest/v1/rpc/add_report_follow_up", {
        method: "POST",
        body: { p_report_id: report.id, p_admin_id: profile.id, p_status: body.status, p_note: note },
        prefer: "return=minimal",
      });
      return json(request, 200, { status: body.status, message: "Status dan catatan tindak lanjut tersimpan." });
    }
  }

  const evidenceRoute = path.match(/^\/admin\/evidence\/([0-9a-f-]{36})$/iu);
  if (method === "GET" && evidenceRoute) {
    const { data: rows } = await supabaseRequest(restQuery("evidence", {
      select: "id,report_id,storage_path",
      id: `eq.${evidenceRoute[1]}`,
      limit: 1,
    }));
    const evidence = rows?.[0];
    if (!evidence) throw new HttpError(404, "Bukti laporan tidak ditemukan.");
    const report = await loadReport(evidence.report_id);
    if (!report || !canAccessReport(profile, report)) throw new HttpError(403, "Anda tidak memiliki akses ke bukti laporan ini.");
    const { data } = await supabaseRequest(`/storage/v1/object/sign/${evidenceBucket}/${encodePath(evidence.storage_path)}`, {
      method: "POST",
      body: { expiresIn: 60 },
    });
    const signedUrl = data.signedURL.startsWith("http") ? data.signedURL : `${supabaseUrl}/storage/v1${data.signedURL}`;
    return json(request, 200, { url: signedUrl });
  }

  throw new HttpError(404, "Endpoint API tidak ditemukan.");
}

export async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^.*?\/api(?=\/|$)/u, "").replace(/\/+$/u, "") || "/";
    return await route(request, url, path);
  } catch (error) {
    if (error instanceof HttpError && error.status < 500) return json(request, error.status, { error: error.message });
    console.error("Permintaan gagal:", error);
    return json(request, 500, { error: "Terjadi kesalahan pada server. Silakan coba lagi atau hubungi pengelola." });
  }
}

Deno.serve(handler);
