# umi-uploader-cascade

A [Metaplex Umi](https://developers.metaplex.com/umi) uploader plugin that
stores NFT assets **permanently** on [Lumera Cascade](https://lumera.io)
(pay once, store forever) through a
[cascade-api](https://api.lumera.help) gateway.

Works everywhere Umi's uploader interface is used: Token Metadata, Core,
Core Candy Machine, and Bubblegum flows all consume the URIs it returns.

> **Status:** working against the hosted testnet gateway at `https://api.lumera.help`.

## Install

```sh
npm install @lumera-protocol/umi-uploader-cascade
```

## Why this exists

Metaplex already merged a Cascade uploader in 2024
([umi PR #125](https://github.com/metaplex-foundation/umi/pull/125), published
as `@metaplex-foundation/umi-uploader-cascade`), but it points at the retired
Pastel gateway (`gateway-api.pastel.network`, DNS now dead) and has known
defects (swallowed errors, hardcoded 0 price, stray `console.log`). This
package is the post-rebrand replacement, built against the live Lumera
gateway, with real error propagation and real pricing.

## Usage

```ts
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { cascadeUploader } from '@lumera-protocol/umi-uploader-cascade';

const umi = createUmi('https://api.mainnet-beta.solana.com')
  .use(cascadeUploader({ apiKey: process.env.CASCADE_API_KEY! }));

// Media + metadata for a single NFT
const [imageUri] = await umi.uploader.upload([imageFile]);
const metadataUri = await umi.uploader.uploadJson({
  name: 'My NFT',
  image: imageUri,
});
```

Every URI is a stable, immutable, publicly cacheable gateway URL:
`https://api.lumera.help/download/{action_id}`.

### Archive mode (large collections)

Cascade charges `base_action_fee + fee_per_kbyte × size` **per action**, so
inscribing 10,000 files individually pays the base fee 10,000 times. Archive
mode packs all files from one `upload()` call into a single action — one fee —
while each file stays individually addressable:

```ts
umi.use(cascadeUploader({ apiKey, mode: 'archive' }));

const uris = await umi.uploader.upload(collectionImages);
// -> https://api.lumera.help/download/15777/imgs/1.png, .../imgs/2.png, ...
```

`uploadJson` always inscribes metadata as its own action regardless of mode.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `endpoint` | `https://api.lumera.help` | Any cascade-api deployment |
| `apiKey` | — | Bearer key for the gateway's `/upload*` routes |
| `mode` | `'file'` | `'file'` = one action per file; `'archive'` = one action per `upload()` call |

### Pricing

`getUploadPrice()` returns **0 SOL** — the caller never pays Solana-side: the
gateway's Lumera key pays the LUME fee, metered against the caller's API key.
The real cost is exposed instead of hidden:

```ts
const ulume = await umi.uploader.getUploadPriceUlume(files); // bigint, in ulume
const quote = await umi.uploader.estimate([1024, 2048]);     // per-size breakdown
```

Both call the gateway's public `GET /estimate`, which tracks the chain's live
fee params (governance can change them).

## Development

```sh
npm install
npm run build   # tsc -> dist/
npm test        # vitest, fully mocked — no network, no chain
```
