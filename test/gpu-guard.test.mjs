import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDisableReasons } from '../dist/main/gpu-guard.js';

/**
 * `detectDisableReasons(env, platform, read)` is a pure function of its
 * inputs, so these tests inject synthetic host signals without touching the
 * real process env or fs.
 */

const noRead = () => '';
const emptyEnv = {};

test('no signal on a real desktop (linux, no VM marks) → no reasons', () => {
  const reasons = detectDisableReasons(emptyEnv, 'linux', noRead);
  assert.deepEqual(reasons, []);
});

test('NEXUS_DISABLE_GPU=1 forces a reason on any platform', () => {
  const reasons = detectDisableReasons({ NEXUS_DISABLE_GPU: '1' }, 'win32', noRead);
  assert.deepEqual(reasons, ['env:NEXUS_DISABLE_GPU']);
});

test('VM guest env var (linux) is detected', () => {
  const reasons = detectDisableReasons({ VBOX_SVGA: '1' }, 'linux', noRead);
  assert.ok(reasons.includes('env:vm-guest'));
});

test('DMI sys_vendor (QEMU) is detected on linux', () => {
  const read = (p) => (p === '/sys/class/dmi/id/sys_vendor' ? 'QEMU' : '');
  const reasons = detectDisableReasons(emptyEnv, 'linux', read);
  assert.ok(reasons.includes('dmi:virtual-machine'));
});

test('cloud DMI vendor (Alibaba) is detected on linux', () => {
  const read = (p) =>
    p === '/sys/class/dmi/id/sys_vendor' ? 'Alibaba Cloud' : '';
  const reasons = detectDisableReasons(emptyEnv, 'linux', read);
  assert.ok(reasons.includes('dmi:virtual-machine'));
});

test('a real (non-VM) DMI vendor does NOT trigger detection', () => {
  const read = (p) =>
    p === '/sys/class/dmi/id/sys_vendor' ? 'Dell Inc.' : '';
  const reasons = detectDisableReasons(emptyEnv, 'linux', read);
  assert.deepEqual(reasons, []);
});

test('/proc/cpuinfo model name (KVM) is detected on linux', () => {
  const read = (p) =>
    p === '/proc/cpuinfo'
      ? 'processor\t: 0\nmodel name\t: QEMU Virtual CPU version 2.5+'
      : '';
  const reasons = detectDisableReasons(emptyEnv, 'linux', read);
  assert.ok(reasons.includes('cpuinfo:virtual-machine'));
});

test('a real CPU model name does NOT trigger detection', () => {
  const read = (p) =>
    p === '/proc/cpuinfo'
      ? 'model name\t: Intel(R) Core(TM) i7-12700'
      : p === '/sys/class/dmi/id/sys_vendor'
        ? 'Dell Inc.'
        : '';
  const reasons = detectDisableReasons(emptyEnv, 'linux', read);
  assert.deepEqual(reasons, []);
});

test('DMI/cpuinfo probing is linux-only: win32 host never reads DMI', () => {
  let readCalled = false;
  const read = () => {
    readCalled = true;
    return '';
  };
  const reasons = detectDisableReasons(emptyEnv, 'win32', read);
  assert.deepEqual(reasons, []);
  assert.equal(readCalled, false, 'non-linux platform must not probe DMI/cpuinfo');
});
