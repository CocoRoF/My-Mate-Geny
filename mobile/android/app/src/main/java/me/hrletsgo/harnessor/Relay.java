package me.hrletsgo.harnessor;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLEncoder;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/**
 * The phone's side of a Geny Net relay (backend app/net/relay.py): ``<relay>/net/relay/connect?n=<computer>`` — the relay
 * asks the computer to accept and pipes the two WebSockets together. What goes over it is the TLS GenyNet makes on top
 * (the computer pinned, the phone's certificate): the relay forwards bytes it can't read.
 *
 * Java's TLS runs over a socket, so the WebSocket is bridged to one end of a loopback socket pair made here (the other
 * end is the one accepted from our own connect, checked by its port), and GenyNet layers TLS over the end it gets.
 */
final class Relay {

    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS) // (a quiet line stays up through proxies that end idle ones)
            .build();
    private static final long QUEUE_MAX = 1 << 20;

    private Relay() {}

    static String ws(String base) {
        return base.startsWith("https://") ? "wss://" + base.substring(8) : base.startsWith("http://") ? "ws://" + base.substring(7) : base;
    }

    /** a socket whose bytes go to the computer through the relay (throws if the computer isn't online) */
    static Socket open(String relay, String node) throws IOException {
        Socket[] pair = loopbackPair();
        Socket mine = pair[0];
        Socket other = pair[1];
        CountDownLatch opened = new CountDownLatch(1);
        AtomicReference<String> failed = new AtomicReference<>(null);
        Object writeLock = new Object();
        Request req = new Request.Builder().url(ws(relay) + "/net/relay/connect?n=" + URLEncoder.encode(node, "UTF-8")).build();
        WebSocket w = HTTP.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                opened.countDown();
                Thread t = new Thread(() -> {
                    byte[] buf = new byte[16384];
                    try {
                        InputStream in = other.getInputStream();
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            while (ws.queueSize() > QUEUE_MAX) Thread.sleep(5);
                            if (!ws.send(ByteString.of(buf, 0, n))) break;
                        }
                    } catch (IOException | InterruptedException ignored) {
                        // the TLS side went
                    }
                    ws.close(1000, null);
                }, "geny-relay-up");
                t.setDaemon(true);
                t.start();
            }

            @Override
            public void onMessage(WebSocket ws, ByteString bytes) {
                try {
                    synchronized (writeLock) {
                        OutputStream o = other.getOutputStream();
                        o.write(bytes.toByteArray());
                        o.flush();
                    }
                } catch (IOException e) {
                    ws.cancel();
                }
            }

            @Override
            public void onClosing(WebSocket ws, int code, String reason) {
                // 4404: the computer isn't online (off, or its app closed)
                if (code == 4404) failed.compareAndSet(null, "the computer is not online");
                ws.close(1000, null);
                GenyNet.closeQuietly(other);
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                GenyNet.closeQuietly(other);
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                failed.compareAndSet(null, t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage());
                opened.countDown();
                GenyNet.closeQuietly(other);
            }
        });
        try {
            if (!opened.await(15, TimeUnit.SECONDS)) {
                w.cancel();
                throw new IOException("the relay didn't answer");
            }
        } catch (InterruptedException e) {
            w.cancel();
            throw new IOException("interrupted", e);
        }
        if (failed.get() != null) {
            GenyNet.closeQuietly(mine);
            throw new IOException("relay: " + failed.get());
        }
        return mine;
    }

    /** {online, lan, port}: where the computer said it is on its own network (null: the relay didn't say) */
    static JSONObject where(String relay, String node) throws IOException {
        Request req = new Request.Builder().url(relay + "/net/relay/where?n=" + URLEncoder.encode(node, "UTF-8")).build();
        try (Response r = HTTP.newCall(req).execute()) {
            if (!r.isSuccessful() || r.body() == null) return null;
            return new JSONObject(r.body().string());
        } catch (org.json.JSONException e) {
            return null;
        }
    }

    /** two connected loopback sockets — the second is the accepted one, and certainly ours (its peer is our port) */
    private static Socket[] loopbackPair() throws IOException {
        try (ServerSocket ss = new ServerSocket()) {
            ss.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 1);
            ss.setSoTimeout(5000);
            Socket mine = new Socket();
            mine.setTcpNoDelay(true);
            mine.connect(ss.getLocalSocketAddress(), 3000);
            for (int i = 0; i < 4; i++) {
                Socket other = ss.accept();
                if (other.getPort() == mine.getLocalPort()) {
                    other.setTcpNoDelay(true);
                    return new Socket[] {mine, other};
                }
                other.close(); // (someone else on this phone got in first: not them)
            }
            mine.close();
            throw new IOException("no loopback pair");
        }
    }
}
