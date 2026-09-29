/**
 * Parsing of Windows service/port tool output.
 *
 * Split out from autoupdate.ts so it can be unit-tested without booting the
 * update module: every function here is pure. The rule they all follow is that
 * sc.exe and netstat print *localized* field labels and state words, so nothing
 * may key off `RUNNING`/`STOPPED`/`LISTENING` — on a Greek Windows those words
 * are simply not in the output.
 */

export type ServiceState =
  | 'RUNNING'
  | 'STOPPED'
  | 'PENDING'
  | 'ABSENT'
  | 'UNKNOWN';

/** `Get-Service .Status` is a .NET enum name, identical in every locale. */
export function parseServiceStatusName(output: string): ServiceState | null {
  if (/\bAbsent\b/i.test(output)) return 'ABSENT';
  if (/\bRunning\b/i.test(output)) return 'RUNNING';
  if (/\bStopped\b/i.test(output)) return 'STOPPED';
  if (/\b\w+Pending\b/i.test(output)) return 'PENDING';
  return null;
}

/**
 * Fallback for a machine without PowerShell. The labels and state words are
 * localized but the numbers are not, and sc prints TYPE before STATE — so the
 * second `: <n>  <word>` pair is the state (exit-code lines read `0  (0x0)`).
 */
export function parseScQueryState(output: string, code: number): ServiceState {
  if (/\b1060\b/.test(output)) return 'ABSENT'; // service does not exist
  if (code !== 0) return 'UNKNOWN';
  const codes = [...output.matchAll(/:\s*(\d+)\s+[^\s(]/g)].map((m) =>
    Number(m[1])
  );
  switch (codes[1]) {
    case 1:
      return 'STOPPED';
    case 4:
      return 'RUNNING';
    case 2:
    case 3:
    case 5:
    case 6:
      return 'PENDING';
    default:
      return 'UNKNOWN';
  }
}

/**
 * PIDs listening on `port`, excluding `selfPid`. A listener is recognised by
 * its wildcard foreign address rather than by the localized state column.
 */
export function parseListeningPids(
  output: string,
  port: number,
  selfPid: number
): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    if (!(parts[1] ?? '').endsWith(`:${port}`)) continue;
    const foreign = parts[2] ?? '';
    if (foreign !== '0.0.0.0:0' && foreign !== '[::]:0') continue;
    const pid = parseInt(parts[parts.length - 1] ?? '', 10);
    if (!Number.isFinite(pid) || pid === 0 || pid === selfPid) continue;
    pids.add(pid);
  }
  return [...pids];
}
