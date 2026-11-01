// =============================================================================
// plugins/common-layer.js — builds layers/common/nodejs before packaging.
//
// Why a custom plugin? npm installs native modules (notably Sharp) for the
// developer's OS by default. Lambda runs Linux ARM64, so installing on Windows
// would put the wrong binaries in the layer. This hook runs:
//
//   npm ci --omit=dev --os=linux --cpu=arm64 --libc=glibc
//
// Serverless lifecycle hook: 'before:package:initialize' runs once before the
// bundle is zipped. A hash of package-lock.json + target platform is stored in
// .install-fingerprint, so repeated packaging reuses an unchanged layer.
// =============================================================================
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

// Install the common layer for Lambda's OS/architecture, never for the developer's host OS.
class CommonLayerPlugin {
  constructor(serverless) {
    this.serverless = serverless;
    this.hooks = {
      'before:package:initialize': this.install.bind(this),
    };
  }

  install() {
    const directory = join(this.serverless.config.serviceDir, 'layers/common/nodejs');
    const lockPath = join(directory, 'package-lock.json');
    const markerPath = join(directory, '.install-fingerprint');
    const fingerprint = createHash('sha256')
      .update(readFileSync(lockPath))
      .update('linux-arm64-glibc-node24')
      .digest('hex');

    // Reuse an unchanged installation to keep repeated packaging fast and deterministic.
    if (existsSync(markerPath) && readFileSync(markerPath, 'utf8') === fingerprint) {
      this.serverless.cli.log('Common Lambda layer is up to date.');
      return;
    }

    const result = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['ci', '--omit=dev', '--os=linux', '--cpu=arm64', '--libc=glibc'],
      {
        cwd: directory,
        stdio: 'inherit',
        env: process.env,
        shell: process.platform === 'win32',
      },
    );
    if (result.error || result.status !== 0) {
      throw result.error || new Error(`Layer npm ci exited with status ${result.status}`);
    }
    writeFileSync(markerPath, fingerprint);
  }
}

module.exports = CommonLayerPlugin;
