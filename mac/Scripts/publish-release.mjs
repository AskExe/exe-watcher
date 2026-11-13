import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'mac/.build/dist');
const sparkle = join(root, 'mac/.build/artifacts/sparkle/Sparkle/bin');
const bucket = 'exe-releases/watcher';
const origin = 'https://version.askexe.com/watcher/';
const publicFeed = 'https://odd.community/watcher/appcast.xml';
const signingRequirement = '=anchor apple generic and certificate leaf[subject.OU] = "ZNU2X48VW5" and identifier "com.askexe.exe-watcher-menubar"';
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options });

export function verifyBuildInfo(info, version, revision, tree) {
  const lines = info.trimEnd().split('\n');
  const required = [
    'Watcher ' + version, 'Source base revision: ' + revision, 'Source tree: ' + tree,
    'Modified tracked files: 0', 'Untracked files: 0', 'Notarization: accepted and stapled',
    'Architectures: arm64 x86_64',
  ];
  if (lines[0] !== required[0] || required.some(line => !lines.includes(line))) {
    throw Error('The notarized Mac release must match the clean merged source and package version.');
  }
}

export function verifyMetadata(metadata, expected) {
  for (const key of ['version', 'sha256', 'size', 'edSignature', 'revision', 'tree']) {
    if (metadata?.[key] !== expected[key]) throw Error('Release metadata mismatch: ' + key);
  }
}

async function get(path, optional = false) {
  const response = await fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (response.status === 404 && optional) return null;
  if (!response.ok) throw Error('Odd release storage returned HTTP ' + response.status + ' for ' + path);
  return response;
}

async function digest(body) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > 256 * 1024 * 1024) throw Error('Watcher image exceeds its size limit.');
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), size };
}

function put(path, file, contentType, cache) {
  run('wrangler', ['r2', 'object', 'put', bucket + '/' + path, '--remote', '--file', file,
    '--content-type', contentType, '--cache-control', cache], { stdio: 'inherit' });
}

