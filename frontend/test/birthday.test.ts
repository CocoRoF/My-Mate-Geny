// A birthday as the server keeps it (src/lib/birthday.ts): "MM-DD", "" unknown — the month/day picker of Settings →
// Account, her Profile and the guide. Only a whole date is one; another month keeps the day as far as it goes.
//   Run: npm run test:unit
import assert from "node:assert/strict";
import test from "node:test";
import { daysIn, formatBirthday, parseBirthday, withMonth } from "../src/lib/birthday";

test("MM-DD in, month and day out — nothing else is a birthday", () => {
  assert.deepEqual(parseBirthday("06-21"), { month: 6, day: 21 });
  assert.deepEqual(parseBirthday(" 02-29 "), { month: 2, day: 29 }, "the 29th of February is one");
  for (const bad of ["", null, undefined, "6-21", "13-01", "00-10", "04-31", "02-30", "06/21", "2026-06-21"]) assert.equal(parseBirthday(bad), null, String(bad));
});

test("a month and a day → MM-DD; half picked → none", () => {
  assert.equal(formatBirthday(6, 21), "06-21");
  assert.equal(formatBirthday(12, 1), "12-01");
  assert.equal(formatBirthday(0, 21), "");
  assert.equal(formatBirthday(6, 0), "");
  assert.equal(formatBirthday(2, 31), "02-29", "past the month's end: its last day");
});

test("the days a month has on a birthday; another month keeps the day as far as it goes", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(daysIn), [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  assert.deepEqual(withMonth({ month: 1, day: 31 }, 6), { month: 6, day: 30 });
  assert.deepEqual(withMonth({ month: 1, day: 31 }, 2), { month: 2, day: 29 });
  assert.deepEqual(withMonth({ month: 3, day: 31 }, 0), { month: 0, day: 31 }, "no month: the day waits");
});
