package me.hrletsgo.harnessor;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import android.webkit.CookieManager;
import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.KeyManager;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509ExtendedKeyManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONObject;

/**
 * Geny Net on the phone (docs/geny-net.md): this app reaching the user's own desktop app — directly on the same
 * network, from anywhere through a relay — with no VPN app and no port opened anywhere.
 *
 * - Pairing: a QR code from the desktop's Settings → 디바이스 인증 (``geny://link?…``) carries the computer's id, the
 *   SHA-256 of its certificate authority (pinned: nothing else is trusted), a one-time secret and how to reach it. The
 *   phone makes its own key in the Android Keystore (it never leaves the phone), proves it read the code
 *   (HMAC of the secret over its public key), both screens show the same six digits, the user allows it on the
 *   computer, and the computer issues the phone a certificate for that key.
 * - Every connection is TLS to the computer (pinned to its CA, the phone's certificate in the handshake): over the LAN
 *   straight to its listener, or through the relay — a WebSocket the relay pipes to the computer's own line to it;
 *   the TLS runs end to end, the relay forwards bytes it can't read (Relay below).
 * - The WebView, the background checks and the call line all talk to a proxy on this phone's loopback
 *   (``http://127.0.0.1:<port>``: a secure context — the microphone works — with no certificate to install): each
 *   connection to it is let through only with the app's own key (the ``geny_net`` cookie the app sets for the WebView,
 *   or ``Authorization: Bearer`` from the app's native requests), so no other app on the phone can use it, and becomes
 *   one TLS connection to the computer. The computer signs the phone in by its certificate: the phone holds no session.
 */
final class GenyNet {

    private static final String TAG = "GenyNet";
    static final String PREFS = "geny_net";
    static final String LINK_COOKIE = "geny_net";
    private static final String SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

    private static final String K_NODE = "node";
    private static final String K_FP = "fp";
    private static final String K_NAME = "name";
    private static final String K_DEVICE = "device";
    private static final String K_CERT = "cert";
    private static final String K_ALIAS = "alias";
    private static final String K_HOSTS = "hosts";
    private static final String K_PORT = "port";
    private static final String K_RELAY = "relay";
    private static final String K_PROXY_PORT = "proxyPort";
    private static final String K_KEY = "key";
    private static final String K_VIA = "via";
    private static final String K_INCOMING = "incoming";

    private static final int LAN_TIMEOUT_MS = 1200;
    private static final long LAN_RETRY_MS = 30_000;   // a LAN attempt that failed: straight to the relay for this long
    private static final long WHERE_EVERY_MS = 5 * 60_000L;

    private static final SecureRandom RANDOM = new SecureRandom();
    private static volatile SSLContext linked = null; // (one context: its TLS sessions resume)
    private static volatile long lanFailedAt = 0;
    private static volatile long whereAt = 0;
    private static Proxy proxy = null;
    private static Pairing pairing = null;

    private GenyNet() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean paired(Context c) {
        SharedPreferences p = prefs(c);
        return p.getString(K_CERT, null) != null && p.getString(K_ALIAS, null) != null;
    }

    /** the address the app opens for the paired computer (the proxy) */
    static String base(Context c) {
        return "http://127.0.0.1:" + proxyPort(c);
    }

    /** the app is on the paired computer now (not a server) */
    static boolean active(Context c) {
        return paired(c) && base(c).equals(GenyServerPlugin.server(c));
    }

    /** what the app's own requests to the proxy carry (GenyLink.token) */
    static String proxyKey(Context c) {
        SharedPreferences p = prefs(c);
        String k = p.getString(K_KEY, null);
        if (k == null) {
            k = b64u(random(32));
            p.edit().putString(K_KEY, k).apply();
        }
        return k;
    }

    private static int proxyPort(Context c) {
        SharedPreferences p = prefs(c);
        int port = p.getInt(K_PROXY_PORT, 0);
        if (port == 0) {
            port = 20000 + RANDOM.nextInt(40000);
            p.edit().putInt(K_PROXY_PORT, port).apply();
        }
        return port;
    }

