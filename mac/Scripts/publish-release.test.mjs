import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseNames, verifyRelease } from './publish-release.mjs';

const version = '0.2.66', tree = 'fixture-tree';
const receipt = `Watcher ${version}\nSource tree: ${tree}\nModified tracked files: 0\nNotarization: accepted and stapled\n`;
const release = () => ({ tag_name: `mac-v${version}`, assets: releaseNames(version).map(name => ({ name, size: 123 })) });
test('a clean notarized app must match the npm source tree and version', () => {
  assert.doesNotThrow(() => verifyRelease(release(), version, tree, receipt));
  for (const info of [receipt.replace(tree, 'old-tree'), receipt.replace('0\nNotarization', '1\nNotarization'),
    receipt.replace('accepted and stapled', 'not performed'), receipt.replace(version, '0.2.65')]) {
    assert.throws(() => verifyRelease(release(), version, tree, info));
  }
});
test('missing, duplicate, draft or crossed-version assets block npm publication', () => {
  for (const name of releaseNames(version)) {
    const value = release(); value.assets = value.assets.filter(asset => asset.name !== name);
    assert.throws(() => verifyRelease(value, version, tree, receipt));
  }
  for (const value of [{ ...release(), draft: true }, { ...release(), prerelease: true },
    { ...release(), tag_name: 'mac-v0.2.65' }, { ...release(), assets: [...release().assets, release().assets[0]] }]) {
    assert.throws(() => verifyRelease(value, version, tree, receipt));
  }
  assert.throws(() => releaseNames('../unsafe'));
});
