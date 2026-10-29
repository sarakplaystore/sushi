/**
 * Helpers for the serverless SSH exec stream (`/api/ssh/exec`).
 *
 * Every command is wrapped so the remote shell prints an OSC marker with the exit
 * code and working directory when it finishes:
 *   "\n" ESC "]777;SUSHI_META;<exit>;<pwd>" BEL
 */
export const META_REGEX = /\r?\n?\x1b\]777;SUSHI_META;(-?\d+);([^\x07]*)\x07/;
export const META_PREFIX = "\x1b]777;SUSHI_META;";

/**
 * Splits buffered output into the part that is safe to send now and a tail that
 * must be held back because it could still turn into the (possibly packet-split)
 * SUSHI_META marker. Only a genuine marker prefix — plus the line break the marker
 * regex swallows — is held, so short prompts such as "[sudo] password for user: "
 * or "Continue? [Y/n] " reach the browser immediately instead of being stuck in
 * the buffer while the command waits.
 */
export function splitEmittable(buffer: string): [emit: string, hold: string] {
  let holdFrom = buffer.length;
  const esc = buffer.lastIndexOf("\x1b");
  if (esc !== -1) {
    const tail = buffer.slice(esc);
    const couldBeMarker =
      tail.length <= META_PREFIX.length
        ? META_PREFIX.startsWith(tail)
        : tail.startsWith(META_PREFIX) && !tail.includes("\x07");
    if (couldBeMarker) holdFrom = esc;
  }
  if (holdFrom > 0 && buffer[holdFrom - 1] === "\n") holdFrom--;
  if (holdFrom > 0 && buffer[holdFrom - 1] === "\r") holdFrom--;
  return [buffer.slice(0, holdFrom), buffer.slice(holdFrom)];
}
