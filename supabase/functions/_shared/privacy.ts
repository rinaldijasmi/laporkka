export const USER_ROLES = Object.freeze([
  "Admin",
  "PKKM",
  "PKM",
  "ASUS",
  "Akademik",
  "Kemahasiswaan FTE",
  "Kemahasiswaan FIF",
  "Kemahasiswaan FRI",
  "Kemahasiswa FKS",
  "Kemahasiswaan FKB",
  "Kemahasiswaan FIK",
  "Kemahasiswaan FIT",
  "Kemahasiswaan FK",
  "Kemahasiswaan TUJ",
  "Kemahasiswaan TUS",
  "Kemahasiswaan TUP",
]);

const PRIVATE_TEXT_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /\b(?:\+?62|0)\d[\d\s().-]{7,}\d\b/gu,
  /\b\d{6,}\b/gu,
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactReportText(description: string, privateValues: unknown[] = []) {
  let redacted = description;
  const names = privateValues
    .filter((value): value is string => typeof value === "string" && value.trim().length >= 2)
    .map((value) => value.trim())
    .sort((left, right) => right.length - left.length);

  for (const value of names) {
    redacted = redacted.replace(new RegExp(escapeRegExp(value), "giu"), "[DIHAPUS]");
  }

  for (const pattern of PRIVATE_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, "[DIHAPUS]");
  }
  return redacted;
}
