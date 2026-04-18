/** Directional movement action codes (used with speedByte = 0xFF). */
export const MOVE = {
  down: 1,
  up: 2,
  left: 3,
  right: 4,
} as const;

export type MoveDirection = keyof typeof MOVE;

/** Action 77 – stops the current movement / is used as a carrier for color updates. */
export const ACTION_STOP = 77;

/** Valid combined-body "dance" action range, inclusive. */
export const DANCE_RANGE: readonly [number, number] = [1, 93];

/** Valid arm action range, inclusive. */
export const ARM_RANGE: readonly [number, number] = [100, 110];

/** Valid leg action range, inclusive. */
export const LEG_RANGE: readonly [number, number] = [200, 235];

/** LED color codes. */
export enum COLORS {
  DARK_BLUE = 1,
  BLUE = 2,
  GREEN = 3,
  YELLOW = 4,
  RED = 5,
  PURPLE = 6,
  WHITE = 7,
}

const inRange = (n: number, range: readonly [number, number]): boolean =>
  Number.isInteger(n) && n >= range[0] && n <= range[1];

/**
 * Returns true when `n` is a known action code.
 * Valid codes: dance 1-93, arms 100-110, legs 200-235, plus the special stop (77).
 */
export function isValidAction(n: number): boolean {
  if (!Number.isInteger(n)) return false;
  if (n === ACTION_STOP) return true;
  return (
    inRange(n, DANCE_RANGE) ||
    inRange(n, ARM_RANGE) ||
    inRange(n, LEG_RANGE)
  );
}

/** Returns true when `n` is a valid LED color code (1-7). */
export function isValidColor(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 7;
}
