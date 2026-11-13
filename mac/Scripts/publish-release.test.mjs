import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBuildInfo, verifyMetadata } from './publish-release.mjs';

const version = '0.2.76', revision = 'a'.repeat(40), tree = 'b'.repeat(40);
const info = 'Watcher ' + version + '\nSource base revision: ' + revision + '\nSource tree: ' + tree +
  '\nModified tracked files: 0\nUntracked files: 0\nNotarization: accepted and stapled\nArchitectures: arm64 x86_64\n';

test('publication requires the notarized universal app from the exact clean revision', () => {
  assert.doesNotThrow(() => verifyBuildInfo(info, version, revision, tree));
  for (const altered of [info.replace(revision, 'c'.repeat(40)), info.replace(tree, 'other'),
    info.replace('Untracked files: 0', 'Untracked files: 1'), info.replace('accepted and stapled', 'not performed'),
    info.replace('arm64 x86_64', 'arm64'), info.replace(version, '0.2.75')]) {
    assert.throws(() => verifyBuildInfo(altered, version, revision, tree));
  }
});

test('the public release must identify the same bytes, signature and source', () => {
  const expected = { version, revision, tree, sha256: 'd'.repeat(64), size: 123, edSignature: 'fixture' };
  assert.doesNotThrow(() => verifyMetadata(expected, expected));
  for (const key of Object.keys(expected)) {
    assert.throws(() => verifyMetadata({ ...expected, [key]: null }, expected));
  }
});
