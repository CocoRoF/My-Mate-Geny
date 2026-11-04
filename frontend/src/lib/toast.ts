/** Floating status/error messages; never part of the input layout. */
export function toast(text: string, duration = 1500) {
  document.querySelectorAll('[data-testid="app-toast"]').forEach(el=>el.remove());
  const el = document.createElement("div");
  el.textContent = text;
  el.setAttribute("role", "status");
  el.setAttribute("data-testid", "app-toast");
  el.style.cssText =
    "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:8px;" +
    "padding:7px 14px;border-radius:999px;background:rgb(var(--c-surface-3) / .96);border:1px solid rgb(var(--c-border-strong));" +
    "color:rgb(var(--c-content));font:12.5px Inter,system-ui,sans-serif;box-shadow:var(--shadow-float);transition:opacity .3s;" +
    "pointer-events:none;white-space:normal;width:max-content;max-width:min(92vw,520px);overflow-wrap:anywhere;text-align:center";
  const dot = document.createElement("span");
  dot.style.cssText =
    "width:8px;height:8px;border-radius:50%;background:#e5484d;box-shadow:0 0 0 3px #e5484d40;flex:none";
  el.prepend(dot);
  document.body.appendChild(el);
  setTimeout(() => (el.style.opacity = "0"), Math.max(0,duration-300));
  setTimeout(() => el.remove(), duration);
}

