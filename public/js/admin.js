const reportsBody = document.querySelector("#reports-body");
const searchInput = document.querySelector("#report-search");
const statusFilter = document.querySelector("#status-filter");
const categoryFilter = document.querySelector("#category-filter");
const reportDialog = document.querySelector("#report-dialog");
const loginDialog = document.querySelector("#login-dialog");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const assignmentForm = document.querySelector("#assignment-form");
const assigneeSelect = document.querySelector("#assignee-select");
const followUpForm = document.querySelector("#follow-up-form");
const toast = document.querySelector("#admin-toast");
const accountDialog = document.querySelector("#account-dialog");
const accountForm = document.querySelector("#account-form");
const accountError = document.querySelector("#account-error");
let activeReportId = null;
let currentUser = null;
let reports = [];
let currentPage = 1;
let totalPages = 1;
let toastTimeout;
let searchTimeout;

const SESSION_KEY = "laporkka.session";

function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function saveSession(session) {
  if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else sessionStorage.removeItem(SESSION_KEY);
}

async function refreshSession() {
  const session = readSession();
  if (!session?.refreshToken) return false;
  try {
    const response = await fetch(`${window.LAPORKKA_API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (!response.ok) {
      saveSession(null);
      return false;
    }
    const { accessToken, refreshToken } = await response.json();
    saveSession({ accessToken, refreshToken });
    return true;
  } catch {
    return false;
  }
}

async function apiFetch(url, options = {}) {
  const send = () => fetch(`${window.LAPORKKA_API_BASE}${url}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(readSession() ? { Authorization: `Bearer ${readSession().accessToken}` } : {}),
      ...options.headers,
    },
  });
  const isAuthEntry = url === "/auth/login" || url === "/auth/me";
  let response = await send();
  if (response.status === 401 && !isAuthEntry && await refreshSession()) response = await send();
  if (response.status === 401 && !isAuthEntry) {
    showSessionExpired();
    throw new Error("Sesi Anda telah berakhir. Silakan masuk kembali.");
  }
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(payload?.error || `Permintaan gagal (${response.status}).`);
  return payload;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("toast-error", isError);
  toast.classList.add("visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 3200);
}

function showSessionExpired() {
  document.querySelector("#session-expired-dialog").showModal();
}

function formatDate(dateValue, options = { day: "numeric", month: "short", year: "numeric" }) {
  return new Intl.DateTimeFormat("id-ID", options).format(new Date(dateValue));
}

function statusLabel(status) {
  return { diproses: "Diproses", selesai: "Selesai" }[status] || "Masuk";
}

function statusClass(status) {
  return { diproses: "status-processing", selesai: "status-completed" }[status] || "status-incoming";
}

function createCell(className, content) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  if (content instanceof Node) cell.append(content);
  else cell.textContent = content;
  return cell;
}

