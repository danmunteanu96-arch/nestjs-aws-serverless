// =============================================================================
// plugins.js — esbuild plugins shared by every function bundle.
//
// 1. esbuildPluginTsc: runs TypeScript's transpiler on files with decorators so
//    NestJS's emitDecoratorMetadata works (esbuild alone does not emit it).
//    forceEsm makes those files emit ESM imports, matching format: esm.
// 2. importMetaUrlShim: fallback only for a CommonJS build. The current build
//    is ESM, where import.meta.url is valid; NestJS is externalized and never
//    passes through this plugin. It stays here so a CJS fallback can re-enable it.
// =============================================================================
const esbuildPluginTsc = require('esbuild-plugin-tsc');

// Only needed if the deployment falls back to a CommonJS bundle: in CJS output
// import.meta.url is undefined, so @nestjs/swagger's createRequire call fails.
const importMetaUrlShim = {
  name: 'import-meta-url-shim',
  setup(build) {
    build.onLoad({ filter: /node_modules[\\/]@nestjs[\\/].*\.js$/ }, async (args) => {
      const fs = require('node:fs/promises');
      const contents = await fs.readFile(args.path, 'utf8');
      if (!contents.includes('import.meta.url')) {
        return null;
      }
      return {
        contents: contents.replaceAll('import.meta.url', '__filename'),
        loader: 'js',
      };
    });
  },
};

module.exports = [
  // forceEsm makes tsc treat decorated files as .mts, so externalized packages
  // become ESM `import` statements instead of CommonJS `require()` calls.
  esbuildPluginTsc({ forceEsm: true }),
  // importMetaUrlShim, // enable only if this project switches back to CJS output
];