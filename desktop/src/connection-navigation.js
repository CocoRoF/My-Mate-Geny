'use strict';

/** A remote console login page cannot start the local runtime. Return to the native mode chooser. */
function isServerLogin(url, base) {
  try {
    const target = new URL(url), server = new URL(base);
    if (!/^https?:$/.test(target.protocol) || target.origin !== server.origin) return false;
    const pathname = target.pathname.replace(/\/$/, '');
    const relative = new URL('login', server.href.replace(/\/?$/, '/')).pathname;
    return pathname === '/login' || pathname === relative;
  } catch { return false; }
}

function bindConsoleAuthNavigation(contents, { serverUrl, onLogin, onError = () => {} }) {
  const leave = () => {
    try { Promise.resolve(onLogin()).catch(onError); } catch (error) { onError(error); }
  };
  const before = (event, url, _inPlace, isMainFrame) => {
    if ((isMainFrame ?? event.isMainFrame) === false) return;
    if (!isServerLogin(url || event.url, serverUrl())) return;
    event.preventDefault();
    leave();
  };
  contents.on('will-navigate', before);
  contents.on('will-redirect', before);
  // loadURL() does not emit will-navigate. Also recover an initial/saved /login URL.
  contents.on('did-navigate', (_event, url) => {
    if (isServerLogin(url, serverUrl())) leave();
  });
}

module.exports = { isServerLogin, bindConsoleAuthNavigation };
