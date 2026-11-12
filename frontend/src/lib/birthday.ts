/**
 * A birthday as the server keeps it: "MM-DD" (02-29 too), "" unknown — the user's (`user_birthday`, Settings → Account)
 * and a mate's (`persona.birthday`, her Profile). The month/day picker (components/ui/BirthdayPicker.tsx) keeps a half
 * picked one to itself: only a whole date is a birthday.
 */

export interface MonthDay {
  month: number;
  day: number;
}

/** the days a month can have on a birthday (February: 29) */
export const daysIn = (month: number): number => (month === 2 ? 29 : [4, 6, 9, 11].includes(month) ? 30 : 31);

/** "06-21" → { month: 6, day: 21 }; anything else → null */
export function parseBirthday(v: string | null | undefined): MonthDay | null {
  const m = /^(\d{2})-(\d{2})$/.exec((v ?? "").trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(month) ? { month, day } : null;
}

/** { 6, 21 } → "06-21"; a month or day not picked (0) → "" */
export function formatBirthday(month: number, day: number): string {
  if (!(month >= 1 && month <= 12) || !(day >= 1)) return "";
  const d = Math.min(day, daysIn(month));
  return `${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** another month keeps the day, as far as that month goes (31 → 30 in June) */
export const withMonth = (cur: MonthDay, month: number): MonthDay => ({ month, day: month ? Math.min(cur.day, daysIn(month)) : cur.day });
