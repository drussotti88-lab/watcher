/**
 * One Phantom at a time.
 *
 * Written after two instances ran for five minutes on 1 Sep 2026 and fought
 * over the Chrome profile — nine "that profile is already open" failures, and
 * a Pokémon Center stand-down that kept resetting because the two of them held
 * separate pacers. The second one is the quiet damage: a retailer that told us
 * to go away was still being knocked on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { takeLock, releaseLock, heldMessage, type LockDeps } from '../src/lock.ts';

function fake(over: Partial<LockDeps> & { file?: string | null } = {}): LockDeps & {
  file: string | null;
  removed: boolean;
} {
  const state = {
    file: over.file ?? null,
    removed: false,
    pid: over.pid ?? 100,
    alive: over.alive ?? (() => false),
    read() {
      return state.file;
    },
    write(text: string) {
      state.file = text;
    },
    remove() {
      state.file = null;
      state.removed = true;
    },
  };
  return state as LockDeps & { file: string | null; removed: boolean };
}

test('the first Phantom takes the lock and writes its pid', () => {
  const d = fake({ pid: 4242 });
  assert.deepEqual(takeLock(d), { ok: true });
  assert.match(d.file!, /^4242\n/);
});

test('A SECOND PHANTOM IS REFUSED WHILE THE FIRST IS ALIVE', () => {
  // The whole point. Two of them share a Chrome profile and share nothing
  // else — separate pacers, so a stand-down one of them honoured is undone by
  // the other.
  const d = fake({ file: '4242\n2026-09-01T18:00:00Z\n', pid: 9999, alive: (p) => p === 4242 });
  assert.deepEqual(takeLock(d), { ok: false, heldBy: 4242 });
  assert.equal(d.file, '4242\n2026-09-01T18:00:00Z\n', 'and the holder\'s lock is untouched');
});

test('a lock left by a process that is gone is taken over without ceremony', () => {
  // A hard kill, a power cut, a crash. Refusing to start because of a file
  // left by something that died last week is what makes people delete the
  // lock and stop thinking about it.
  const d = fake({ file: '4242\n', pid: 9999, alive: () => false });
  assert.deepEqual(takeLock(d), { ok: true });
  assert.match(d.file!, /^9999\n/);
});

test('our own pid in the file is not a conflict with ourselves', () => {
  const d = fake({ file: '4242\n', pid: 4242, alive: () => true });
  assert.deepEqual(takeLock(d), { ok: true });
});

test('a lock file full of nonsense does not wedge the machine shut', () => {
  const d = fake({ file: 'who knows\n', pid: 7, alive: () => true });
  assert.deepEqual(takeLock(d), { ok: true });
  assert.match(d.file!, /^7\n/);
});

test('releasing takes our own lock away', () => {
  const d = fake({ pid: 4242 });
  takeLock(d);
  releaseLock(d);
  assert.equal(d.file, null);
});

test('A LOSER MUST NOT DELETE THE WINNER\'S LOCK ON ITS WAY OUT', () => {
  // The refused instance still runs its shutdown path. If that removed the
  // file, one bad launch would leave the system permanently unlocked — worse
  // than the problem, and invisible until it happened again.
  const d = fake({ file: '4242\n', pid: 9999, alive: (p) => p === 4242 });
  takeLock(d);
  releaseLock(d);
  assert.equal(d.file, '4242\n', 'still the winner\'s');
  assert.equal(d.removed, false);
});

test('releasing when there is no lock is quiet, not an error', () => {
  const d = fake({ pid: 1 });
  releaseLock(d);
  assert.equal(d.file, null);
});

test('the refusal says how to get out of it', () => {
  // A lock you cannot clear is a lock people work around with Task Manager.
  const msg = heldMessage(4242, 'logs/.running');
  assert.match(msg, /4242/);
  assert.match(msg, /npm run stop/);
  assert.match(msg, /logs\/\.running/);
});
