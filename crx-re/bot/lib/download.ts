import { CrxReError } from "./errors.ts";
import { storeDownloadUrl } from "./resolve.ts";

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export type DownloadResult = {
  bytes: Buffer;
  contentType: string | null;
  finalUrl: string;
  status: number;
};

export async function downloadStoreCrx(
  id: string,
  options: { maxBytes?: number; prodversion?: string } = {},
): Promise<DownloadResult> {
  const url = storeDownloadUrl(id, options.prodversion);
  return downloadUrl(url, options);
}

export async function downloadUrl(
  url: string,
  options: { maxBytes?: number } = {},
): Promise<DownloadResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36",
      accept: "application/x-chrome-extension,application/octet-stream,*/*",
    },
  });

  if (response.status === 404) {
    throw new CrxReError("STORE_NOT_FOUND", "Chrome Web Store returned 404 for this ID.");
  }
  if (response.status === 204 || response.status === 304) {
    throw new CrxReError("STORE_NO_CRX", "Store returned no CRX body (204/304).");
  }
  if (!response.ok) {
    throw new CrxReError("STORE_NO_CRX", `Download failed with HTTP ${response.status}.`);
  }

  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > maxBytes) {
    throw new CrxReError(
      "DOWNLOAD_TOO_LARGE",
      `CRX is ${length} bytes; over the ${maxBytes} cap. Pass --force to raise.`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new CrxReError(
      "DOWNLOAD_TOO_LARGE",
      `CRX is ${buffer.length} bytes; over the ${maxBytes} cap. Pass --force to raise.`,
    );
  }
  if (buffer.length === 0) {
    throw new CrxReError("STORE_NO_CRX", "Download body was empty.");
  }

  return {
    bytes: buffer,
    contentType: response.headers.get("content-type"),
    finalUrl: response.url,
    status: response.status,
  };
}
