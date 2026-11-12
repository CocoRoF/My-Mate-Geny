/**
 * A birthday: a month and a day, no year (lib/birthday.ts) — the user's (Settings → 계정) and a mate's (her Profile,
 * the guide). `value` / `onChange`: "MM-DD", "" unknown; a half picked one stays here until both are picked.
 */
import { useEffect, useMemo, useState } from "react";
import { daysIn, formatBirthday, parseBirthday, withMonth, type MonthDay } from "../../lib/birthday";
import { localeOf, useLang, useT } from "../../i18n";
import Icon from "./Icon";

const NONE: MonthDay = { month: 0, day: 0 };

export default function BirthdayPicker({ value, onChange, disabled, testId }: { value: string; onChange: (v: string) => void; disabled?: boolean; testId?: string }) {
  const t = useT();
  const lang = useLang();
  const [md, setMd] = useState<MonthDay>(() => parseBirthday(value) ?? NONE);
  // (the saved one came back, or was cleared: follow it — a half picked one stays)
  useEffect(() => {
    const p = parseBirthday(value);
    setMd((cur) => (p ? p : cur.month && cur.day ? NONE : cur));
  }, [value]);
  const months = useMemo(() => {
    const f = new Intl.DateTimeFormat(localeOf(lang), { month: "long" });
    return Array.from({ length: 12 }, (_, i) => f.format(new Date(2000, i, 1)));
  }, [lang]);
  const day = useMemo(() => new Intl.DateTimeFormat(localeOf(lang), { day: "numeric" }), [lang]);
  const pick = (next: MonthDay) => {
    setMd(next);
    onChange(formatBirthday(next.month, next.day));
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId}>
      <select
        className="field !w-auto min-w-[7.5rem]"
        value={md.month}
        disabled={disabled}
        onChange={(e) => pick(withMonth(md, Number(e.target.value)))}
        aria-label={t("profile.birthdayMonth")}
        data-testid={testId ? `${testId}-month` : undefined}
      >
        <option value={0}>{t("profile.birthdayMonth")}</option>
        {months.map((m, i) => (
          <option key={m} value={i + 1}>
            {m}
          </option>
        ))}
      </select>
      <select
        className="field !w-auto min-w-[6rem]"
        value={md.day}
        disabled={disabled}
        onChange={(e) => pick({ ...md, day: Number(e.target.value) })}
        aria-label={t("profile.birthdayDay")}
        data-testid={testId ? `${testId}-day` : undefined}
      >
        <option value={0}>{t("profile.birthdayDay")}</option>
        {Array.from({ length: daysIn(md.month || 1) }, (_, i) => (
          <option key={i} value={i + 1}>
            {day.format(new Date(2000, (md.month || 1) - 1, i + 1))}
          </option>
        ))}
      </select>
      {(md.month > 0 || md.day > 0) && (
        <button type="button" className="btn-ghost !px-2" onClick={() => pick(NONE)} disabled={disabled} aria-label={t("profile.birthdayClear")} title={t("profile.birthdayClear")} data-testid={testId ? `${testId}-clear` : undefined}>
          <Icon name="x" size={13} />
        </button>
      )}
    </div>
  );
}
