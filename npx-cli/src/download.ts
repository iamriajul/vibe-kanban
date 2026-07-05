import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

export const BINARY_TAG = require('../package.json').version as string;
export const CACHE_DIR = path.join(os.homedir(), '.vibe-kanban', 'bin');
const requireFromHere = createRequire(__filename);
const OPTIONAL_BINARY_PACKAGES: Record<string, string> = {
  'linux-x64': 'vibe-kanban-team-linux-x64',
  'macos-arm64': 'vibe-kanban-team-macos-arm64',
};

// Local development mode: use binaries from npx-cli/dist/
// Only activate if dist/ exists (i.e., running from source after local-build.sh)
export const LOCAL_DIST_DIR = path.join(__dirname, '..', 'dist');
export const LOCAL_DEV_MODE =
  fs.existsSync(LOCAL_DIST_DIR) ||
  process.env.VIBE_KANBAN_LOCAL === '1';

export interface DesktopBundleInfo {
  archivePath: string | null;
  dir: string;
  type: string | null;
}

type ProgressCallback = (downloaded: number, total: number) => void;

function resolveVendoredBinaryZip(
  platform: string,
  binaryName: string
): string | null {
  const packageName = OPTIONAL_BINARY_PACKAGES[platform];
  if (!packageName) return null;

  try {
    const packageJsonPath = requireFromHere.resolve(
      `${packageName}/package.json`
    );
    const packageRoot = path.dirname(packageJsonPath);
    const zipPath = path.join(
      packageRoot,
      'dist',
      platform,
      `${binaryName}.zip`
    );
    return fs.existsSync(zipPath) ? zipPath : null;
  } catch {
    return null;
  }
}

export async function ensureBinary(
  platform: string,
  binaryName: string,
  _onProgress?: ProgressCallback
): Promise<string> {
  // In local dev mode, use binaries directly from npx-cli/dist/
  if (LOCAL_DEV_MODE) {
    const localZipPath = path.join(
      LOCAL_DIST_DIR,
      platform,
      `${binaryName}.zip`
    );
    if (fs.existsSync(localZipPath)) {
      return localZipPath;
    }
    throw new Error(
      `Local binary not found: ${localZipPath}\n` +
        `Run ./local-build.sh first to build the binaries.`
    );
  }

  const vendoredZipPath = resolveVendoredBinaryZip(
    platform,
    binaryName
  );
  if (vendoredZipPath) {
    return vendoredZipPath;
  }

  throw new Error(
    `Binary ${binaryName} not available for ${platform}. ` +
      `Install the npm package with optional dependencies enabled.`
  );
}

export const DESKTOP_CACHE_DIR = path.join(
  os.homedir(),
  '.vibe-kanban',
  'desktop'
);

export async function ensureDesktopBundle(
  tauriPlatform: string,
  _onProgress?: ProgressCallback
): Promise<DesktopBundleInfo> {
  // In local dev mode, use Tauri bundle from npx-cli/dist/tauri/<platform>/
  if (LOCAL_DEV_MODE) {
    const localDir = path.join(LOCAL_DIST_DIR, 'tauri', tauriPlatform);
    if (fs.existsSync(localDir)) {
      const files = fs.readdirSync(localDir);
      const archive = files.find(
        (f) => f.endsWith('.tar.gz') || f.endsWith('-setup.exe')
      );
      return {
        dir: localDir,
        archivePath: archive ? path.join(localDir, archive) : null,
        type: null,
      };
    }
    throw new Error(
      `Local desktop bundle not found: ${localDir}\n` +
        `Run './local-build.sh --desktop' first to build the Tauri app.`
    );
  }

  throw new Error(
    `Desktop app is not available from the npm package for ${tauriPlatform}.`
  );
}
