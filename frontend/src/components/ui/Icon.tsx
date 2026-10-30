// High-quality icons via Lucide (react-icons/lu), wrapped behind a stable
// name->component map so the rest of the app stays decoupled from the set.
import type { IconType } from "react-icons";
import {
  LuMessageSquare,
  LuPlug,
  LuServer,
  LuPlus,
  LuArrowUp,
  LuCheck,
  LuX,
  LuChevronRight,
  LuChevronDown,
  LuLoaderCircle,
  LuTrash2,
  LuCpu,
  LuTerminal,
  LuFile,
  LuFolder,
  LuLogOut,
  LuZap,
  LuSearch,
  LuEllipsis,
  LuCopy,
  LuExternalLink,
  LuKeyRound,
  LuPencil,
  LuGitBranch,
  LuGithub,
  LuRefreshCw,
} from "react-icons/lu";

const MAP = {
  chat: LuMessageSquare,
  plug: LuPlug,
  server: LuServer,
  plus: LuPlus,
  "arrow-up": LuArrowUp,
  check: LuCheck,
  x: LuX,
  chevron: LuChevronRight,
  "chevron-down": LuChevronDown,
  spinner: LuLoaderCircle,
  trash: LuTrash2,
  cpu: LuCpu,
  terminal: LuTerminal,
  file: LuFile,
  folder: LuFolder,
  logout: LuLogOut,
  bolt: LuZap,
  search: LuSearch,
  more: LuEllipsis,
  copy: LuCopy,
  external: LuExternalLink,
  key: LuKeyRound,
  pencil: LuPencil,
  "git-branch": LuGitBranch,
  github: LuGithub,
  refresh: LuRefreshCw,
} satisfies Record<string, IconType>;

export type IconName = keyof typeof MAP;

export default function Icon({
  name,
  size = 16,
  className = "",
  spin = false,
}: {
  name: IconName;
  size?: number;
  className?: string;
  spin?: boolean;
}) {
  const C = MAP[name];
  return <C size={size} className={`${spin ? "animate-spin" : ""} ${className}`} strokeWidth={2} />;
}
