# Deployment guide

Bug-Free Eureka runs inside your app, so deployment is your app's deployment. What changes behind a proxy is what Express believes about the client: its address (`req.ip`, which the rate limiter keys on) and whether the request was HTTPS (`req.secure`). Both come from the `trust proxy` setting.

::: info What is tested
The Express behaviour on this page is tested in this repository's CI (`tests/integration/docs-examples.test.ts`). The Nginx, Docker and PM2 snippets are configuration examples: they are not run in CI. Check them against your own setup.
:::

## Reverse proxy and `trust proxy`

Set `trust proxy` to exactly what is in front of the app:

| In front of the app | Setting | BFE-006 evidence `deployment` |
|---|---|---|
| Nothing: clients connect directly | `app.set("trust proxy", false)` (the default) | `topology: "none"` |
| One reverse proxy (Nginx, Apache, one load balancer) | `app.set("trust proxy", 1)` | `topology: "single-proxy"`, `declaredHops: 1` |
| A CDN and a load balancer you control | `app.set("trust proxy", 2)`, or the proxies' addresses | `topology: "cdn-plus-lb"`, `declaredHops: 2` |
| Proxies with known private addresses | `app.set("trust proxy", ["loopback", "10.0.1.0/28"])` | list them in `proxyAddresses` |

Never use `app.set("trust proxy", true)` on an app clients can reach without the proxy. With `true`, Express takes the left-most `X-Forwarded-For` address, which the client writes, so every client chooses its own `req.ip` and can bypass the rate limiter. The limiter warns about this through its `logger` (`trust_proxy_true`). The [BFE-006 page](/rules/BFE-006) has the full decision table.

Too little trust is a bug too: behind a proxy with `trust proxy` unset, `req.ip` is the proxy's address, so all clients share one rate-limit bucket.

The example app shows what Express derives. With `trust proxy` set to `1`, it takes the right-most `X-Forwarded-For` entry (the one your proxy added) and the protocol from `X-Forwarded-Proto`:

```js
// examples/express-basic/app.js
app.get("/whoami", (req, res) => res.json({ ip: req.ip, protocol: req.protocol, secure: req.secure }));
// GET /whoami with X-Forwarded-For: 198.51.100.1, 203.0.113.7 and X-Forwarded-Proto: https
// → { "ip": "203.0.113.7", "protocol": "https", "secure": true }
```

With `trust proxy` set to `false`, the same request gives the socket address and `secure: false`: the headers are ignored.

### Untrusted forwarded headers

Your outermost proxy should **overwrite** `X-Forwarded-For` rather than append to what the client sent, and set `X-Forwarded-Proto` and `X-Forwarded-Host` itself. Make the app reachable only through the proxy: listen on `127.0.0.1` or a private network, or restrict the firewall or security group to the proxy. Then test from outside: send a request with a forged `X-Forwarded-For` through the real entry point and check that the address the app logs is not the forged one.

## HTTPS termination

When the proxy terminates TLS, the app sees plain HTTP. With the correct `trust proxy`, Express reads `X-Forwarded-Proto`, so `req.secure` is `true` for HTTPS requests. Middleware that checks `req.secure`, such as session middleware that sends `Secure` cookies only over HTTPS, then works as intended. Without it, `req.secure` stays `false`.

Redirect HTTP to HTTPS at the proxy, and send `Strict-Transport-Security` from the app or the proxy (see [BFE-001](/rules/BFE-001)).

## Nginx

One Nginx in front of one app on the same host, with `trust proxy` set to `1`:

```nginx
server {
    listen 80;
    server_name api.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name api.example.com;
    ssl_certificate     /etc/ssl/certs/api.example.com.pem;
    ssl_certificate_key /etc/ssl/private/api.example.com.key;

    client_max_body_size 1m; # request-size cap at the proxy (BFE-003)

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $remote_addr;   # overwrite, never $proxy_add_x_forwarded_for at the edge
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
    }
}
```

The app listens on `127.0.0.1:3000` (the default of `examples/express-basic/server.js`), so clients cannot bypass Nginx. In BFE-006 evidence this is `topology: "single-proxy"`, `declaredHops: 1`, `directExposure: "no"`, `forwardedHeaderHandling: "overwrite"`.

If another proxy, such as a CDN, sits in front of Nginx, Nginx is no longer the edge: it must append, and the CDN must overwrite. Count both hops.

## More than one instance

The default in-memory store counts per process. With PM2 cluster mode, several containers or several hosts, every process has its own counters, so a client gets the limit once per process. Use a shared Redis-compatible store. The package bundles no Redis client; you pass a function that runs `EVAL`. With ioredis:

<<< @/../examples/express-redis/store.js#ioredis{js}

Then pass it to every limiter, for example `createApp({ store: createSharedStore(new Redis(process.env.REDIS_URL)) })` with the example app. The test suite runs two app instances on one shared store and checks that they enforce one login limit together.

- Use `onStoreError: "fail-closed"` on login, OTP and password-reset routes, so a Redis outage answers `503` instead of switching the limit off. General traffic can stay `fail-open` (the default).
- Window boundaries come from each instance's clock: keep clocks in sync (NTP).
- Use a different `prefix` per application when several share one Redis.
- Keys are SHA-256 hashed before they reach Redis, so it holds no raw IPs or usernames.

## Docker

- Inside a container, the app must listen on `0.0.0.0` (`HOST=0.0.0.0` for the example server). Publish the port only to the proxy: `-p 127.0.0.1:3000:3000`, or put the proxy and app on one Docker network and publish only the proxy.
- A published port is not a proxy and adds no `X-Forwarded-For`. Count only real proxies (Nginx, Traefik, a load balancer) as hops.
- Depending on the Docker network setup, `req.ip` may be a Docker gateway address instead of the client's. Check what a route like `/whoami` reports before you rely on per-client limits.
- Run as a non-root user (`USER node` in the official Node.js images). Bug-Free Eureka needs no extra port, root or volume.

## PM2

```js
// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "api",
      script: "server.js",
      instances: "max", // cluster mode: one process per CPU
      exec_mode: "cluster",
      env: { NODE_ENV: "production", PORT: "3000" },
    },
  ],
};
```

Cluster mode runs several processes, so use the [shared store](#more-than-one-instance); with the in-memory store each process counts separately. PM2 itself is not a proxy: `trust proxy` depends only on the Nginx or load balancer in front.
