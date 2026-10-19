import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

const roles = [
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
];

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variabel ${name} belum diatur di .env.`);
  return value;
}

const supabase = createClient(
  requiredEnv("SUPABASE_URL"),
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const readline = createInterface({ input, output });
function readHiddenPassword() {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Jalankan perintah ini dari terminal interaktif agar password tidak ditampilkan.");
  }
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write("Password (minimal 12 karakter): ");
  return new Promise((resolve, reject) => {
    let password = "";
    const onKeypress = (character, key) => {
      if (key?.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Pembuatan akun dibatalkan."));
        return;
      }
      if (key?.name === "return" || key?.name === "enter") {
        cleanup();
        resolve(password);
        return;
      }
      if (key?.name === "backspace") {
        password = password.slice(0, -1);
        return;
      }
      if (character && !key?.ctrl && !key?.meta) password += character;
    };
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      output.write("\n");
    };
    input.on("keypress", onKeypress);
  });
}

try {
  const username = (await readline.question("Username (3-32 karakter): ")).trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new Error("Username harus berisi 3-32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.");
  }

  console.log(`Peran tersedia: ${roles.join(", ")}`);
  const role = (await readline.question("Peran: ")).trim();
  if (!roles.includes(role)) throw new Error("Peran tidak dikenal.");

  readline.close();
  const password = await readHiddenPassword();
  if (password.length < 12) throw new Error("Password harus memiliki minimal 12 karakter.");

  const email = `${username.toLowerCase()}@login.laporkka.invalid`;
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username },
  });
  if (error) throw new Error(`Akun Auth gagal dibuat: ${error.message}`);

  const { error: profileError } = await supabase.from("profiles").insert({
    id: data.user.id,
    username,
    role,
  });
  if (profileError) {
    const { error: cleanupError } = await supabase.auth.admin.deleteUser(data.user.id);
    if (cleanupError) {
      throw new Error(`Profil gagal dibuat (${profileError.message}) dan akun Auth gagal dibersihkan (${cleanupError.message}).`);
    }
    throw new Error(`Profil gagal dibuat; akun Auth dibersihkan: ${profileError.message}`);
  }

  console.log(`Akun ${username} berhasil dibuat dengan peran ${role}.`);
} finally {
  readline.close();
}
