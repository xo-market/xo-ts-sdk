import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts', 'src/signing/index.ts', 'src/viem.ts'],
  format: ['esm', 'cjs'],
  // `@internal` members (the producer side of `Subscription`, `stopHeartbeat`) stay out of the
  // published declarations.
  dts: { compilerOptions: { stripInternal: true } },
  // Emit .js/.d.ts for ESM (package.json has "type": "module") and .cjs/.d.cts for CJS.
  fixedExtension: false,
});
