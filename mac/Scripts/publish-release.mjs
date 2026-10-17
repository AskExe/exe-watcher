import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = 'AskExe/exe-watcher';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = join(root, 'mac/.build/dist');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options });

export function releaseNames(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('A stable release version is required.');
  return [`Watcher-v${version}-universal.dmg`, `ExeWatcherMenubar-v${version}.zip`, 'SHA256SUMS.txt', 'BUILD-INFO.txt'];
}

export function verifyRelease(release, version, sourceTree, buildInfo) {
  const names = releaseNames(version);
  if (release.tag_name !== `mac-v${version}` || release.draft || release.prerelease) throw Error('The matching public stable Mac release is required.');
  for (const name of names) {
    const matches = release.assets.filter(asset => asset.name === name);
    if (matches.length !== 1 || matches[0].size <= 0) throw Error(`Missing or ambiguous release asset: ${name}`);
  }
  if (!buildInfo.startsWith(`Watcher ${version}\n`) || !buildInfo.includes(`Source tree: ${sourceTree}\n`)
    || !buildInfo.includes('Modified tracked files: 0\n') || !buildInfo.includes('Notarization: accepted and stapled\n')) {
    throw Error('Mac artifacts must be notarized and built from the same clean source tree as npm.');
  }
}

export function releaseMetadata(tag, invoke = run) {
  const options = { stdio: ['ignore', 'pipe', 'pipe'] };
  try { return JSON.parse(invoke('gh', ['api', `repos/${repository}/releases/tags/${tag}`], options)); }
  catch (error) {
    if (!String(error.stderr).includes('HTTP 404')) throw Error('Could not read GitHub release metadata. Check gh authentication/network access.');
    // The tag endpoint exposes published releases. Include authenticated drafts
    // so a new upload can be verified and interrupted uploads cannot be replaced.
    const pages = JSON.parse(invoke('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases`],
      { ...options, maxBuffer: 32 * 1024 * 1024 }));
    const matches = pages.flat().filter(release => release.tag_name === tag);
    if (matches.length > 1) throw Error('Multiple releases use this tag. Inspect them before publishing.');
    return matches[0] ?? null;
  }
}

function downloadBuildInfo(asset) {
  return run('gh', ['api', `repos/${repository}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream'], { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const tag = `mac-v${version}`;
  const names = releaseNames(version);
  if (run('git', ['status', '--porcelain']).trim()) throw Error('Commit and merge the tested release source before publishing.');
  const source = run('git', ['rev-parse', 'HEAD']).trim();
  const tree = run('git', ['rev-parse', 'HEAD^{tree}']).trim();
  const trustedMain = run('gh', ['api', `repos/${repository}/commits/main`, '--jq', '.sha']).trim();
  if (source !== trustedMain) throw Error('Publish from the actual merged main commit.');
  const runs = JSON.parse(run('gh', ['run', 'list', '--repo', repository, '--workflow', 'ci.yml', '--commit', source,
    '--limit', '5', '--json', 'status,conclusion']));
  if (!runs.some(job => job.status === 'completed' && job.conclusion === 'success')) throw Error('Wait for successful CI on merged main before publishing.');
  const existing = releaseMetadata(tag);
  if (existing && !existing.draft) {
    const info = existing.assets.find(asset => asset.name === 'BUILD-INFO.txt');
    if (!info) throw Error('The published Mac release has no provenance receipt.');
    verifyRelease(existing, version, tree, downloadBuildInfo(info));
    console.log(`Verified paired Mac release ${version}; npm publication can proceed.`);
    return;
  }
  if (existing) throw Error('A draft already exists. Inspect/recover it rather than replacing its assets.');
  if (process.platform !== 'darwin') throw Error('The paired notarized Mac release must be prepared on the release Mac.');
  let ready = false;
  if (names.every(name => existsSync(join(output, name)))) {
    try {
      verifyRelease({ tag_name: tag, assets: names.map(name => ({ name, size: 1 })) }, version, tree,
        readFileSync(join(output, 'BUILD-INFO.txt'), 'utf8'));
      run('shasum', ['-a', '256', '-c', 'SHA256SUMS.txt'], { cwd: output, stdio: 'inherit' });
      ready = true;
    } catch { ready = false; }
  }
  if (!ready) {
    if (!process.env.CODESIGN_IDENTITY || !process.env.NOTARY_PROFILE) throw Error('Set CODESIGN_IDENTITY and NOTARY_PROFILE to prepare the paired Mac release.');
    run('bash', ['mac/Scripts/package-app.sh', `v${version}`], {
      env: { ...process.env, REQUIRE_NOTARIZATION: '1' }, stdio: 'inherit',
    });
  }
  const app = join(output, 'Watcher by EXE.app');
  run('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  run('xcrun', ['stapler', 'validate', app], { stdio: 'inherit' });
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app], { stdio: 'inherit' });
  run('xcrun', ['stapler', 'validate', join(output, names[0])], { stdio: 'inherit' });
  const buildInfo = readFileSync(join(output, 'BUILD-INFO.txt'), 'utf8');
  verifyRelease({ tag_name: tag, assets: names.map(name => ({ name, size: 1 })) }, version, tree, buildInfo);
  const notes = `Watcher ${version} includes the floating quota display, all-agent You + AI and AI Time totals, and retained All Time timing across restarts.\n\nDownload the universal DMG for macOS 14+. The app is Developer ID signed and Apple notarized, and includes its matching CLI. Existing users can select Update in Watcher. Terminal users can run npm install -g exe-watcher@latest --registry=https://registry.npmjs.org.\n\nIncludes CodeBurn by AgentSeal (MIT); full notices ship in the app and npm package.`;
  run('gh', ['release', 'create', tag, '--repo', repository, '--target', source, '--draft', '--title', `Watcher ${version}`,
    '--notes', notes, ...names.map(name => join(output, name))], { stdio: 'inherit' });
  const draft = releaseMetadata(tag);
  for (const name of names) {
    const asset = draft.assets.find(item => item.name === name);
    const hash = createHash('sha256').update(readFileSync(join(output, name))).digest('hex');
    if (asset?.digest !== `sha256:${hash}`) throw Error(`Uploaded asset digest mismatch: ${name}`);
  }
  run('gh', ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest'], { stdio: 'inherit' });
  const published = releaseMetadata(tag);
  verifyRelease(published, version, tree, downloadBuildInfo(published.assets.find(asset => asset.name === 'BUILD-INFO.txt')));
  console.log(`Published paired Mac release ${version}; npm publication can proceed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
