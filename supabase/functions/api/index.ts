import { createHash, randomBytes } from "node:crypto";
import articlesData from "../_shared/articles.json" with { type: "json" };
import { analyzeReport } from "../_shared/ai-analysis.ts";
import { USER_ROLES } from "../_shared/privacy.ts";
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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
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

function validateReport(body: Record<string, string>) {
  const required: [string, string][] = [
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

async function submitReport(request: Request) {
  if (!checkRateLimit(request, "report", 10, 60 * 60 * 1000)) {
    throw new HttpError(429, "Batas pengiriman laporan sementara tercapai. Coba kembali nanti.");
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
    if (!USER_ROLES.includes(role) || role === "Admin") throw new HttpError(400, "Pilih peran selain Admin.");
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
      const username = typeof body.username === "string" ? body.username.trim() : "";
      if (!username) throw new HttpError(400, "Pilih username petugas untuk penugasan.");
      const { data: targets } = await supabaseRequest(restQuery("profiles", {
        select: "id,username,role",
        username: `eq.${username}`,
        active: "eq.true",
        limit: 1,
      }));
      const target = targets?.[0];
      if (!target || target.role === "Admin") throw new HttpError(400, "Pilih akun aktif selain Admin.");
      await supabaseRequest(restQuery("reports", { id: `eq.${reportId}` }), {
        method: "PATCH",
        body: { assigned_role: target.role, assigned_to: target.id, updated_at: new Date().toISOString() },
        prefer: "return=minimal",
      });
      return json(request, 200, { assignedTo: target.username, assignedRole: target.role });
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
