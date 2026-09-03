import {
  parseListeningPids,
  parseScQueryState,
  parseServiceStatusName,
} from '../src/autoupdate/serviceState';

// The point of these: every regex here used to key off an English state word,
// which silently made updates a no-op on a localized Windows.
const SC_EN = `
SERVICE_NAME: printerServer
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
`;

const SC_EL = `
SERVICE_NAME: printerServer
        ΤΥΠΟΣ                 : 10  WIN32_OWN_PROCESS
        ΚΑΤΑΣΤΑΣΗ             : 4  ΕΚΤΕΛΕΙΤΑΙ
        ΚΩΔΙΚΟΣ_ΕΞΟΔΟΥ_WIN32  : 0  (0x0)
        ΣΗΜΕΙΟ_ΕΛΕΓΧΟΥ        : 0x0
        ΥΠΟΔΕΙΞΗ_ΑΝΑΜΟΝΗΣ     : 0x0
`;

const NETSTAT_EN = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1104
  TCP    0.0.0.0:7810           0.0.0.0:0              LISTENING       8321
  TCP    192.168.1.5:7810       192.168.1.9:51234      ESTABLISHED     8321
  TCP    [::]:7810              [::]:0                 LISTENING       8321
  TCP    0.0.0.0:78100          0.0.0.0:0              LISTENING       9999
`;

const NETSTAT_EL = NETSTAT_EN.replace(/LISTENING/g, 'ΑΚΡΟΑΣΗ').replace(
  /ESTABLISHED/g,
  'ΣΥΝΔΕΔΕΜΕΝΟ'
);

describe('parseServiceStatusName', () => {
  it('maps the Get-Service enum names', () => {
    expect(parseServiceStatusName('Running\n')).toBe('RUNNING');
    expect(parseServiceStatusName('Stopped\n')).toBe('STOPPED');
    expect(parseServiceStatusName('StartPending\n')).toBe('PENDING');
    expect(parseServiceStatusName('Absent\n')).toBe('ABSENT');
  });

  it('returns null when PowerShell gave nothing usable', () => {
    expect(parseServiceStatusName('')).toBeNull();
    expect(parseServiceStatusName("'powershell' is not recognized")).toBeNull();
  });
});

describe('parseScQueryState', () => {
  it('reads the state on an English Windows', () => {
    expect(parseScQueryState(SC_EN, 0)).toBe('RUNNING');
  });

  it('reads the state on a localized Windows', () => {
    expect(parseScQueryState(SC_EL, 0)).toBe('RUNNING');
    expect(parseScQueryState(SC_EL.replace(': 4  ΕΚΤΕΛΕΙΤΑΙ', ': 1  ΔΙΕΚΟΠΗ'), 0)).toBe('STOPPED');
    expect(parseScQueryState(SC_EL.replace(': 4  ΕΚΤΕΛΕΙΤΑΙ', ': 3  ΔΙΑΚΟΠΤΕΤΑΙ'), 0)).toBe('PENDING');
  });

  it('detects an absent service by its numeric code', () => {
    const absent =
      '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\n\nThe specified service does not exist as an installed service.\n';
    expect(parseScQueryState(absent, 1)).toBe('ABSENT');
  });

  it('is UNKNOWN when sc itself failed', () => {
    expect(parseScQueryState('Access is denied.', 5)).toBe('UNKNOWN');
  });
});

describe('parseListeningPids', () => {
  it('finds the listener in either locale', () => {
    expect(parseListeningPids(NETSTAT_EN, 7810, -1)).toEqual([8321]);
    expect(parseListeningPids(NETSTAT_EL, 7810, -1)).toEqual([8321]);
  });

  it('ignores established connections and our own pid', () => {
    expect(parseListeningPids(NETSTAT_EL, 7810, 8321)).toEqual([]);
  });

  it('does not match a port that merely shares a prefix', () => {
    expect(parseListeningPids(NETSTAT_EN, 810, -1)).toEqual([]);
  });
});
