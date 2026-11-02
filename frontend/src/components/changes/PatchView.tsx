import type { PatchFile } from "./parsePatch";
import { useT } from "../../i18n";

export default function PatchView({ file }: { file: PatchFile }) {
  const t = useT();
  if (file.binary) return <p className="p-4 text-[12px] text-content-faint">{t("files.binaryNoDiff")}</p>;
  if (!file.lines.length) return <p className="p-4 text-[12px] text-content-faint">{t("files.noTextChanges")}</p>;
  return (
    <div className="overflow-auto font-mono text-[12px] leading-[1.6]">
      <table className="w-full border-collapse">
        <tbody>
          {file.lines.map((l, i) =>
            l.kind === "hunk" ? (
              <tr key={i} className="bg-accent/8 text-accent/80 light:text-accent">
                <td colSpan={3} className="px-3 py-0.5 text-[11px]">
                  {l.text}
                </td>
              </tr>
            ) : l.kind === "meta" ? (
              <tr key={i}>
                <td colSpan={3} className="px-3 text-[11px] text-content-faint">
                  {l.text}
                </td>
              </tr>
            ) : (
              <tr
                key={i}
                className={l.kind === "add" ? "bg-success/10" : l.kind === "del" ? "bg-danger/10" : ""}
              >
                <td className="w-12 select-none border-r border-border/50 pr-2 text-right align-top text-content-faint/60 light:text-content-faint">
                  {l.a ?? ""}
                </td>
                <td className="w-12 select-none border-r border-border/50 pr-2 text-right align-top text-content-faint/60 light:text-content-faint">
                  {l.b ?? ""}
                </td>
                <td
                  className={`whitespace-pre pl-3 pr-4 align-top ${
                    l.kind === "add" ? "text-success/95 light:text-success" : l.kind === "del" ? "text-danger/90 light:text-danger" : "text-content-dim"
                  }`}
                >
                  <span className="mr-2 select-none opacity-60">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
                  {l.text || " "}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
