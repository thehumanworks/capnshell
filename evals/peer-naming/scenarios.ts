// The fake peers and tasks of the peer-naming evals.

export interface FakePeer {
  /** How the checks refer to this peer. */
  key: string;
  /** The daemon ID it keeps when it does not rotate. */
  id: string;
  /** Its saved name, for a device paired with this one. */
  name?: string;
  fingerprint?: string;
  hostname: string;
  platform: NodeJS.Platform;
  os: string;
  shell: "Bash" | "PowerShell";
  home: string;
  respond(command: string): string;
}

export interface RunEvent { peer: string; command: string }

export interface Scenario {
  /** Whether paired devices reconnect, and so change ID, between tool calls. */
  rotate: boolean;
  peers: FakePeer[];
  task: string;
  /** What the task needs run where; each check is one requirement. */
  checks: { label: string; ok(runs: RunEvent[]): boolean }[];
}

const has = (runs: RunEvent[], peer: string, pattern: RegExp) => runs.some((run) => run.peer === peer && pattern.test(run.command));

function unixResponder(hostname: string, kernel: string) {
  return (command: string) => {
    if (/git\b.*\bstatus/.test(command)) return "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean\n";
    if (/git\b.*\blog/.test(command)) return "9f2ee25 Merge pull request #41\n2803f56 Smooth minion attack\n79e3c3a Merge pull request #40\n";
    if (/uname/.test(command)) return `${kernel} ${hostname} 6.1.0 x86_64\n`;
    if (/\bdf\b/.test(command)) return "Filesystem  Size  Used Avail Use% Mounted on\n/dev/sda1   200G  120G   80G  60% /\n";
    return "";
  };
}

const studio: FakePeer = {
  key: "studio", id: "p4", name: "studio", fingerprint: "ccg5-7usw-6izi-k2pm-tivr-p245", hostname: "thestudio.local",
  platform: "darwin", os: "mac", shell: "Bash", home: "/Users/tomas", respond: unixResponder("thestudio.local", "Darwin"),
};
const buildbox: FakePeer = {
  key: "buildbox", id: "p7", name: "buildbox", fingerprint: "k3m9-q2xa-77cd-pp01-zz4e-a9b2", hostname: "ci-runner-07",
  platform: "linux", os: "linux", shell: "Bash", home: "/home/ci", respond: unixResponder("ci-runner-07", "Linux"),
};
const gamingPc: FakePeer = {
  key: "gaming", id: "p3", hostname: "GAMING-PC", platform: "win32", os: "windows", shell: "PowerShell", home: "C:\\Users\\tomas",
  respond: (command) => /PSVersion/i.test(command) ? "Major  Minor  Build  Revision\n-----  -----  -----  --------\n5      1      22621  4391\n" : "",
};
const pi: FakePeer = {
  key: "pi", id: "p5", hostname: "raspberrypi", platform: "linux", os: "linux", shell: "Bash", home: "/home/pi",
  respond: unixResponder("raspberrypi", "Linux"),
};

export const SCENARIOS: Record<string, Scenario> = {
  // One paired device whose name is not its hostname; the user asks for two things on it.
  single: {
    rotate: true,
    peers: [studio],
    task: "List the peers you have via cns, then check git status in ~/projects/goodboys on the studio Mac to see whether there are changes in flight, and show its last 3 commits.",
    checks: [
      { label: "status on studio", ok: (runs) => has(runs, "studio", /git\b.*\bstatus/) },
      { label: "log on studio", ok: (runs) => has(runs, "studio", /git\b.*\blog/) },
    ],
  },
  // Two paired devices and one that is not paired; work alternates between the paired ones.
  several: {
    rotate: true,
    peers: [gamingPc, studio, buildbox],
    task: "Using cns, compare `uname -a` on buildbox and on the studio Mac, then show disk usage with df -h on buildbox.",
    checks: [
      { label: "uname on studio", ok: (runs) => has(runs, "studio", /uname/) },
      { label: "uname on buildbox", ok: (runs) => has(runs, "buildbox", /uname/) },
      { label: "df on buildbox", ok: (runs) => has(runs, "buildbox", /\bdf\b/) },
      { label: "nothing on the wrong peer", ok: (runs) => !runs.some((run) => run.peer === "gaming" || (run.peer === "studio" && /\bdf\b/.test(run.command))) },
    ],
  },
  // The user names a paired device by an ID from earlier, which has since changed.
  stale: {
    rotate: true,
    peers: [gamingPc, studio],
    task: "Earlier, cns list_peers showed the studio Mac as p4. Run git status in ~/projects/goodboys on p4 to see whether there are changes in flight.",
    checks: [
      { label: "status on studio", ok: (runs) => has(runs, "studio", /git\b.*\bstatus/) },
      { label: "nothing on the wrong peer", ok: (runs) => !runs.some((run) => run.peer === "gaming") },
    ],
  },
  // No paired devices: IDs are the only handle and stay put, so they must still be used.
  unnamed: {
    rotate: false,
    peers: [pi, gamingPc],
    task: "Using cns, find the Windows machine and print its PowerShell version.",
    checks: [
      { label: "version on the Windows peer", ok: (runs) => has(runs, "gaming", /PSVersion/i) },
      { label: "nothing on the pi", ok: (runs) => !runs.some((run) => run.peer === "pi") },
    ],
  },
};
