import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthNavigation } from '../src/lib/authNavigation.ts';

for (const mode of ['server', 'local']) {
  test(`desktop ${mode} sign-out returns to native chooser without web navigation`, async () => {
    const calls: string[] = [];
    const nav = createAuthNavigation({ nativeSignOut: () => async () => { calls.push('chooser'); },
      revokeWebSession: async () => { calls.push('web logout'); }, showWebLogin: () => calls.push('web login') });
    await nav.signOut();
    assert.deepEqual(calls, ['chooser']);
  });
}

test('browser sign-out revokes its cookie then returns to the browser login', async () => {
  const calls: string[] = [];
  const nav = createAuthNavigation({nativeSignOut: () => null, revokeWebSession: async () => { calls.push('logout'); }, showWebLogin: () => calls.push('login')});
  await nav.signOut();assert.deepEqual(calls, ['logout', 'login']);
});

test('unauthorized browser requests navigate without another logout request', async () => {
  const calls: string[] = [];
  const nav = createAuthNavigation({nativeSignOut: () => null, revokeWebSession: async () => { calls.push('logout'); }, showWebLogin: () => calls.push('login')});
  await nav.authenticationRequired();assert.deepEqual(calls, ['login']);
});

test('an explicit sign-out and simultaneous expired requests share one desktop transition', async () => {
  let count = 0, finish!: () => void;
  const done = new Promise<void>(r => { finish = r; });
  const nav = createAuthNavigation({nativeSignOut: () => async () => { count++;await done; }, revokeWebSession: async () => assert.fail(), showWebLogin: () => assert.fail()});
  const first = nav.signOut(), second = nav.authenticationRequired();
  assert.equal(first, second);await Promise.resolve();assert.equal(count, 1);finish();await first;
});

test('native IPC failure does not trap the app on a web login and can be retried', async () => {
  let fail = true, count = 0;
  const nav = createAuthNavigation({nativeSignOut: () => async () => { count++;if(fail)throw Error('IPC failed'); }, revokeWebSession: async () => assert.fail(), showWebLogin: () => assert.fail()});
  await assert.rejects(nav.signOut(), /IPC failed/);fail = false;await nav.signOut();assert.equal(count, 2);
});
