import { createServer } from "node:http";
import { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

const mode = process.argv[2];
const server = createServer();
const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const stream = Duplex.from({ readable: process.stdin, writable: process.stdout });
server.on("upgrade", (request, socket, head) => {
  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    const send = (message) => websocket.send(JSON.stringify(message));
    if (mode === "stalled-input") process.stdin.pause();
    if (mode === "malformed") websocket.send('{"invalid":]');
    if (mode === "oversized") websocket.send("x".repeat(8 * 1024 * 1024 + 1));
    if (mode === "unterminated") {
      socket.write(Buffer.from([0x81, 0x7e, 0x01, 0x00, 0x7b]));
      socket.end();
    }
    if (mode === "stderr") {
      process.stderr.write(`${"x".repeat(20 * 1024)}native failure diagnostic`);
      setTimeout(() => process.exit(1), 20);
    }
    let first;
    websocket.on("message", (frame) => {
      const message = JSON.parse(frame.toString());
      if (message.method === "first") first = message;
      else if (message.method === "second") {
        send({ id: message.id, result: "second response" });
        send({ method: "notice", params: { live: true } });
        send({ method: "approval", id: "native-1", params: { command: "pwd" } });
        send({ id: first.id, result: "first response" });
      } else if (message.method === "failure") {
        send({ id: message.id, error: { code: -32001, message: "native rejection" } });
      } else if (message.method === "identity") {
        send({
          id: message.id,
          result: {
            pid: process.pid,
            env: process.env.BRIDGE_RPC_TEST,
            inherited: process.env.BRIDGE_RPC_PARENT,
          },
        });
      } else if (message.method === "slow") {
        setTimeout(() => send({ id: message.id, result: "late response" }), 15_100);
      } else if (message.method === "fragmented") {
        const frame = Buffer.from(JSON.stringify({ id: message.id, result: "a🌲z" }));
        const split = frame.indexOf(Buffer.from("🌲")) + 1;
        websocket.send(frame.subarray(0, split), { binary: false, fin: false });
        setTimeout(() => websocket.send(frame.subarray(split), { binary: false, fin: true }), 10);
      } else if (message.method === "client-notification") {
        send({ method: "notified", params: message });
      } else if (!message.method) send({ method: "answered", params: message });
    });
  });
});
server.emit("connection", stream);
