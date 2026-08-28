import {
  Context,
  createGenericFileFromJson,
  GenericFile,
  lamports,
  SolAmount,
  UploaderInterface,
  UploaderUploadOptions,
} from '@metaplex-foundation/umi';

export type CascadeUploaderOptions = {
  /**
   * Base URL of a cascade-api gateway.
   * Defaults to the hosted gateway at https://api.lumera.help.
   */
  endpoint?: string;
  /**
   * Bearer key for the gateway's /upload endpoints. Optional only when the
   * gateway runs without auth (local development).
   */
  apiKey?: string;
  /**
   * 'file' (default): one Cascade action per file — every URI is
   * `{endpoint}/download/{action_id}` and files are independent.
   * 'archive': all files passed to one upload() call are packed into a single
   * Cascade action — URIs are `{endpoint}/download/{action_id}/{fileName}`,
   * and the base action fee is paid once for the whole batch. This is the
   * right mode for large collections (one fee instead of thousands).
   */
  mode?: 'file' | 'archive';
};

export type CascadeEstimate = {
  totalUlume: bigint;
  items: { bytes: number; feeUlume: bigint }[];
};

const DEFAULT_ENDPOINT = 'https://api.lumera.help';

export function createCascadeUploader(
  _context: Pick<Context, 'rpc' | 'payer'>,
  options: CascadeUploaderOptions = {}
): UploaderInterface & {
  /** Quote the gateway's LUME cost for arbitrary sizes (bytes). */
  estimate: (sizes: number[]) => Promise<CascadeEstimate>;
  /** The LUME (ulume) the gateway will spend inscribing these files. */
  getUploadPriceUlume: (files: GenericFile[]) => Promise<bigint>;
} {
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const { apiKey, mode = 'file' } = options;

  const authHeaders = (): Record<string, string> =>
    apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  const call = async (path: string, init?: RequestInit): Promise<any> => {
    const res = await fetch(`${endpoint}${path}`, init);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `cascade-api ${init?.method ?? 'GET'} ${path} failed: HTTP ${res.status} ${text.slice(0, 500)}`
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`cascade-api ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  };

  const toBlob = (file: GenericFile): Blob =>
    new Blob([new Uint8Array(file.buffer)], {
      type: file.contentType ?? 'application/octet-stream',
    });

  const uploadOne = async (
    file: GenericFile,
    opts?: UploaderUploadOptions
  ): Promise<string> => {
    const body = new FormData();
    body.append('file', toBlob(file), file.fileName);
    const data = await call('/upload', {
      method: 'POST',
      headers: authHeaders(),
      body,
      signal: (opts?.signal ?? null) as AbortSignal | null,
    });
    if (!data.action_id) {
      throw new Error(
        `cascade-api /upload returned no action_id for ${file.fileName}: ${JSON.stringify(data).slice(0, 200)}`
      );
    }
    return `${endpoint}/download/${data.action_id}`;
  };

  const uploadFiles = async (
    files: GenericFile[],
    opts?: UploaderUploadOptions
  ): Promise<string[]> => {
    const uris: string[] = [];
    for (let i = 0; i < files.length; i += 1) {
      uris.push(await uploadOne(files[i], opts));
      opts?.onProgress?.((i + 1) / files.length);
    }
    return uris;
  };

  const uploadArchive = async (
    files: GenericFile[],
    opts?: UploaderUploadOptions
  ): Promise<string[]> => {
    const seen = new Set<string>();
    for (const f of files) {
      if (seen.has(f.fileName)) {
        throw new Error(
          `archive mode needs unique file names, got "${f.fileName}" twice — ` +
            'rename the files or use mode: "file"'
        );
      }
      seen.add(f.fileName);
    }
    const body = new FormData();
    // cascade-api requires fields to precede the first `files` part.
    body.append('name', 'umi-upload');
    for (const f of files) {
      // The part's filename carries the path inside the archive.
      body.append('files', toBlob(f), f.fileName);
    }
    const data = await call('/upload/folder', {
      method: 'POST',
      headers: authHeaders(),
      body,
      signal: (opts?.signal ?? null) as AbortSignal | null,
    });
    if (!data.action_id) {
      throw new Error(
        `cascade-api /upload/folder returned no action_id: ${JSON.stringify(data).slice(0, 200)}`
      );
    }
    opts?.onProgress?.(1);
    return files.map((f) => `${endpoint}/download/${data.action_id}/${f.fileName}`);
  };

  const upload = async (
    files: GenericFile[],
    opts?: UploaderUploadOptions
  ): Promise<string[]> => {
    if (files.length === 0) return [];
    return mode === 'archive' && files.length > 1
      ? uploadArchive(files, opts)
      : uploadFiles(files, opts);
  };

  const uploadJson = async <T>(json: T, opts?: UploaderUploadOptions): Promise<string> =>
    // JSON metadata is always its own action so its URI stays stable
    // regardless of the mode used for media files.
    uploadOne(createGenericFileFromJson(json), opts);

  const estimate = async (sizes: number[]): Promise<CascadeEstimate> => {
    if (sizes.length === 0) return { totalUlume: 0n, items: [] };
    const query = sizes.map((s) => Math.max(0, Math.ceil(s))).join(',');
    const data = await call(`/estimate?bytes=${query}`);
    return {
      totalUlume: BigInt(data.total_ulume ?? 0),
      items: (data.items ?? []).map((it: { bytes: number; fee_ulume: number }) => ({
        bytes: it.bytes,
        feeUlume: BigInt(it.fee_ulume),
      })),
    };
  };

  const getUploadPriceUlume = async (files: GenericFile[]): Promise<bigint> => {
    if (files.length === 0) return 0n;
    const sizes =
      mode === 'archive' && files.length > 1
        ? [files.reduce((sum, f) => sum + f.buffer.byteLength, 0)]
        : files.map((f) => f.buffer.byteLength);
    return (await estimate(sizes)).totalUlume;
  };

  // The caller pays nothing in SOL — the gateway's key pays the LUME fee,
  // metered against the caller's API key. The real cost is available via
  // getUploadPriceUlume / estimate.
  const getUploadPrice = async (): Promise<SolAmount> => lamports(0);

  return {
    upload,
    uploadJson,
    getUploadPrice,
    estimate,
    getUploadPriceUlume,
  };
}
