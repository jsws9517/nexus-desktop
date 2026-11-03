import type { App } from 'electron';
import { readFileSync } from 'node:fs';
import { logger } from '../shared/logger.js';

/**
 * Decide, at app startup (before `app.whenReady`), whether to run with GPU
 * hardware acceleration or fall back to software rendering, and apply the
 * choice to `app` accordingly.
 *
 * Why this module exists
 * ----------------------
 * On Linux, a VM / headless / software-GL desktop (very common for a
 * developer's remote box) makes Chromium's GPU process briefly fail to create
 * its command buffer, which Chromium's C++ layer logs straight to fd 2:
 *
 *   [PID:TID:HHMMSS.micro:ERROR:gpu/ipc/client/command_buffer_proxy_impl.cc:285]
 *   ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer.
 *
 * That line is written by Chromium's native logging to file descriptor 2, NOT
 * through Node's `process.stderr.write` wrapper — so a JS-level stderr patch
 * cannot intercept it. The only way to stop the notice from firing is to stop
 * creating the GPU command buffer in the first place, i.e. run with software
 * rendering (`app.disableHardwareAcceleration()`).
 *
 * Policy
 * ------
 *  - Linux only: auto-detect "no discrete GPU / running in a VM" from DMI
 *    sys_vendor, `/proc/cpuinfo`, and VM guest env vars. When detected,
 *    disable hardware acceleration automatically and log the reason(s).
 *  - Explicit overrides (any platform), which win over auto-detect:
 *      NEXUS_DISABLE_GPU=1  force software rendering (GPU off)
 *      NEXUS_FORCE_GPU=1    force hardware acceleration (GPU on)
 *  - Real desktop with a discrete GPU and no override: leave hardware
 *    acceleration on (best performance), log at debug level.
 *
 * Every detection read is best-effort and wrapped in try/catch: a missing
 * file, a read error, or an unreadable DMI path never blocks startup — it
 * just means "no signal, keep the default (HW accel on)".
 *
 * Must be called before `app.whenReady()`.
 */

/** Reasons that, when present, make us switch to software rendering. */
type GpuDisableReason =
  | 'env:NEXUS_DISABLE_GPU'
  | 'env:vm-guest'
  | 'dmi:virtual-machine'
  | 'cpuinfo:virtual-machine';

const VM_ENV_VARS = [
  'QEMU_AUDIO_DRV',
  'QEMU_GA_HEXDUMP',
  'VBOX_HOST',
  'VBOX_MF',
  'VBOX_PROBE',
  'VBOX_SVGA',
  'VMWARE_HOST',
  'VMWARE_OS',
  'LXC',
  'KUBERNETES_SERVICE_HOST',
] as const;

// Substrings that mark a DMI sys_vendor as a hypervisor / cloud vendor.
// Cloud vendors (Alibaba/Aliyun/Tencent/Huawei/Microsoft-Azure) ship VMs whose
// virtual GPU is exactly the one that trips the transient command-buffer
// failure, so they belong on the "software rendering" side.
const VM_DMI_VENDORS = [
  'qemu',
  'vmware',
  'virtualbox',
  'innotek', // VirtualBox's DMI vendor string
  'microsoft', // Hyper-V / Azure
  'alibaba',
  'aliyun',
  'tencent',
  'huawei',
  'xen',
] as const;

// Substrings that mark a /proc/cpuinfo model name as a virtual CPU.
const VM_CPU_NAMES = [
  'qemu',
  'kvm',
  'virtualbox',
  'vmware',
  'droplet', // DigitalOcean
  'ranchu', // Android emulator
] as const;

function readTrimmed(p: string): string {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Collect the GpuDisableReasons that apply on this host. Pure function of the
 * inputs it is handed so the detection can be unit-tested without touching
 * the real process env / fs. The default caller ({@link detectHostReasons})
 * feeds it the real host values.
 */
export function detectDisableReasons(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  read = readTrimmed,
): GpuDisableReason[] {
  const reasons: GpuDisableReason[] = [];

  // Explicit force-off override — honored on every platform.
  if (env.NEXUS_DISABLE_GPU === '1') reasons.push('env:NEXUS_DISABLE_GPU');

  // Linux-only DMI + cpuinfo probing (these paths don't exist on win/mac and
  // the GPU transient notice is a Linux/VM artifact anyway).
  if (platform === 'linux') {
    // VM guest env vars (set by the hypervisor / container runtime).
    for (const v of VM_ENV_VARS) {
      if (env[v]) {
        reasons.push('env:vm-guest');
        break;
      }
    }
    // DMI system vendor (the machine's BIOS-reported maker).
    const sysVendor = read('/sys/class/dmi/id/sys_vendor').toLowerCase();
    if (sysVendor && VM_DMI_VENDORS.some((s) => sysVendor.includes(s))) {
      reasons.push('dmi:virtual-machine');
    }
    // Virtual CPU model names (a VM's /proc/cpuinfo advertises the hypervisor).
    if (!reasons.includes('cpuinfo:virtual-machine')) {
      const cpuinfo = read('/proc/cpuinfo');
      const modelNames = cpuinfo
        .split('\n')
        .filter((l) => l.startsWith('model name'))
        .join(' ')
        .toLowerCase();
      if (modelNames && VM_CPU_NAMES.some((s) => modelNames.includes(s))) {
        reasons.push('cpuinfo:virtual-machine');
      }
    }
  }

  return reasons;
}

/** Convenience wrapper that probes the real host. */
function detectHostReasons(): GpuDisableReason[] {
  return detectDisableReasons(process.env, process.platform);
}

/**
 * Configure `app`'s hardware-acceleration policy for this environment and log
 * the decision. Safe to call once, before `app.whenReady()`.
 */
export function configureGpuForEnvironment(app: App): void {
  const forceOn = process.env.NEXUS_FORCE_GPU === '1';
  const reasons = detectHostReasons();

  // An explicit force-ON override always wins: a VM user who has passed
  // through a discrete GPU wants hardware acceleration even though the box is
  // otherwise VM-detected.
  if (forceOn) {
    logger.info('NEXUS_FORCE_GPU=1 — keeping hardware acceleration on despite any VM detection');
    return;
  }

  if (reasons.length > 0) {
    app.disableHardwareAcceleration();
    logger.info(
      `GPU: software rendering enabled (hardware acceleration disabled). ` +
        `Reasons: ${reasons.join(', ')}. ` +
        `This suppresses the non-fatal Chromium notice ` +
        `'ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer' ` +
        `that a VM / headless / software-GL desktop triggers. Set NEXUS_FORCE_GPU=1 to override.`,
    );
    return;
  }

  // No disable signal: a real desktop (discrete GPU expected). Leave hardware
  // acceleration at its default (on). Debug only so it never clutters logs.
  logger.debug('GPU: no VM/no-GPU signal detected — keeping hardware acceleration on');
}