    static String name(Context c) {
        return prefs(c).getString(K_NAME, "");
    }

    static String via(Context c) {
        return prefs(c).getString(K_VIA, "");
    }

    // ── a computer: from its QR code or the pairing kept ──

    static final class Node {
        final String id;
        final String fp;
        final String name;
        final List<String> hosts;
        final int port;
        final String relay;
        final byte[] secret; // (the QR code's: pairing only)

        Node(String id, String fp, String name, List<String> hosts, int port, String relay, byte[] secret) {
            this.id = id;
            this.fp = fp;
            this.name = name;
            this.hosts = hosts;
            this.port = port;
            this.relay = relay;
            this.secret = secret;
        }

        String host() {
            return id + ".geny.net";
        }

        /** geny://link?v=1&n=…&f=…&k=…&d=…[&h=a,b&p=…][&r=…] */
        static Node parse(String uri) {
            Uri u = Uri.parse(uri);
            if (!"geny".equals(u.getScheme()) || !"link".equals(u.getHost())) throw new IllegalArgumentException("Not a Geny Net code");
            String id = u.getQueryParameter("n");
            String fp = u.getQueryParameter("f");
            String k = u.getQueryParameter("k");
            if (id == null || !id.matches("[a-z2-7]{26}") || fp == null || fp.length() != 43 || k == null) {
                throw new IllegalArgumentException("This code is not complete");
            }
            List<String> hosts = new ArrayList<>();
            String h = u.getQueryParameter("h");
            if (h != null) for (String s : h.split(",")) if (s.trim().matches("[0-9.]{7,15}")) hosts.add(s.trim());
            int port = 0;
            try {
                port = Integer.parseInt(u.getQueryParameter("p"));
            } catch (Exception ignored) {
                // no LAN
            }
            String relay = GenyServerPlugin.cleanBase(u.getQueryParameter("r"));
            String name = u.getQueryParameter("d");
            return new Node(id, fp, name == null ? "" : name, hosts, port, relay, unb64u(k));
        }

        static Node saved(Context c) {
            SharedPreferences p = prefs(c);
            String hosts = p.getString(K_HOSTS, "");
            List<String> list = hosts.isEmpty() ? new ArrayList<>() : new ArrayList<>(Arrays.asList(hosts.split(",")));
            return new Node(p.getString(K_NODE, ""), p.getString(K_FP, ""), p.getString(K_NAME, ""), list,
                    p.getInt(K_PORT, 0), p.getString(K_RELAY, null), null);
        }
    }

    // ── TLS: the computer pinned, the phone's key from the Keystore ──

    /** trusts exactly one computer: its CA by the fingerprint from the QR code, its listener's certificate under it */
    static final class Pinned implements X509TrustManager {
        private final String fp;
        private final String host;

        Pinned(String fp, String host) {
            this.fp = fp;
            this.host = host;
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length < 2) throw new CertificateException("no certificate chain");
            X509Certificate ca = null;
            for (X509Certificate c : chain) {
                if (MessageDigest.isEqual(fp.getBytes(StandardCharsets.US_ASCII), b64u(sha256(c.getEncoded())).getBytes(StandardCharsets.US_ASCII))) ca = c;
            }
            X509Certificate leaf = chain[0];
            if (ca == null || ca == leaf) throw new CertificateException("not the paired computer");
            try {
                ca.verify(ca.getPublicKey());
                leaf.verify(ca.getPublicKey());
            } catch (Exception e) {
                throw new CertificateException("not signed by the paired computer", e);
            }
            leaf.checkValidity();
            List<String> eku = leaf.getExtendedKeyUsage();
            // (the computer issues phones' certificates too: only its listener's may answer as it)
            if (eku == null || !eku.contains(SERVER_AUTH)) throw new CertificateException("not the computer's listener");
            if (!("CN=" + host).equalsIgnoreCase(leaf.getSubjectX500Principal().getName())) throw new CertificateException("another name");
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("client side only");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }

