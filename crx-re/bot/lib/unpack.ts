import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { CrxReError } from "./errors.ts";

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new CrxReError("NOT_CRX", "Failed to open zip payload."));
        return;
      }
      resolve(zip);
    });
  });
}

function safeJoin(root: string, entryName: string): string {
  const normalized = entryName.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("\0") || /(^|\/)\.\.(\/|$)/.test(normalized)) {
    throw new CrxReError("ZIP_SLIP", `Refusing zip path: ${entryName}`);
  }
  const dest = path.resolve(root, normalized);
  const rel = path.relative(root, dest);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CrxReError("ZIP_SLIP", `Refusing zip path: ${entryName}`);
  }
  return dest;
}

export async function unpackZip(buffer: Buffer, destDir: string): Promise<string[]> {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });

  const zip = await openZip(buffer);
  const written: string[] = [];

  await new Promise<void>((resolve, reject) => {
    zip.on("error", reject);
    zip.on("end", () => resolve());
    zip.on("entry", (entry: yauzl.Entry) => {
      const name = entry.fileName;
      if (name.endsWith("/")) {
        mkdir(safeJoin(destDir, name), { recursive: true })
          .then(() => zip.readEntry())
          .catch(reject);
        return;
      }

      let dest: string;
      try {
        dest = safeJoin(destDir, name);
      } catch (error) {
        reject(error);
        return;
      }

      zip.openReadStream(entry, (error, readStream) => {
        if (error || !readStream) {
          reject(error ?? new Error("Missing zip entry stream"));
          return;
        }
        mkdir(path.dirname(dest), { recursive: true })
          .then(() => pipeline(readStream, createWriteStream(dest)))
          .then(() => {
            written.push(name.replace(/\\/g, "/"));
            zip.readEntry();
          })
          .catch(reject);
      });
    });
    zip.readEntry();
  });

  return written.sort();
}
