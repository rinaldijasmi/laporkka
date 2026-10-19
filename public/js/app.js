const form = document.querySelector("#report-form");
const fileInput = document.querySelector("#evidence-files");
const fileList = document.querySelector("#file-list");
const fileError = document.querySelector("#file-error");
const uploadZone = document.querySelector("#upload-zone");
const characterCount = document.querySelector("#character-count");
const description = form.elements.description;
const demoNotice = document.querySelector("#demo-notice");
const submissionError = document.querySelector("#submission-error");
const issuedToken = document.querySelector("#issued-token");
const trackingDialog = document.querySelector("#tracking-dialog");
const trackingForm = document.querySelector("#tracking-form");
const trackingTokenInput = document.querySelector("#tracking-token");
const trackingResult = document.querySelector("#tracking-result");
const allowedExtensions = new Set(["pdf", "png", "jpg", "jpeg", "zip"]);
const maxTotalBytes = 25 * 1024 * 1024;
let selectedFiles = [];

function fileExtension(file) {
  return file.name.split(".").pop().toLowerCase();
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showFileError(message = "") {
  fileError.textContent = message;
  fileError.hidden = !message;
}

function showSubmissionError(message = "") {
  submissionError.textContent = message;
  submissionError.hidden = !message;
}

function renderFiles() {
  fileList.replaceChildren();
  selectedFiles.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "file-item";

    const type = document.createElement("span");
    type.className = "file-type";
    type.textContent = fileExtension(file).slice(0, 4);

    const info = document.createElement("span");
    info.className = "file-info";
    const name = document.createElement("strong");
    name.textContent = file.name;
    const size = document.createElement("small");
    size.textContent = formatBytes(file.size);
    info.append(name, size);

    const remove = document.createElement("button");
    remove.className = "file-remove";
    remove.type = "button";
    remove.setAttribute("aria-label", `Hapus ${file.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      selectedFiles.splice(index, 1);
      syncFileInput();
      renderFiles();
      showFileError();
    });

    item.append(type, info, remove);
    fileList.append(item);
  });
}

function syncFileInput() {
  const transfer = new DataTransfer();
  selectedFiles.forEach((file) => transfer.items.add(file));
  fileInput.files = transfer.files;
}

function addFiles(files) {
  const combined = [...selectedFiles, ...Array.from(files)];
  const invalid = combined.find((file) => !allowedExtensions.has(fileExtension(file)));
  if (invalid) {
    showFileError(`Format berkas "${invalid.name}" tidak didukung. Pilih PDF, PNG, JPG, atau ZIP.`);
    return;
  }

  const totalSize = combined.reduce((total, file) => total + file.size, 0);
  if (totalSize > maxTotalBytes) {
    showFileError("Ukuran total berkas melebihi batas 25 MB.");
    return;
  }

  const duplicates = new Set();
  selectedFiles = combined.filter((file) => {
    const signature = `${file.name}:${file.size}:${file.lastModified}`;
    if (duplicates.has(signature)) return false;
    duplicates.add(signature);
    return true;
  });
  syncFileInput();
  renderFiles();
  showFileError();
}

fileInput.addEventListener("change", (event) => addFiles(event.target.files));

for (const eventName of ["dragenter", "dragover"]) {
  uploadZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  uploadZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadZone.classList.remove("dragging");
  });
}
uploadZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));

description.addEventListener("input", () => {
  characterCount.textContent = `${description.value.length} / 3000`;
});

form.addEventListener("reset", () => {
  window.setTimeout(() => {
    selectedFiles = [];
    renderFiles();
    showFileError();
    demoNotice.hidden = true;
    showSubmissionError();
    document.querySelector("#copy-token").textContent = "Salin token";
    characterCount.textContent = "0 / 3000";
  });
});

document.querySelector("#open-policy").addEventListener("click", () => {
  document.querySelector("#policy-dialog").showModal();
});

document.querySelector("#open-tracking").addEventListener("click", () => {
  trackingResult.hidden = true;
  trackingDialog.showModal();
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

document.querySelector("#copy-token").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(issuedToken.textContent);
    document.querySelector("#copy-token").textContent = "Token tersalin";
  } catch {
    issuedToken.focus();
    window.getSelection().selectAllChildren(issuedToken);
    document.querySelector("#copy-token").textContent = "Pilih dan salin token";
  }
});

trackingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  trackingResult.replaceChildren();
  trackingResult.hidden = true;
  trackingResult.classList.remove("tracking-success");
  const submitButton = trackingForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  fetch(`${window.LAPORKKA_API_BASE}/reports/track`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: trackingTokenInput.value.trim().toUpperCase() }),
  }).then(async (response) => {
    const report = await response.json();
    if (!response.ok) throw new Error(report.error || "Laporan tidak dapat dilacak.");
    trackingResult.replaceChildren();
    const heading = document.createElement("strong");
    const message = document.createElement("span");
    heading.textContent = `Laporan ditemukan · Status ${{ diproses: "Diproses", selesai: "Selesai" }[report.status] || "Masuk"}`;
    message.textContent = `Kategori ${report.category} · Dikirim ${new Intl.DateTimeFormat("id-ID", { dateStyle: "long" }).format(new Date(report.submittedAt))}`;
    trackingResult.append(heading, message);
    if (report.updates.length) {
      const updatesHeading = document.createElement("strong");
      updatesHeading.textContent = "Catatan tindak lanjut";
      trackingResult.append(updatesHeading);
      report.updates.forEach((update) => {
        const item = document.createElement("span");
        item.textContent = `${new Intl.DateTimeFormat("id-ID", { dateStyle: "medium" }).format(new Date(update.createdAt))} · ${update.note}`;
        trackingResult.append(item);
      });
    }
    trackingResult.classList.add("tracking-success");
  }).catch((error) => {
    trackingResult.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = "Laporan tidak dapat dilacak";
    const message = document.createElement("span");
    message.textContent = error.message;
    trackingResult.append(heading, message);
  }).finally(() => {
    trackingResult.hidden = false;
    submitButton.disabled = false;
  });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  demoNotice.hidden = true;
  showSubmissionError();

  if (!form.reportValidity()) return;
  if (description.value.trim().length < 30) {
    description.setCustomValidity("Kronologi harus berisi minimal 30 karakter.");
    description.reportValidity();
    description.setCustomValidity("");
    return;
  }
  if (fileError.textContent) {
    fileError.focus();
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  const submitLabel = submitButton.innerHTML;
  const payload = new FormData(form);
  submitButton.disabled = true;
  submitButton.textContent = "Mengirim laporan...";

  fetch(`${window.LAPORKKA_API_BASE}/reports`, { method: "POST", body: payload })
    .then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Laporan gagal dikirim.");
      issuedToken.textContent = result.token;
      demoNotice.hidden = false;
      demoNotice.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return result;
    })
    .catch((error) => {
      showSubmissionError(`Laporan belum dapat dikonfirmasi: ${error.message} Periksa koneksi sebelum mencoba kembali.`);
      submissionError.scrollIntoView({ behavior: "smooth", block: "nearest" });
    })
    .finally(() => {
      submitButton.disabled = false;
      submitButton.innerHTML = submitLabel;
    });
});
