"use strict";
// The Mate's hover action bar (from ailism-desktop-mate): its own small window
// over the bottom of the avatar, shown while the pointer is on the avatar or
// on it. Buttons go to the app (window.hrhBar, preload.js); the app sends
// what is on. A label shows above the hovered button (Windows/macOS: that
// room lets clicks through; Linux has no room, so it uses title tooltips).
const S = "http://www.w3.org/2000/svg";
const ICONS = {
  chat: ["M20 11.5a8 8 0 0 1-11.6 7.1L4 20l1.4-4.2A8 8 0 1 1 20 11.5z"],
  quick: ["M13 2 3 14h9l-1 8 10-12h-9l1-8Z"],
  throughOn: ["M7 4l10 9-4.4.6 2.6 5.4-2.2 1-2.6-5.4L7 18z", "M3 21l18-18"],
  throughOff: ["M7 4l10 9-4.4.6 2.6 5.4-2.2 1-2.6-5.4L7 18z"],
  move: ["M12 3v18M3 12h18", "M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"],
  done: ["M5 12.5l4.5 4.5L19 7"],
  hide: ["M6 6l12 12M18 6L6 18"],
  console: ["M4 5h16v14H4z", "M8 10l3 2-3 2M13 14h3"],
};

function icon(paths, dashedLast) {
  const svg = document.createElementNS(S, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  paths.forEach((d, i) => {
    const p = document.createElementNS(S, "path");
    p.setAttribute("d", d);
    if (dashedLast && i === paths.length - 1) p.setAttribute("stroke-dasharray", "2 3");
    svg.appendChild(p);
  });
  return svg;
}

const bar = document.getElementById("bar");
const tip = document.getElementById("tip");
const buttons = Object.fromEntries([...bar.querySelectorAll("button")].map((b) => [b.dataset.act, b]));
const labels = {};
let linux = false;

function set(name, paths, on, label, dashed) {
  const b = buttons[name];
  b.replaceChildren(icon(paths, dashed));
  b.classList.toggle("on", !!on);
  b.setAttribute("aria-pressed", on ? "true" : "false");
  b.setAttribute("aria-label", label);
  if (linux) b.title = label;
  else b.removeAttribute("title");
  labels[name] = label;
}

// the labels come in the app's language with the state (mate.js → i18n.js); these are the fallback
const EN = {
  chat: "Chat", quick: "Quick chat", quickKey: "Quick chat ({key})", throughOn: "Click-through: on",
  throughOff: "Click-through: off", move: "Move", doneMoving: "Done moving", hide: "Hide Mate", console: "Open console",
};

function render(s) {
  linux = !!s.linux;
  const L = { ...EN, ...(s.labels || {}) };
  set("chat", ICONS.chat, s.chatOpen, L.chat);
  set("quick", ICONS.quick, false, s.quickKey ? L.quickKey.replace("{key}", s.quickKey) : L.quick);
  set("through", s.clickThrough ? ICONS.throughOn : ICONS.throughOff, s.clickThrough,
    s.clickThrough ? L.throughOn : L.throughOff, s.clickThrough);
  set("move", s.moveMode ? ICONS.done : ICONS.move, s.moveMode, s.moveMode ? L.doneMoving : L.move);
  set("hide", ICONS.hide, false, L.hide);
  set("console", ICONS.console, false, L.console);
  document.documentElement.lang = s.lang || document.documentElement.lang || "en";
}

render({ clickThrough: true, moveMode: false, chatOpen: false, quickKey: "" });
window.hrhBar.onState(render);

bar.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) window.hrhBar.act(b.dataset.act);
});

let over = false;
document.addEventListener("mousemove", (e) => {
  const t = e.target;
  const b = t.closest && t.closest("button");
  const onBar = !!(t.closest && t.closest(".bar"));
  if (onBar !== over) {
    over = onBar;
    window.hrhBar.over(onBar);
  }
  if (b && labels[b.dataset.act] && !linux) {
    tip.textContent = labels[b.dataset.act];
    tip.hidden = false;
    const r = b.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, r.left + r.width / 2 - w / 2))}px`;
  } else tip.hidden = true;
});
document.addEventListener("mouseleave", () => {
  tip.hidden = true;
  if (over) {
    over = false;
    window.hrhBar.over(false);
  }
});
