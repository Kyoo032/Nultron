/**
 * The initial and reset passwords the operator command hands out.
 *
 * 20 characters from a 56-character alphabet (no `I`, `O`, `l`, `o`, `0` or `1`, because a person
 * reads this off a terminal and types it into a browser), which is about 116 bits, written in five
 * groups of four joined by dashes. The dashes are part of the password: 24 characters, well past the
 * 12 the policy asks for. `randomInt` is uniform, so there is no modulo bias.
 *
 * It is printed once by `pnpm portal:account` and held nowhere else: only its scrypt hash is stored,
 * and the account is flagged so the person must replace it before a session is issued.
 */
import { randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const GROUPS = 5;
const GROUP_LENGTH = 4;

export function generateInitialPassword(): string {
  const groups: string[] = [];
  for (let group = 0; group < GROUPS; group += 1) {
    let part = "";
    for (let index = 0; index < GROUP_LENGTH; index += 1) {
      part += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(part);
  }
  return groups.join("-");
}
