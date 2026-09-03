/**
 * Updating in place, and the four times it must not.
 *
 * The dangerous half of this feature is not the download; it is a program
 * that overwrites its own folder. So every refusal is a test, and so is
 * every path an entry could take out of the destination.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { planUpdate, readZip, targetFor, unpackOver, PROTECTED } from '../src/update.ts';
import { parseVersion, readVersion, DEV } from '../src/version.ts';

// ── A zip, built by hand ─────────────────────────────────────────────────────
//
// Rather than shelling out to a zip tool that does not exist on Windows, the
// same place the real one has to run. Deflated, because git archive deflates.
function zipOf(files: { name: string; body: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.body, 'utf8');
    const deflated = deflateRawSync(raw);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, deflated);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + deflated.length;
  }
  const dirBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(dirBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBytes, eocd]);
}

const base = {
  own: 'aaaaaaa',
  hub: 'bbbbbbb',
  enabled: true,
  once: false,
  minutesToDrop: null as number | null,
};

test('A DEVELOPMENT CHECKOUT IS NEVER UPDATED', () => {
  // VERSION holds an unsubstituted $Format placeholder in a checkout. Unpacking
  // a zip over somebody's working tree would delete work that is not committed,
  // and there is no version of that which is acceptable.
  assert.equal(parseVersion('$Format:%h$'), DEV);
  assert.equal(planUpdate({ ...base, own: DEV }).update, false);
  assert.match(planUpdate({ ...base, own: DEV }).why, /development checkout/);
});

test('the version file is read as what it is', () => {
  assert.equal(parseVersion('1fd5043\n'), '1fd5043');
  assert.equal(parseVersion('1FD5043'), '1fd5043');
  assert.equal(parseVersion(''), 'unknown');
  assert.equal(parseVersion('who knows'), 'unknown');
  const dir = mkdtempSync(join(tmpdir(), 'ver-'));
  assert.equal(readVersion(dir), 'unknown', 'no file at all');
  writeFileSync(join(dir, 'VERSION'), '58a7ecb\n');
  assert.equal(readVersion(dir), '58a7ecb');
});

test('WHEN IT DECLINES, AND WHY', () => {
  assert.equal(planUpdate(base).update, true, 'the ordinary case');
  assert.match(planUpdate(base).why, /aaaaaaa → bbbbbbb/);

  assert.equal(planUpdate({ ...base, enabled: false }).update, false);
  assert.equal(planUpdate({ ...base, once: true }).update, false);
  assert.equal(planUpdate({ ...base, hub: null }).update, false);
  assert.equal(planUpdate({ ...base, hub: 'aaaaaaa' }).update, false, 'already current');
  assert.match(planUpdate({ ...base, hub: 'aaaaaaa' }).why, /already on aaaaaaa/);

  // The drop rule. Restarting inside the run-up cost a Walmart read on 3 Sep:
  // the first read after a fresh launch passes and the second is challenged.
  assert.equal(planUpdate({ ...base, minutesToDrop: 45 }).update, false);
  assert.match(planUpdate({ ...base, minutesToDrop: 45 }).why, /45m away/);
  assert.equal(planUpdate({ ...base, minutesToDrop: 90 }).update, false, 'the horizon itself is inside');
  assert.equal(planUpdate({ ...base, minutesToDrop: 91 }).update, true, 'and just outside it is fine');
});

test('AN ENTRY CANNOT ESCAPE THE FOLDER, OR OVERWRITE WHAT IS THE USER’S', () => {
  const dest = '/phantom';
  assert.equal(targetFor('Phantom/src/watch.ts', dest)?.rel, 'src/watch.ts');
  assert.equal(targetFor('Phantom/../../etc/passwd', dest), null, 'climbing out');
  assert.equal(targetFor('Phantom/', dest), null, 'the folder entry itself');
  assert.equal(targetFor('loose.txt', dest), null, 'no top-level folder to strip');

  // The zip contains none of these today. That is a property of a script in
  // another repository, and this is the rule.
  for (const name of [
    'watcher.config.json',
    'chrome-profile-buy/Default/Cookies',
    'logs/console-run.log',
    'probe-artifacts/target.json',
    'node_modules/x/index.js',
    '.env.local',
  ]) {
    assert.equal(targetFor(`Phantom/${name}`, dest), null, `${name} must survive an update`);
    assert.ok(PROTECTED.some((re) => re.test(name)));
  }
});

test('UNPACKING REPLACES THE PROGRAM AND LEAVES EVERYTHING ELSE ALONE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'src', 'watch.ts'), 'the old code');
  writeFileSync(join(dir, 'watcher.config.json'), '{"hub":{"token":"secret"}}');
  writeFileSync(join(dir, 'logs', 'console-run.log'), 'yesterday');

  const written = unpackOver(
    zipOf([
      { name: 'Phantom/package.json', body: '{"name":"phantom"}' },
      { name: 'Phantom/src/watch.ts', body: 'the new code' },
      { name: 'Phantom/src/brand/new.ts', body: 'a file that did not exist' },
      { name: 'Phantom/watcher.config.json', body: '{"hub":{"token":"THEIRS"}}' },
      { name: 'Phantom/logs/console-run.log', body: 'nonsense' },
    ]),
    dir,
  );

  assert.deepEqual(written.sort(), ['package.json', 'src/brand/new.ts', 'src/watch.ts']);
  assert.equal(readFileSync(join(dir, 'src', 'watch.ts'), 'utf8'), 'the new code');
  assert.ok(existsSync(resolve(dir, 'src', 'brand', 'new.ts')), 'new folders are made');
  assert.match(readFileSync(join(dir, 'watcher.config.json'), 'utf8'), /secret/, 'their config stands');
  assert.equal(readFileSync(join(dir, 'logs', 'console-run.log'), 'utf8'), 'yesterday');
});

test('a zip with no package.json is not Phantom and is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-'));
  assert.throws(
    () => unpackOver(zipOf([{ name: 'Phantom/README.md', body: 'hello' }]), dir),
    /no package\.json/,
  );
});

test('a truncated download is refused rather than half-written', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /no end-of-central-directory/);
});
