import { readFile, writeFile } from "node:fs/promises";

const targetFile = process.argv[2];
if (!targetFile) {
  throw new Error("Usage: node scripts/postbuild-shebang.mjs <file>");
}

const shebang = "#!/usr/bin/env node\n";
const contents = await readFile(targetFile, "utf8");

if (!contents.startsWith("#!")) {
  await writeFile(targetFile, shebang + contents, "utf8");
}

