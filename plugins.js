const esbuildPluginTsc = require('esbuild-plugin-tsc');

// @nestjs/swagger v12+ is ESM-only and calls createRequire(import.meta.url) at
// module scope. esbuild bundles to CJS where import.meta.url is undefined, which
// crashes the Lambda on cold start. Rewrite the token to __filename, which is
// defined in the CJS bundle.
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
  esbuildPluginTsc(),
  importMetaUrlShim,
];