// Lightweight inline icon set (no icon dependency). Stroke-based, 1.6 weight.
type Name =
  | "chat"
  | "plug"
  | "server"
  | "plus"
  | "send"
  | "folder"
  | "arrow-up"
  | "check"
  | "x"
  | "chevron"
  | "spinner"
  | "trash"
  | "cpu"
  | "terminal"
  | "file"
  | "logout"
  | "bolt";

const P: Record<Name, JSX.Element> = {
  chat: <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9 9 0 0 1-3.9-.9L3 21l1.9-5.6A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 21 11.5Z" />,
  plug: <path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5V8ZM12 16v6" />,
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  send: <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  "arrow-up": <path d="M12 19V5M5 12l7-7 7 7" />,
  check: <path d="M20 6 9 17l-5-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  spinner: <path d="M12 3a9 9 0 1 0 9 9" />,
  trash: <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />,
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </>
  ),
  terminal: <path d="m4 17 6-6-6-6M12 19h8" />,
  file: <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6" />,
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  bolt: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />,
};

export default function Icon({
  name,
  size = 16,
  className = "",
  spin = false,
}: {
  name: Name;
  size?: number;
  className?: string;
  spin?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${spin ? "animate-spin" : ""} ${className}`}
      aria-hidden
    >
      {P[name]}
    </svg>
  );
}
