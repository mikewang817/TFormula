/**
 * Variables a TFormula spawned by a test must never inherit from whoever ran
 * the suite.
 *
 * `supportsKittyGraphics` in src/probe.ts reads TMUX/STY/ZELLIJ/MOSH_CONNECTION
 * as proof that a multiplexer would print APC payloads as ordinary text, and
 * `selectImageTransmissionMode` in src/image-transmitter.ts reads the SSH
 * variables as proof that the terminal cannot open a local temporary file.
 * Both are right in production and both are wrong about a pseudo-terminal the
 * test itself owns and answers: leaving them in place makes the suite exercise
 * a different code path for a developer working inside tmux or over SSH than
 * for one working in a bare local terminal.
 */
const UNINHERITED_NAMES: readonly string[] = [
  "TFORMULA_ACTIVE",
  "TMUX",
  "STY",
  "ZELLIJ",
  "MOSH_CONNECTION",
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_TTY"
];

/**
 * Build the environment for a pseudo-terminal child.  Overrides are applied
 * before the scrub, so a test that deliberately wants one of the names above
 * assigns it to the returned object instead of passing it here.
 */
export function ptyEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  Object.assign(environment, overrides);
  for (const name of UNINHERITED_NAMES) delete environment[name];
  return environment;
}