function renderReports() {
  reportsBody.replaceChildren();
  reports.forEach((report) => {
    const row = document.createElement("tr");
    row.className = "report-row";

    const tokenCell = document.createElement("div");
    tokenCell.className = "report-reference";
    const token = document.createElement("strong");
    token.textContent = report.token;
    const submitted = document.createElement("small");
    submitted.textContent = formatDate(report.created_at);
    tokenCell.append(token, submitted);
    row.append(createCell("", tokenCell));

    const personCell = document.createElement("div");
    personCell.className = "report-reference";
    const person = document.createElement("strong");
    person.textContent = report.reported_name;
    const nim = document.createElement("small");
    nim.textContent = `NIM ${report.reported_nim}`;
    personCell.append(person, nim);
    row.append(createCell("", personCell));

    const category = document.createElement("span");
    category.className = "category-pill";
    category.textContent = report.category;
    row.append(createCell("", category));

    const reporterCell = document.createElement("div");
    reporterCell.className = "report-reference reporter-reference";
    const reporter = document.createElement("strong");
    reporter.textContent = report.reporter_name;
    const reporterNim = document.createElement("small");
    reporterNim.textContent = `NIM ${report.reporter_nim}`;
    reporterCell.append(reporter, reporterNim);
    row.append(createCell("", reporterCell));

    const status = document.createElement("span");
    status.className = `status-pill ${statusClass(report.status)}`;
    status.textContent = statusLabel(report.status);
    row.append(createCell("", status));

    const action = document.createElement("button");
    action.className = "row-action";
    action.type = "button";
    action.textContent = "Tinjau →";
    action.setAttribute("aria-label", `Tinjau laporan ${report.token}`);
    action.addEventListener("click", () => openReport(report.id));
    row.append(createCell("action-cell", action));
    reportsBody.append(row);
  });

  document.querySelector("#visible-count").textContent = document.querySelector("#pagination").dataset.total || "0";
  document.querySelector("#empty-state").hidden = reports.length > 0;
  document.querySelector("#last-updated").textContent = `Diperbarui ${new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
}

async function loadReports() {
  const params = new URLSearchParams();
  params.set("page", String(currentPage));
  if (searchInput.value.trim()) params.set("search", searchInput.value.trim());
  if (statusFilter.value !== "all") params.set("status", statusFilter.value);
  if (categoryFilter.value !== "all") params.set("category", categoryFilter.value);
  const result = await apiFetch(`/admin/reports?${params.toString()}`);
  reports = result.reports;
  currentPage = result.page;
  totalPages = result.totalPages;
  document.querySelector("#pagination").dataset.total = String(result.total);
  document.querySelector("#stat-total").textContent = result.stats.total;
  document.querySelector("#stat-incoming").textContent = result.stats.incoming;
  document.querySelector("#stat-processing").textContent = result.stats.processing;
  document.querySelector("#stat-completed").textContent = result.stats.completed;
  document.querySelector("#pagination-summary").textContent =
    `Halaman ${currentPage} dari ${totalPages} · ${result.total} laporan`;
  document.querySelector("#previous-page").disabled = currentPage <= 1;
  document.querySelector("#next-page").disabled = currentPage >= totalPages;
  renderReports();
}

function addDetailField(container, label, value) {
  const item = document.createElement("div");
  item.className = "detail-field";
  const title = document.createElement("span");
  title.textContent = label;
  const content = document.createElement("strong");
  content.textContent = value || "Tidak dicantumkan";
  item.append(title, content);
  container.append(item);
}

function renderAnalysis(analysis, aiStatus) {
  const preview = document.querySelector("#ai-preview");
  preview.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "ai-heading";
  const title = document.createElement("strong");
  title.textContent = "Pratinjau klasifikasi AI";
  const badge = document.createElement("span");
  badge.className = `ai-badge ${aiStatus === "completed" ? "ai-ready" : "ai-pending"}`;
  badge.textContent = aiStatus === "completed" ? "Perlu verifikasi Admin" : aiStatus === "pending" ? "Menunggu analisis" : "Analisis tidak tersedia";
  heading.append(title, badge);
  preview.append(heading);

  if (!analysis) {
    const message = document.createElement("p");
    message.className = "ai-empty";
    message.textContent = aiStatus === "failed"
      ? "Analisis AI tidak tersedia. Tinjau laporan dan dokumen Kode Etik secara manual."
      : "Analisis AI belum selesai. Coba perbarui laporan beberapa saat lagi.";
    preview.append(message);
    return;
  }

  const summary = document.createElement("p");
  summary.className = "ai-summary";
  summary.textContent = analysis.summary;
  preview.append(summary);

  const articlesTitle = document.createElement("strong");
  articlesTitle.className = "ai-subheading";
  articlesTitle.textContent = "Pasal yang disarankan untuk ditinjau";
  preview.append(articlesTitle);
  if (!analysis.article_matches?.length) {
    const noArticle = document.createElement("p");
    noArticle.className = "ai-empty";
    noArticle.textContent = "AI tidak menemukan pasal yang cukup relevan. Periksa dokumen resmi secara manual.";
    preview.append(noArticle);
  }
  analysis.article_matches?.forEach((match) => {
    const item = document.createElement("article");
    item.className = "ai-article";
    const articleLink = document.createElement("a");
    articleLink.href = "assets/kode-etik-mahasiswa-2026.pdf";
    articleLink.target = "_blank";
    articleLink.rel = "noopener noreferrer";
    articleLink.textContent = `Pasal ${match.article} — ${match.title}`;
    const relevance = document.createElement("p");
    relevance.textContent = match.relevance;
    const basis = document.createElement("small");
    basis.textContent = `Dasar dari laporan: ${match.basis}`;
    const excerpt = document.createElement("blockquote");
    excerpt.textContent = match.source_excerpt;
    item.append(articleLink, relevance, basis, excerpt);
    preview.append(item);
  });

  const recommendation = document.createElement("div");
  recommendation.className = "ai-recommendation";
  const recommendationTitle = document.createElement("strong");
  recommendationTitle.textContent = "Rekomendasi penelaahan";
  const recommendationText = document.createElement("p");
  recommendationText.textContent = analysis.recommendation;
  recommendation.append(recommendationTitle, recommendationText);
  if (analysis.next_steps?.length) {
    const steps = document.createElement("ul");
    analysis.next_steps.forEach((step) => {
      const item = document.createElement("li");
      item.textContent = step;
      steps.append(item);
    });
    recommendation.append(steps);
  }
  preview.append(recommendation);
  const caveat = document.createElement("p");
  caveat.className = "ai-caveat";
  caveat.textContent = analysis.caveat;
  preview.append(caveat);
}

function renderEvidence(evidence) {
  const container = document.createElement("div");
  container.className = "detail-evidence";
  const title = document.createElement("strong");
  title.textContent = `Bukti pendukung (${evidence.length})`;
  container.append(title);
  if (!evidence.length) {
    const empty = document.createElement("p");
    empty.textContent = "Tidak ada bukti yang dilampirkan.";
    container.append(empty);
    return container;
  }

  const list = document.createElement("ul");
  evidence.forEach((file) => {
    const item = document.createElement("li");
    const link = document.createElement("button");
    link.className = "evidence-link";
    link.type = "button";
    link.textContent = `${file.file_name} · ${Math.ceil(file.file_size / 1024)} KB`;
    link.addEventListener("click", async () => {
      try {
        const result = await apiFetch(`/admin/evidence/${file.id}`);
        window.open(result.url, "_blank", "noopener,noreferrer");
      } catch (error) {
        showToast(error.message, true);
      }
    });
    item.append(link);
    list.append(item);
  });
  container.append(list);
  return container;
}

function renderActivity(updates) {
  const activityLog = document.querySelector("#activity-log");
  activityLog.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = `Riwayat tindak lanjut (${updates.length})`;
  activityLog.append(heading);
  if (!updates.length) {
    const empty = document.createElement("p");
    empty.className = "activity-empty";
    empty.textContent = "Belum ada catatan tindak lanjut.";
    activityLog.append(empty);
    return;
  }
  [...updates].reverse().forEach((update) => {
    const entry = document.createElement("article");
    entry.className = "activity-entry";
    const note = document.createElement("p");
    note.textContent = update.note;
    const meta = document.createElement("small");
    const author = update.profiles?.username ? ` · ${update.profiles.username}` : "";
    meta.textContent = `${formatDate(update.created_at, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })} · Status ${statusLabel(update.status_new)}${author}`;
    entry.append(note, meta);
    activityLog.append(entry);
  });
}

async function loadUsers() {
  if (currentUser.role !== "Admin") {
    assignmentForm.hidden = true;
    return;
  }
  const { users } = await apiFetch("/admin/users");
  assigneeSelect.replaceChildren(new Option("Pilih akun petugas", ""));
  users.filter((user) => user.role !== "Admin").forEach((user) => {
    assigneeSelect.add(new Option(`${user.username} — ${user.role}`, user.username));
  });
  assignmentForm.hidden = false;
}

document.querySelector("#manage-accounts").addEventListener("click", async () => {
  accountError.hidden = true;
  accountDialog.showModal();
  try {
    await renderAccounts();
  } catch (error) {
    showToast(error.message, true);
  }
});
document.querySelector("[data-close-accounts]").addEventListener("click", () => accountDialog.close());

accountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  accountError.hidden = true;
  const submitButton = accountForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const formData = new FormData(accountForm);
    const created = await apiFetch("/admin/users", {
      method: "POST",
      body: JSON.stringify({
        username: formData.get("username"),
        role: formData.get("role"),
        password: formData.get("password"),
      }),
    });
    accountForm.reset();
    showToast(`Akun ${created.username} (${created.role}) berhasil dibuat.`);
    await Promise.all([renderAccounts(), loadUsers()]);
  } catch (error) {
    accountError.textContent = error.message;
    accountError.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
});

async function renderAccounts() {
  const { users } = await apiFetch("/admin/users");
  const list = document.querySelector("#account-list");
  const title = document.createElement("h3");
  title.textContent = `Akun aktif (${users.length})`;
  const items = document.createElement("ul");
  users.forEach((user) => {
    const item = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = user.username;
    const role = document.createElement("span");
    role.textContent = user.role;
    item.append(name, role);
    items.append(item);
  });
  list.replaceChildren(title, items);
}

async function openReport(id) {
  try {
    const { report } = await apiFetch(`/admin/reports/${encodeURIComponent(id)}`);
    activeReportId = report.id;
    document.querySelector("#detail-token").textContent = report.token;
    document.querySelector("#detail-status").value = report.status;
    document.querySelector("#follow-up-note").value = "";

    const content = document.querySelector("#detail-content");
    content.replaceChildren();
    const grid = document.createElement("div");
    grid.className = "detail-grid";
    addDetailField(grid, "Nama pelapor", report.reporter_name);
    addDetailField(grid, "NIM pelapor", report.reporter_nim);
    addDetailField(grid, "Email pelapor", report.reporter_email);
    addDetailField(grid, "Telepon pelapor", report.reporter_phone);
    addDetailField(grid, "Program studi pelapor", report.reporter_study_program);
    addDetailField(grid, "Fakultas pelapor", report.reporter_faculty);
    addDetailField(grid, "Nama terlapor", report.reported_name);
    addDetailField(grid, "NIM terlapor", report.reported_nim);
    addDetailField(grid, "Program studi terlapor", report.reported_study_program);
    addDetailField(grid, "Fakultas terlapor", report.reported_faculty);
    addDetailField(grid, "Kategori", report.category);
    addDetailField(grid, "Tanggal kejadian", formatDate(report.incident_date));
    addDetailField(grid, "Perkiraan waktu", report.incident_time);
    addDetailField(grid, "Lokasi", report.incident_location);
    addDetailField(grid, "Status penugasan", report.assigned_role ? `${report.assigned_to ? "Petugas ditetapkan" : "Peran"} · ${report.assigned_role}` : "Menunggu pratinjau Admin");
    content.append(grid);

    const description = document.createElement("div");
    description.className = "detail-description";
    const descriptionTitle = document.createElement("strong");
    descriptionTitle.textContent = "Kronologi kejadian";
    const descriptionText = document.createElement("p");
    descriptionText.textContent = report.description;
    description.append(descriptionTitle, descriptionText);
    content.append(description, renderEvidence(report.evidence));

    renderAnalysis(report.ai_analysis, report.ai_status);
    renderActivity(report.follow_ups);
    await loadUsers();
    reportDialog.showModal();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function bootstrap() {
  try {
    currentUser = await apiFetch("/auth/me");
    document.querySelector(".admin-identity strong").textContent = currentUser.username;
    document.querySelector(".admin-identity small").textContent = currentUser.role;
    document.querySelector("#admin-logout").hidden = false;
    document.querySelector("#manage-accounts").hidden = currentUser.role !== "Admin";
    document.querySelector(".admin-main").hidden = false;
    loginDialog.close();
    await loadReports();
  } catch (error) {
    if (error.message.includes("Silakan masuk")) {
      loginDialog.showModal();
      return;
    }
    showToast(error.message, true);
    loginDialog.showModal();
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  const submitButton = loginForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const formData = new FormData(loginForm);
    currentUser = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: formData.get("username"),
        password: formData.get("password"),
      }),
    });
    saveSession({ accessToken: currentUser.accessToken, refreshToken: currentUser.refreshToken });
    loginForm.reset();
    await bootstrap();
  } catch (error) {
    loginError.textContent = error.message;
    loginError.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
});

searchInput.addEventListener("input", () => {
  currentPage = 1;
  window.clearTimeout(searchTimeout);
  searchTimeout = window.setTimeout(() => loadReports().catch((error) => showToast(error.message, true)), 250);
});
statusFilter.addEventListener("change", () => {
  currentPage = 1;
  loadReports().catch((error) => showToast(error.message, true));
});
categoryFilter.addEventListener("change", () => {
  currentPage = 1;
  loadReports().catch((error) => showToast(error.message, true));
});
document.querySelector("#previous-page").addEventListener("click", () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  loadReports().catch((error) => showToast(error.message, true));
});
document.querySelector("#next-page").addEventListener("click", () => {
  if (currentPage >= totalPages) return;
  currentPage += 1;
  loadReports().catch((error) => showToast(error.message, true));
});
document.querySelector("#refresh-dashboard").addEventListener("click", () => {
  loadReports().then(() => showToast("Daftar laporan diperbarui.")).catch((error) => showToast(error.message, true));
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
  }
});
document.querySelector("[data-close-detail]").addEventListener("click", () => reportDialog.close());
document.querySelector("#reload-admin").addEventListener("click", () => window.location.reload());
document.querySelector("#admin-logout").addEventListener("click", async () => {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    // Sesi lokal tetap dihapus meskipun pencabutan di server gagal.
  } finally {
    saveSession(null);
    window.location.reload();
  }
});

assignmentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = assignmentForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await apiFetch(`/admin/reports/${encodeURIComponent(activeReportId)}/assignment`, {
      method: "PATCH",
      body: JSON.stringify({ username: assigneeSelect.value }),
    });
    showToast(`Laporan ditugaskan kepada ${result.assignedTo} (${result.assignedRole}).`);
    await loadReports();
    await openReport(activeReportId);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

followUpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = followUpForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await apiFetch(`/admin/reports/${encodeURIComponent(activeReportId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: document.querySelector("#detail-status").value,
        note: document.querySelector("#follow-up-note").value,
      }),
    });
    document.querySelector("#follow-up-note").value = "";
    showToast(result.message);
    await loadReports();
    await openReport(activeReportId);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

bootstrap();