async function main() {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('A stable version is required.');
  if (run('git', ['status', '--porcelain']).trim()) throw Error('Publish from a clean merged main checkout.');
  const revision = run('git', ['rev-parse', 'HEAD']).trim();
  const tree = run('git', ['rev-parse', 'HEAD^{tree}']).trim();
  const repo = 'AskExe/exe-watcher';
  if (revision !== run('gh', ['api', 'repos/' + repo + '/commits/main', '--jq', '.sha']).trim()) {
    throw Error('Publish from the actual merged main commit.');
  }
  const runs = JSON.parse(run('gh', ['run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--commit', revision,
    '--limit', '5', '--json', 'status,conclusion']));
  if (!runs.some(item => item.status === 'completed' && item.conclusion === 'success')) {
    throw Error('Wait for successful CI on merged main before publishing.');
  }

  const imageName = 'Watcher-v' + version + '-universal.dmg';
  const imagePath = join(output, imageName);
  const app = join(output, 'Watcher by EXE.app');
  const versionedMetadataPath = version + '/release.json';
  if (process.argv.includes('--verify-published')) {
    const [result, file] = await Promise.all([get(versionedMetadataPath), get(version + '/' + imageName)]);
    const metadata = await result.json();
    const observed = await digest(file.body);
    if (!/^[A-Za-z0-9+/]{86}==$/.test(metadata?.edSignature ?? '')) throw Error('Missing Sparkle signature.');
    verifyMetadata(metadata, { version, revision, tree, ...observed, edSignature: metadata.edSignature });
    const latest = await (await get('release.json')).json();
    verifyMetadata(latest, metadata);
    const publicRelease = await fetch('https://odd.community/watcher/release', { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!publicRelease.ok) throw Error('Odd Community has not made the release public.');
    const publicMetadata = await publicRelease.json();
    const feed = await fetch(publicFeed, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const expectedImageURL = origin + version + '/' + imageName;
    if (publicMetadata.version !== version || publicMetadata.download !== expectedImageURL ||
        publicMetadata.sha256 !== metadata.sha256 || publicMetadata.size !== metadata.size ||
        publicMetadata.edSignature !== metadata.edSignature || !feed.ok) {
      throw Error('Public download and npm source do not identify the same release.');
    }
    const appcast = await feed.text();
    if (!appcast.includes('<sparkle:version>' + version + '</sparkle:version>') ||
        !appcast.includes('url="' + expectedImageURL + '" length="' + metadata.size + '"') ||
        !appcast.includes('sparkle:edSignature="' + metadata.edSignature + '"')) {
      throw Error('The public appcast does not identify the verified Mac release.');
    }
    console.log('Verified the paired Odd Mac release ' + version);
    return;
  }

  verifyBuildInfo(readFileSync(join(output, 'BUILD-INFO.txt'), 'utf8'), version, revision, tree);
  run('codesign', ['--verify', '--deep', '--strict', '--all-architectures', '-R', signingRequirement, app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('spctl', ['--assess', '--type', 'execute', app]);
  run('codesign', ['--verify', '--strict', imagePath]);
  run('xcrun', ['stapler', 'validate', imagePath]);
  const plist = join(app, 'Contents/Info.plist');
  const plistValue = name => run('/usr/libexec/PlistBuddy', ['-c', 'Print :' + name, plist]).trim();
  if (plistValue('CFBundleShortVersionString') !== version || plistValue('SUFeedURL') !== publicFeed ||
      plistValue('SUVerifyUpdateBeforeExtraction') !== 'true') throw Error('The app has the wrong updater configuration.');
  const publicKey = run(join(sparkle, 'generate_keys'), ['--account', 'watcher-updates', '-p']).trim();
  if (publicKey !== plistValue('SUPublicEDKey')) throw Error('The Sparkle key does not match the packaged app.');
  if (statSync(imagePath).size > 256 * 1024 * 1024) throw Error('Watcher image exceeds its size limit.');
  const edSignature = run(join(sparkle, 'sign_update'), ['--account', 'watcher-updates', '-p', imagePath]).trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(edSignature)) throw Error('Sparkle did not sign the DMG.');
  const metadata = { version, revision, tree, ...(await digest(createReadStream(imagePath))), edSignature };

  const scratch = mkdtempSync(join(tmpdir(), 'watcher-publication-'));
  try {
    const metadataFile = join(scratch, 'release.json');
    writeFileSync(metadataFile, JSON.stringify(metadata) + '\n', { mode: 0o600 });
    const imageKey = version + '/' + imageName;
    if (!(await get(imageKey, true))) {
      put(imageKey, imagePath, 'application/x-apple-diskimage', 'public, max-age=31536000, immutable');
    }
    const observed = await digest((await get(imageKey)).body);
    if (observed.sha256 !== metadata.sha256 || observed.size !== metadata.size) {
      throw Error('The versioned DMG already exists with different bytes or failed readback.');
    }
    const existing = await get(versionedMetadataPath, true);
    if (existing) verifyMetadata(await existing.json(), metadata);
    else put(versionedMetadataPath, metadataFile, 'application/json', 'public, max-age=31536000, immutable');
    verifyMetadata(await (await get(versionedMetadataPath)).json(), metadata);
    if (process.argv.includes('--stage')) {
      console.log('Verified the immutable Odd release assets for ' + version);
      return;
    }
    const latest = await get('release.json', true);
    if (latest) {
      const current = await latest.json();
      if (current.version === version) {
        verifyMetadata(current, metadata);
        console.log('Odd release ' + version + ' is already current.');
        return;
      }
      if (typeof current.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(current.version) ||
          current.version.localeCompare(version, 'en', { numeric: true }) > 0) {
        throw Error('Refusing to replace an invalid or newer update pointer.');
      }
    }
    put('release.json', metadataFile, 'application/json', 'no-cache');
    verifyMetadata(await (await get('release.json')).json(), metadata);
    console.log('Published Odd update pointer for ' + version);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
