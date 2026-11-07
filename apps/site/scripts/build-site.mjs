import fs from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);

const publicDir = new URL("public/", root);
const files = await readdir(publicDir);

const marker = /(<span class="version-chip" id="version-chip">)[^<]*(<\/span>)/g;
let updatedCount = 0;

for (const file of files) {
  if (file.endsWith(".html")) {
    const filePath = new URL(`public/${file}`, root);
    const content = await readFile(filePath, "utf8");
    if (marker.test(content)) {
      await writeFile(filePath, content.replace(marker, `$1v${version}$2`));
      updatedCount++;
    }
  }
}

if (updatedCount === 0) {
  throw new Error("No website version markers found in public HTML files");
}

execFileSync(
  process.execPath,
  [
    fs.existsSync(fileURLToPath(new URL("node_modules/typescript/bin/tsc", root)))
      ? fileURLToPath(new URL("node_modules/typescript/bin/tsc", root))
      : fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", root)),
    "-p",
    fileURLToPath(new URL("public/tsconfig.json", root)),
  ],
  { stdio: "inherit" },
);
