import { run } from "./run.js";

// Set exitCode instead of calling process.exit so piped stdout is flushed.
void run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  cwd: process.cwd(),
  env: process.env,
  isTTY: process.stdout.isTTY === true,
}).then((code) => {
  process.exitCode = code;
});
