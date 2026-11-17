export interface CliStream {
  write(chunk: string): unknown;
}

/** Everything the CLI touches from the outside world. Tests pass fakes; bin.ts passes `process`. */
export interface CliIo {
  stdout: CliStream;
  stderr: CliStream;
  /** Project root. Every path the CLI reads or writes must stay inside it. */
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Whether stdout is a terminal (colour is only used then). */
  isTTY: boolean;
  /** Clock, injectable for deterministic reports. Defaults to `new Date()`. */
  now?: () => Date;
}
