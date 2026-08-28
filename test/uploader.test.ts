import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createGenericFile } from '@metaplex-foundation/umi';
import { createCascadeUploader } from '../src/createCascadeUploader.js';

const ctx = {} as any; // uploader never touches rpc/payer

const file = (name: string, content = 'hello') =>
  createGenericFile(new TextEncoder().encode(content), name, {
    contentType: 'image/png',
  });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('file mode (default)', () => {
  it('posts each file to /upload and returns /download/{action_id} URIs', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ action_id: '15823' }))
      .mockResolvedValueOnce(jsonResponse({ action_id: '15824' }));

    const uploader = createCascadeUploader(ctx, {
      endpoint: 'https://api.example.test/',
      apiKey: 'k1',
    });
    const uris = await uploader.upload([file('1.png'), file('2.png')]);

    expect(uris).toEqual([
      'https://api.example.test/download/15823',
      'https://api.example.test/download/15824',
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/upload');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer k1');
    expect(init!.body).toBeInstanceOf(FormData);
    expect((init!.body as FormData).get('file')).toBeInstanceOf(Blob);
  });

  it('reports progress per file', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ action_id: '1' })
    );
    const uploader = createCascadeUploader(ctx, {});
    const seen: number[] = [];
    await uploader.upload([file('a'), file('b')], {
      onProgress: (p: number) => seen.push(p),
    });
    expect(seen).toEqual([0.5, 1]);
  });

  it('throws on non-2xx instead of swallowing errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('insufficient balance', { status: 402 })
    );
    const uploader = createCascadeUploader(ctx, {});
    await expect(uploader.upload([file('a.png')])).rejects.toThrow(/HTTP 402/);
  });

  it('throws when the gateway returns no action_id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
    const uploader = createCascadeUploader(ctx, {});
    await expect(uploader.upload([file('a.png')])).rejects.toThrow(/no action_id/);
  });
});

describe('archive mode', () => {
  it('packs one call into one action and returns per-entry URIs', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ action_id: '15777' }));

    const uploader = createCascadeUploader(ctx, {
      endpoint: 'https://api.example.test',
      mode: 'archive',
    });
    const uris = await uploader.upload([file('imgs/1.png'), file('imgs/2.png')]);

    expect(uris).toEqual([
      'https://api.example.test/download/15777/imgs/1.png',
      'https://api.example.test/download/15777/imgs/2.png',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.test/upload/folder');
    // fields must precede file parts — the gateway 400s otherwise
    const parts = [...(fetchMock.mock.calls[0][1]!.body as FormData).keys()];
    expect(parts[0]).toBe('name');
  });

  it('rejects duplicate file names', async () => {
    const uploader = createCascadeUploader(ctx, { mode: 'archive' });
    await expect(
      uploader.upload([file('same.png'), file('same.png')])
    ).rejects.toThrow(/unique file names/);
  });

  it('falls back to a single action for a single file', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ action_id: '9' }));
    const uploader = createCascadeUploader(ctx, { mode: 'archive' });
    const uris = await uploader.upload([file('only.png')]);
    expect(uris).toEqual(['https://api.lumera.help/download/9']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.lumera.help/upload');
  });
});

describe('uploadJson', () => {
  it('uploads metadata as its own action and returns one URI', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ action_id: '42' }));
    const uploader = createCascadeUploader(ctx, { mode: 'archive' });
    const uri = await uploader.uploadJson({ name: 'My NFT' });
    expect(uri).toBe('https://api.lumera.help/download/42');
  });
});

describe('pricing', () => {
  it('getUploadPrice is 0 SOL (the gateway key pays the LUME)', async () => {
    const uploader = createCascadeUploader(ctx, {});
    const price = await uploader.getUploadPrice([file('a.png')]);
    expect(price.basisPoints).toBe(0n);
    expect(price.identifier).toBe('SOL');
  });

  it('getUploadPriceUlume quotes /estimate per file in file mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        total_ulume: 40030,
        items: [
          { bytes: 5, fee_ulume: 20010 },
          { bytes: 5, fee_ulume: 20020 },
        ],
      })
    );
    const uploader = createCascadeUploader(ctx, {});
    const total = await uploader.getUploadPriceUlume([file('a'), file('b')]);
    expect(total).toBe(40030n);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.lumera.help/estimate?bytes=5,5');
  });

  it('getUploadPriceUlume quotes one summed size in archive mode', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ total_ulume: 20010, items: [] }));
    const uploader = createCascadeUploader(ctx, { mode: 'archive' });
    await uploader.getUploadPriceUlume([file('a'), file('b')]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.lumera.help/estimate?bytes=10');
  });
});
