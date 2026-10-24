import { CrxReError } from "./errors.ts";

const CR24 = Buffer.from("Cr24", "ascii");
const PK = Buffer.from("PK", "ascii");

export type CrxInfo = {
  format: "crx2" | "crx3" | "zip";
  zip: Buffer;
};

export function stripCrx(bytes: Buffer): CrxInfo {
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(PK)) {
    return { format: "zip", zip: bytes };
  }
  if (bytes.length < 16 || !bytes.subarray(0, 4).equals(CR24)) {
    throw new CrxReError("NOT_CRX", "File is not a CRX (missing Cr24) or a zip.");
  }

  const version = bytes.readUInt32LE(4);
  let zipOffset: number;
  let format: "crx2" | "crx3";

  if (version === 2) {
    const pubkeyLen = bytes.readUInt32LE(8);
    const sigLen = bytes.readUInt32LE(12);
    zipOffset = 16 + pubkeyLen + sigLen;
    format = "crx2";
  } else if (version === 3) {
    const headerLen = bytes.readUInt32LE(8);
    zipOffset = 12 + headerLen;
    format = "crx3";
  } else {
    throw new CrxReError("NOT_CRX", `Unsupported CRX version ${version}.`);
  }

  if (zipOffset >= bytes.length) {
    throw new CrxReError("NOT_CRX", "CRX header claims a zip offset past the file.");
  }

  const zip = bytes.subarray(zipOffset);
  if (zip.length < 2 || !zip.subarray(0, 2).equals(PK)) {
    throw new CrxReError("NOT_CRX", "CRX payload is not a zip.");
  }
  return { format, zip };
}