    /** the phone's certificate and its Keystore key (absent while pairing) */
    static final class DeviceKeys extends X509ExtendedKeyManager {
        private final PrivateKey key;
        private final X509Certificate[] chain;

        DeviceKeys(PrivateKey key, X509Certificate cert) {
            this.key = key;
            this.chain = new X509Certificate[] {cert};
        }

        @Override
        public String chooseClientAlias(String[] keyType, Principal[] issuers, Socket socket) {
            return "device";
        }

        @Override
        public String chooseEngineClientAlias(String[] keyType, Principal[] issuers, SSLEngine engine) {
            return "device";
        }

        @Override
        public X509Certificate[] getCertificateChain(String alias) {
            return chain;
        }

        @Override
        public PrivateKey getPrivateKey(String alias) {
            return key;
        }

        @Override
        public String[] getClientAliases(String keyType, Principal[] issuers) {
            return new String[] {"device"};
        }

        @Override
        public String[] getServerAliases(String keyType, Principal[] issuers) {
            return null;
        }

        @Override
        public String chooseServerAlias(String keyType, Principal[] issuers, Socket socket) {
            return null;
        }
    }

    private static SSLContext context(Node n, KeyManager km) throws IOException {
        try {
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(km == null ? null : new KeyManager[] {km}, new TrustManager[] {new Pinned(n.fp, n.host())}, RANDOM);
            return ctx;
        } catch (Exception e) {
            throw new IOException("TLS: " + e.getMessage(), e);
        }
    }

    private static SSLContext linkedContext(Context c) throws IOException {
        SSLContext ctx = linked;
        if (ctx != null) return ctx;
        synchronized (GenyNet.class) {
            if (linked != null) return linked;
            SharedPreferences p = prefs(c);
            try {
                KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
                ks.load(null);
                PrivateKey key = (PrivateKey) ks.getKey(p.getString(K_ALIAS, ""), null);
                if (key == null) throw new IOException("this phone's key is gone: pair it again");
                X509Certificate cert = (X509Certificate) CertificateFactory.getInstance("X.509")
                        .generateCertificate(new ByteArrayInputStream(p.getString(K_CERT, "").getBytes(StandardCharsets.US_ASCII)));
                linked = context(Node.saved(c), new DeviceKeys(key, cert));
                return linked;
            } catch (IOException e) {
                throw e;
            } catch (Exception e) {
                throw new IOException("the pairing can't be read: " + e.getMessage(), e);
            }
        }
    }

    private static SSLSocket tls(SSLContext ctx, Socket raw, Node n) throws IOException {
        SSLSocket s = (SSLSocket) ctx.getSocketFactory().createSocket(raw, n.host(), n.port > 0 ? n.port : 443, true);
        List<String> want = new ArrayList<>();
        for (String p : s.getSupportedProtocols()) if (p.equals("TLSv1.3") || p.equals("TLSv1.2")) want.add(p);
        s.setEnabledProtocols(want.toArray(new String[0]));
        SSLParameters params = s.getSSLParameters();
        params.setServerNames(Collections.singletonList(new SNIHostName(n.host())));
        s.setSSLParameters(params);
        s.setSoTimeout(20_000);
        try {
            s.startHandshake();
        } catch (IOException e) {
            try {
                s.close();
            } catch (IOException ignored) {
                // gone
            }
            throw e;
        }
        s.setSoTimeout(0);
        return s;
    }

