import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const root = new URL("../", import.meta.url);
const { version } = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const page = new URL("public/index.html", root);
const html = await readFile(page, "utf8");
const marker = /(<span class="version-chip" id="version-chip">)[^<]*(<\/span>)/;
if (!marker.test(html)) throw new Error("Website version marker is missing");
await writeFile(page, html.replace(marker, `$1v${version}$2`));
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL("node_modules/typescript/bin/tsc", root)),
    "-p",
    fileURLToPath(new URL("public/tsconfig.json", root)),
  ],
  { stdio: "inherit" },
);
