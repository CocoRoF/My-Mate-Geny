/**
 * A (?) beside a title or a label: the longer explanation of it — on hover with a mouse, on a tap or a click (pinned
 * until the next click), a sheet on a phone (HoverPopover). Pages keep their own text short: what they used to say in
 * paragraphs under their titles waits here until asked for.
 */
import type { ReactNode } from "react";
import { useT } from "../../i18n";
import HoverPopover from "./HoverPopover";
import Icon from "./Icon";

export default function HelpTip({ children, label, size = 13, testId }: { children: ReactNode; label?: string; size?: number; testId?: string }) {
  const t = useT();
  return (
    <span className="ml-1 inline-flex align-middle font-normal" data-testid={testId}>
      <HoverPopover
        label={label ?? t("common.help")}
        align="start"
        trigger={<Icon name="help" size={size} />}
        triggerClassName="inline-flex h-5 w-5 items-center justify-center rounded-full text-content-faint transition hover:text-content focus-visible:text-content"
        panelClassName="w-80"
      >
        {/* (its own padding: on a phone the sheet takes the content as it is) */}
        <div className="space-y-1.5 px-3.5 py-3 text-[12.5px] leading-relaxed text-content-dim">{children}</div>
      </HoverPopover>
    </span>
  );
}
