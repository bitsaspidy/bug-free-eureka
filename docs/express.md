# Express adapter reference

`@bug-free-eureka/express` provides two opt-in middlewares. It is not on npm yet: inside this repository it resolves through the npm workspace after `npm run build`.

## Example

This is `examples/express-basic/app.js`, which the test suite runs (`tests/integration/docs-examples.test.ts`):

<<< @/../examples/express-basic/app.js#setup{js}

Start it with `node examples/express-basic/server.js` from the repository root. It listens on `127.0.0.1:3000` (set `PORT` to change it) and prints one audit event per request. The sixth `POST /login` from one client within a minute gets `429 Too Many Requests` with a `Retry-After` header.

<!--@include: ../packages/express/README.md{8,}-->

See the [deployment guide](/deployment) for `trust proxy`, HTTPS termination and multi-instance setups.
