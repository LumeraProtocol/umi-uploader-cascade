import type { UmiPlugin } from '@metaplex-foundation/umi';
import {
  createCascadeUploader,
  CascadeUploaderOptions,
} from './createCascadeUploader.js';

export const cascadeUploader = (
  options?: CascadeUploaderOptions
): UmiPlugin => ({
  install(umi) {
    umi.uploader = createCascadeUploader(umi, options);
  },
});
