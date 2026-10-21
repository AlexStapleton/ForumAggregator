// Writes .br and .gz next to each built file, once, at the highest levels, so the server can send
// them as they are instead of compressing on every request (D-086). Only when it saves space.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dist = path.resolve(import.meta.dirname, "../dist");
const COMPRESSIBLE = /\.(js|css|html|svg|json|webmanifest|txt)$/;
let saved = 0;
for (const entry of fs.readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !COMPRESSIBLE.test(entry.name)) continue;
  const file = path.join(entry.parentPath, entry.name);
  const raw = fs.readFileSync(file);
  if (raw.length < 1024) continue;
  const br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
  const gz = zlib.gzipSync(raw, { level: 9 });
  if (br.length < raw.length) fs.writeFileSync(`${file}.br`, br);
  if (gz.length < raw.length) fs.writeFileSync(`${file}.gz`, gz);
  saved += raw.length - br.length;
}
console.log(`precompressed web files (brotli saves ${Math.round(saved / 1024)} kB)`);
