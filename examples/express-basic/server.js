// Starts the example app: node examples/express-basic/server.js
import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
// createApp() trusts one proxy hop. Only expose this port to that proxy: if clients can
// reach it directly, they can forge X-Forwarded-For. Without a proxy, use createApp({ trustProxy: false }).
const host = process.env.HOST ?? "127.0.0.1"; // 0.0.0.0 only inside a container
createApp().listen(port, host, () => console.log(`listening on http://${host}:${port}`));
