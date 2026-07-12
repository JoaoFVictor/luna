import { readFile } from "node:fs/promises";

export type LinuxProcProcessIdentity = {
  source: "linux_proc";
  boot_id: string;
  start_time_ticks: string;
};

type ProcessInspection = {
  live: boolean;
  identity?: LinuxProcProcessIdentity;
};

const LINUX_BOOT_ID_PATTERN = /^[a-f0-9-]{8,128}$/iu;
const LINUX_START_TIME_PATTERN = /^[0-9]{1,32}$/u;

function isErrno(cause: unknown, code: string): boolean {
  return (cause as NodeJS.ErrnoException).code === code;
}

function isProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !isErrno(cause, "ESRCH");
  }
}

function parseLinuxProcStat(
  pid: number,
  content: string,
  bootId: string
): { identity: LinuxProcProcessIdentity; zombie: boolean } | undefined {
  if (!content.startsWith(`${pid} (`)) {
    return undefined;
  }
  const commandEnd = content.lastIndexOf(")");
  if (commandEnd < 0) {
    return undefined;
  }
  const fieldsAfterCommand = content.slice(commandEnd + 1).trim().split(/\s+/u);
  const state = fieldsAfterCommand[0];
  const startTimeTicks = fieldsAfterCommand[19];
  if (
    state === undefined ||
    startTimeTicks === undefined ||
    !LINUX_START_TIME_PATTERN.test(startTimeTicks)
  ) {
    return undefined;
  }

  return {
    identity: {
      source: "linux_proc",
      boot_id: bootId,
      start_time_ticks: startTimeTicks
    },
    zombie: state === "Z" || state === "X" || state === "x"
  };
}

export async function inspectProcess(pid: number): Promise<ProcessInspection> {
  if (!isProcessLive(pid)) {
    return { live: false };
  }
  if (process.platform !== "linux") {
    return { live: true };
  }

  try {
    const [bootIdContent, statContent] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8")
    ]);
    const bootId = bootIdContent.trim();
    if (!LINUX_BOOT_ID_PATTERN.test(bootId)) {
      return { live: isProcessLive(pid) };
    }
    const parsed = parseLinuxProcStat(pid, statContent, bootId);
    if (parsed === undefined) {
      return { live: isProcessLive(pid) };
    }
    return parsed.zombie
      ? { live: false }
      : { live: true, identity: parsed.identity };
  } catch {
    // The process may have exited between kill(0) and reading procfs. A
    // second liveness check distinguishes that race from unavailable procfs.
    return { live: isProcessLive(pid) };
  }
}

export function parseProcessIdentity(
  value: unknown
): LinuxProcProcessIdentity | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as LinuxProcProcessIdentity).source !== "linux_proc" ||
    typeof (value as LinuxProcProcessIdentity).boot_id !== "string" ||
    !LINUX_BOOT_ID_PATTERN.test((value as LinuxProcProcessIdentity).boot_id) ||
    typeof (value as LinuxProcProcessIdentity).start_time_ticks !== "string" ||
    !LINUX_START_TIME_PATTERN.test(
      (value as LinuxProcProcessIdentity).start_time_ticks
    )
  ) {
    return undefined;
  }

  return value as LinuxProcProcessIdentity;
}

export function sameProcessIdentity(
  left: LinuxProcProcessIdentity,
  right: LinuxProcProcessIdentity
): boolean {
  return left.source === right.source &&
    left.boot_id === right.boot_id &&
    left.start_time_ticks === right.start_time_ticks;
}