    /** a TLS connection to the computer: the LAN first (unless it failed a moment ago), then the relay */
    static SSLSocket connect(Context c, Node n, SSLContext ctx) throws IOException {
        IOException last = null;
        boolean lanFresh = System.currentTimeMillis() - lanFailedAt > LAN_RETRY_MS;
        if (n.port > 0 && !n.hosts.isEmpty() && lanFresh) {
            try {
                SSLSocket s = tls(ctx, lan(n), n);
                note(c, "lan");
                return s;
            } catch (IOException e) {
                lanFailedAt = System.currentTimeMillis();
                last = e;
            }
        }
        if (n.relay != null) {
            try {
                SSLSocket s = tls(ctx, Relay.open(n.relay, n.id), n);
                note(c, "relay");
                if (c != null && paired(c)) refreshWhere(c, n);
                return s;
            } catch (IOException e) {
                last = e;
            }
        }
        if (n.port > 0 && !n.hosts.isEmpty() && !lanFresh) {
            try { // (the relay is down too: the LAN once more)
                SSLSocket s = tls(ctx, lan(n), n);
                lanFailedAt = 0;
                note(c, "lan");
                return s;
            } catch (IOException e) {
                last = e;
            }
        }
        throw last != null ? last : new IOException("no way to reach the computer");
    }

    static SSLSocket connectLinked(Context c) throws IOException {
        return connect(c, Node.saved(c), linkedContext(c));
    }

    private static void note(Context c, String via) {
        if (c == null) return;
        SharedPreferences p = prefs(c);
        if (!via.equals(p.getString(K_VIA, ""))) p.edit().putString(K_VIA, via).apply();
    }

    /** every LAN address at once; the first to answer wins */
    private static Socket lan(Node n) throws IOException {
        LinkedBlockingQueue<Object> got = new LinkedBlockingQueue<>();
        AtomicInteger left = new AtomicInteger(n.hosts.size());
        final Object[] winner = {null};
        for (String h : n.hosts) {
            new Thread(() -> {
                Socket s = new Socket();
                try {
                    s.setTcpNoDelay(true);
                    s.connect(new InetSocketAddress(h, n.port), LAN_TIMEOUT_MS);
                    synchronized (winner) {
                        if (winner[0] == null) {
                            winner[0] = s;
                            got.offer(s);
                            return;
                        }
                    }
                    s.close();
                } catch (IOException e) {
                    try {
                        s.close();
                    } catch (IOException ignored) {
                        // gone
                    }
                    if (left.decrementAndGet() == 0) got.offer(e);
                }
            }, "geny-net-lan").start();
        }
        try {
            Object r = got.poll(LAN_TIMEOUT_MS + 500, TimeUnit.MILLISECONDS);
            if (r instanceof Socket) return (Socket) r;
            synchronized (winner) {
                if (winner[0] instanceof Socket) return (Socket) winner[0]; // (it answered just now)
                winner[0] = Boolean.FALSE; // (later answers close themselves)
            }
            throw r instanceof IOException ? (IOException) r : new SocketTimeoutException("not on this network");
        } catch (InterruptedException e) {
            throw new IOException("interrupted", e);
        }
    }

