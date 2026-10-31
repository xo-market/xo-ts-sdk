import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/signing/index.ts'],
  format: ['esm', 'cjs'],
  // `@internal` members stay out of the published declarations.
  dts: { compilerOptions: { stripInternal: true } },
  // Emit .js/.d.ts for ESM (package.json has "type": "module") and .cjs/.d.cts for CJS.
  fixedExtension: false,
});