    /** where the computer says it is on its own network now (the relay knows): for the next direct try */
    private static void refreshWhere(Context c, Node n) {
        long now = System.currentTimeMillis();
        if (now - whereAt < WHERE_EVERY_MS) return;
        whereAt = now;
        Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                JSONObject j = Relay.where(n.relay, n.id);
                if (j == null || !j.optBoolean("online")) return;
                List<String> hosts = new ArrayList<>();
                if (j.optJSONArray("lan") != null) {
                    for (int i = 0; i < j.getJSONArray("lan").length(); i++) {
                        String h = j.getJSONArray("lan").optString(i);
                        if (h.matches("[0-9.]{7,15}")) hosts.add(h);
                    }
                }
                prefs(app).edit().putString(K_HOSTS, String.join(",", hosts)).putInt(K_PORT, j.optInt("port", 0)).apply();
                synchronized (GenyNet.class) {
                    linked = null; // (the next connection reads the new addresses; the key and pin are the same)
                }
            } catch (Exception e) {
                Log.i(TAG, "where: " + e.getMessage());
            }
        }, "geny-net-where").start();
    }

    // ── pairing ──

    private static final class Pairing {
        final Node node;
        final String alias;
        final String request;

        Pairing(Node node, String alias, String request) {
            this.node = node;
            this.alias = alias;
            this.request = request;
        }
    }

    static final class PairException extends Exception {
        final String code;

        PairException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** the first half (the user is shown the six digits): {request, sas, name} */
    static JSONObject pair(Context c, String uri) throws Exception {
        Node n = Node.parse(uri);
        String alias = "geny_net_" + hex(random(6));
        KeyPair kp = newKey(alias);
        byte[] spki = kp.getPublic().getEncoded();
        JSONObject body = new JSONObject();
        body.put("pub", b64u(spki));
        body.put("proof", b64u(hmac(n.secret, concat(("geny-net-pair|" + n.id + "|").getBytes(StandardCharsets.UTF_8), spki))));
        body.put("name", deviceName(c));
        body.put("platform", "android");
        Resp r;
        try {
            r = request(connect(null, n, context(n, null)), n, "/api/net/pair/request", body);
        } catch (IOException e) {
            dropKey(alias);
            throw new PairException("unreachable", "Can't reach " + (n.name.isEmpty() ? "the computer" : n.name) + ": " + e.getMessage());
        }
        if (r.status != 200) {
            dropKey(alias);
            throw new PairException(r.json.optString("code", "error"), r.json.optString("detail", "HTTP " + r.status));
        }
        String sas = r.json.optString("sas");
        // (the same six digits must come from the secret and this phone's key: anything else is not that computer)
        if (!sas.equals(sasOf(n.secret, spki))) {
            dropKey(alias);
            throw new PairException("mismatch", "The computer answered with the wrong code");
        }
        synchronized (GenyNet.class) {
            if (pairing != null && !pairing.alias.equals(prefs(c).getString(K_ALIAS, ""))) dropKey(pairing.alias);
            pairing = new Pairing(n, alias, r.json.optString("request"));
        }
        JSONObject out = new JSONObject();
        out.put("request", r.json.optString("request"));
        out.put("sas", sas);
        out.put("name", r.json.optString("name", n.name));
        return out;
    }

    /** the second half: waits up to ~25 s for the user's answer → "pending" | "approved" | "denied" | "expired" */
    static String pairWait(Context c) throws Exception {
        Pairing pg;
        synchronized (GenyNet.class) {
            pg = pairing;
        }
        if (pg == null) return "expired";
        JSONObject body = new JSONObject();
        body.put("request", pg.request);
        Resp r = request(connect(null, pg.node, context(pg.node, null)), pg.node, "/api/net/pair/result", body);
        String state = r.status == 200 ? r.json.optString("state", "expired") : "expired";
        if ("approved".equals(state)) {
            SharedPreferences p = prefs(c);
            String old = p.getString(K_ALIAS, null);
            // (a new key for every pairing: the key a phone kept for another computer is gone with it)
            p.edit()
                    .putString(K_NODE, pg.node.id)
                    .putString(K_FP, pg.node.fp)
                    .putString(K_NAME, r.json.optString("name", pg.node.name))
                    .putString(K_DEVICE, r.json.optString("device"))
                    .putString(K_CERT, r.json.optString("cert"))
                    .putString(K_ALIAS, pg.alias)
                    .putString(K_HOSTS, String.join(",", pg.node.hosts))
                    .putInt(K_PORT, pg.node.port)
                    .putString(K_RELAY, pg.node.relay)
                    .putString(K_KEY, b64u(random(32)))
                    .remove(K_VIA)
                    .apply();
            if (old != null && !old.equals(pg.alias)) dropKey(old);
            synchronized (GenyNet.class) {
                linked = null;
                pairing = null;
                if (proxy != null) proxy.close(); // (its key changed: ensureProxy starts it again)
                proxy = null;
            }
            lanFailedAt = 0;
            Log.i(TAG, "paired with " + pg.node.id);
        } else if (!"pending".equals(state)) {
            cancelPairing(c);
        }
        return state;
    }

    static void cancelPairing(Context c) {
        synchronized (GenyNet.class) {
            if (pairing != null && !pairing.alias.equals(prefs(c).getString(K_ALIAS, ""))) dropKey(pairing.alias);
            pairing = null;
        }
    }

    /** this phone's pairing gone (its key too): the computer lists it until removed there */
    static void forget(Context c) {
        SharedPreferences p = prefs(c);
        String alias = p.getString(K_ALIAS, null);
        if (alias != null) dropKey(alias);
        p.edit().clear().apply();
        synchronized (GenyNet.class) {
            linked = null;
            if (proxy != null) proxy.close();
            proxy = null;
        }
    }

    /** a geny:// link opened from outside the app (the camera app, a browser), for the connect page — `confirmed`:
     *  the user already said yes to it (MainActivity.askLink) */
    static void incoming(Context c, String uri, boolean confirmed) {
        prefs(c).edit().putString(K_INCOMING, uri).putBoolean(K_INCOMING + "Ok", confirmed).apply();
    }

    /** {uri, confirmed} once, or null */
    static String[] takeIncoming(Context c) {
        SharedPreferences p = prefs(c);
        String u = p.getString(K_INCOMING, null);
        if (u == null) return null;
        boolean ok = p.getBoolean(K_INCOMING + "Ok", false);
        p.edit().remove(K_INCOMING).remove(K_INCOMING + "Ok").apply();
        return new String[] {u, ok ? "1" : ""};
    }

    static String sasOf(byte[] secret, byte[] spki) throws Exception {
        byte[] d = hmac(secret, concat("geny-net-sas|".getBytes(StandardCharsets.UTF_8), spki));
        long v = ((d[0] & 0xffL) << 24) | ((d[1] & 0xffL) << 16) | ((d[2] & 0xffL) << 8) | (d[3] & 0xffL);
        return String.format(Locale.ROOT, "%06d", v % 1_000_000L);
    }

    private static KeyPair newKey(String alias) throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
        g.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                // (TLS signs with the digest of its choice — and NONE when it hashed already)
                .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA384, KeyProperties.DIGEST_SHA512)
                .build());
        return g.generateKeyPair();
    }

    private static void dropKey(String alias) {
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(alias)) ks.deleteEntry(alias);
        } catch (Exception e) {
            Log.w(TAG, "could not remove a key: " + e.getMessage());
        }
    }

    private static String deviceName(Context c) {
        String n = null;
        try {
            if (Build.VERSION.SDK_INT >= 25) n = android.provider.Settings.Global.getString(c.getContentResolver(), android.provider.Settings.Global.DEVICE_NAME);
        } catch (Exception ignored) {
            // not readable
        }
        if (n == null || n.trim().isEmpty()) n = Build.MODEL;
        return n == null ? "Android" : n.trim();
    }

    // ── HTTP over one TLS connection (pairing only; the WebView's goes through the proxy) ──

    static final class Resp {
        final int status;
        final JSONObject json;

        Resp(int status, JSONObject json) {
            this.status = status;
            this.json = json;
        }
    }

    private static Resp request(SSLSocket s, Node n, String path, JSONObject body) throws IOException {
        try {
            s.setSoTimeout(45_000);
            byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
            String head = "POST " + path + " HTTP/1.1\r\nHost: " + n.host() + "\r\nContent-Type: application/json\r\nContent-Length: "
                    + data.length + "\r\nConnection: close\r\n\r\n";
            OutputStream o = s.getOutputStream();
            o.write(head.getBytes(StandardCharsets.US_ASCII));
            o.write(data);
            o.flush();
            InputStream in = new BufferedInputStream(s.getInputStream());
            byte[] top = readHead(in, 32 * 1024);
            if (top == null) throw new IOException("no answer");
            String[] lines = new String(top, StandardCharsets.ISO_8859_1).split("\r\n");
            int status = Integer.parseInt(lines[0].split(" ")[1]);
            int length = -1;
            for (String l : lines) {
                int i = l.indexOf(':');
                if (i > 0 && l.substring(0, i).trim().equalsIgnoreCase("content-length")) length = Integer.parseInt(l.substring(i + 1).trim());
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int r;
            while ((length < 0 || out.size() < length) && (r = in.read(buf)) > 0) out.write(buf, 0, r);
            JSONObject json;
            try {
                json = new JSONObject(out.toString("UTF-8"));
            } catch (Exception e) {
                json = new JSONObject();
            }
            return new Resp(status, json);
        } catch (NumberFormatException | ArrayIndexOutOfBoundsException e) {
            throw new IOException("a broken answer", e);
        } finally {
            try {
                s.close();
            } catch (IOException ignored) {
                // gone
            }
        }
    }

    /** an HTTP head (through the blank line), or null if the connection ended first or it is too long */
    static byte[] readHead(InputStream in, int max) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(1024);
        int state = 0;
        while (b.size() < max) {
            int ch = in.read();
            if (ch < 0) return null;
            b.write(ch);
            state = (ch == '\r') ? (state == 2 ? 3 : 1) : (ch == '\n' && (state == 1 || state == 3)) ? state + 1 : 0;
            if (state == 4) return b.toByteArray();
        }
        return null;
    }

    // ── the proxy on this phone's loopback ──

    /** on whenever the app runs and a computer is paired (GenyApp: the activity, the background checks, the call line) */
    static synchronized void ensureProxy(Context c) {
        if (!paired(c)) return;
        if (proxy != null && proxy.alive()) return;
        Context app = c.getApplicationContext();
        try {
            proxy = new Proxy(app, proxyPort(app));
        } catch (IOException e) {
            // (the port is taken — another app: a new one, and the app opens that from now on)
            String old = base(app);
            prefs(app).edit().putInt(K_PROXY_PORT, 20000 + RANDOM.nextInt(40000)).apply();
            try {
                proxy = new Proxy(app, proxyPort(app));
                if (old.equals(GenyServerPlugin.server(app))) GenyServerPlugin.select(app, base(app), base(app) + "/", true);
            } catch (IOException e2) {
                Log.e(TAG, "no proxy: " + e2.getMessage());
                return;
            }
        }
        proxy.start();
    }

    /** the WebView's pass to the proxy: an HttpOnly cookie for its address only */
    static void allowWebView(Context c) {
        try {
            CookieManager cm = CookieManager.getInstance();
            cm.setCookie(base(c), LINK_COOKIE + "=" + proxyKey(c) + "; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict");
            cm.flush();
        } catch (Exception e) {
            Log.w(TAG, "cookie: " + e.getMessage());
        }
    }

    private static final class Proxy extends Thread {
        private final Context app;
        private final ServerSocket server;
        private final byte[] key;
        private final ExecutorService pool = Executors.newCachedThreadPool();
        private volatile boolean open = true;

        Proxy(Context app, int port) throws IOException {
            super("geny-net-proxy");
            setDaemon(true);
            this.app = app;
            this.key = proxyKey(app).getBytes(StandardCharsets.US_ASCII);
            ServerSocket s = new ServerSocket();
            s.setReuseAddress(true);
            s.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 64);
            this.server = s;
        }

        boolean alive() {
            return open && !server.isClosed() && isAlive();
        }

        void close() {
            open = false;
            try {
                server.close();
            } catch (IOException ignored) {
                // gone
            }
            pool.shutdownNow();
        }

        @Override
        public void run() {
            Log.i(TAG, "proxy on 127.0.0.1:" + server.getLocalPort());
            while (open) {
                try {
                    Socket s = server.accept();
                    pool.execute(() -> handle(s));
                } catch (IOException e) {
                    if (open) Log.w(TAG, "proxy: " + e.getMessage());
                    if (server.isClosed()) break;
                }
            }
            open = false;
        }

        private void handle(Socket local) {
            SSLSocket up = null;
            try {
                local.setTcpNoDelay(true);
                local.setSoTimeout(30_000);
                InputStream in = new BufferedInputStream(local.getInputStream(), 16384);
                byte[] head = readHead(in, 64 * 1024);
                if (head == null) return;
                if (!allowed(head)) {
                    local.getOutputStream().write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
                    return;
                }
                local.setSoTimeout(0);
                try {
                    up = connectLinked(app);
                } catch (IOException e) {
                    // (no answer at all: the page shows the app's offline screen, the background checks try later)
                    Log.i(TAG, "computer unreachable: " + e.getMessage());
                    return;
                }
                OutputStream uo = up.getOutputStream();
                uo.write(head);
                uo.flush();
                final SSLSocket upper = up;
                CountDownLatch answered = new CountDownLatch(1);
                Thread back = new Thread(() -> {
                    // (the page's side ended — maybe only its sending half: the answer still comes back, for a while)
                    if (copy(in, uo)) {
                        try {
                            answered.await(30, TimeUnit.SECONDS);
                        } catch (InterruptedException ignored) {
                            // closing anyway
                        }
                    }
                    closeQuietly(local);
                    closeQuietly(upper);
                }, "geny-net-up");
                back.start();
                copy(up.getInputStream(), local.getOutputStream());
                answered.countDown();
            } catch (IOException e) {
                // the page or the computer went
            } finally {
                closeQuietly(local);
                closeQuietly(up);
            }
        }

        /** the app's own key: the cookie (the WebView) or the Bearer token (its native requests) */
        private boolean allowed(byte[] head) {
            String[] lines = new String(head, StandardCharsets.ISO_8859_1).split("\r\n");
            for (int i = 1; i < lines.length; i++) {
                String l = lines[i];
                int c = l.indexOf(':');
                if (c <= 0) continue;
                String name = l.substring(0, c).trim().toLowerCase(Locale.ROOT);
                String value = l.substring(c + 1).trim();
                if (name.equals("cookie")) {
                    for (String part : value.split(";")) {
                        String p = part.trim();
                        if (p.startsWith(LINK_COOKIE + "=") && same(p.substring(LINK_COOKIE.length() + 1))) return true;
                    }
                } else if (name.equals("authorization") && value.regionMatches(true, 0, "Bearer ", 0, 7) && same(value.substring(7).trim())) {
                    return true;
                }
            }
            return false;
        }

        private boolean same(String v) {
            return MessageDigest.isEqual(key, v.getBytes(StandardCharsets.US_ASCII));
        }
    }

    /** bytes from `in` to `out` until `in` ends (true) or either side fails (false) */
    private static boolean copy(InputStream in, OutputStream out) {
        byte[] buf = new byte[16384];
        try {
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                out.flush();
            }
            return true;
        } catch (IOException ignored) {
            return false; // one side went
        }
    }

    static void closeQuietly(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (IOException ignored) {
            // gone
        }
    }

    // ── bytes ──

    static String b64u(byte[] b) {
        return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    static byte[] unb64u(String s) {
        return Base64.decode(s, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    static byte[] sha256(byte[] b) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(b);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static byte[] hmac(byte[] key, byte[] data) throws Exception {
        Mac m = Mac.getInstance("HmacSHA256");
        m.init(new SecretKeySpec(key, "HmacSHA256"));
        return m.doFinal(data);
    }

    private static byte[] concat(byte[] a, byte[] b) {
        byte[] out = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    private static byte[] random(int n) {
        byte[] b = new byte[n];
        RANDOM.nextBytes(b);
        return b;
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format(Locale.ROOT, "%02x", x));
        return s.toString();
    }
}
