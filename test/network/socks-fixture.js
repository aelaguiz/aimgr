import net from "node:net";
import { once } from "node:events";
import { SocksClient } from "socks";

export async function listen(server, host = "127.0.0.1", port = 0) {
  server.listen(port, host);
  await once(server, "listening");
  return server.address().port;
}

// Only synthetic hosts are reachable. Separate source addresses let the mock
// origin observe which route actually delivered each request.
export async function startSocks({ sourceAddress = "127.0.0.2", destinations, port = 0, forwardSocks = null, forwardHosts = [] }) {
  const sockets = new Set();
  const receipts = [];
  let pausedForward = false;
  const pending = new Map(), forwarded = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); pending.delete(socket); forwarded.delete(socket); });
    socket.on("error", () => {});
    let phase = "greeting";
    let buffer = Buffer.alloc(0);
    const onData = (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (phase === "greeting") {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 0]));
        phase = "connect";
      }
      if (phase !== "connect" || buffer.length < 5) return;
      const type = buffer[3];
      const length = type === 3 ? 7 + buffer[4] : type === 1 ? 10 : 22;
      if (buffer.length < length) return;
      const host = type === 3 ? buffer.subarray(5, 5 + buffer[4]).toString()
        : type === 1 ? [...buffer.subarray(4, 8)].join(".") : "ipv6";
      const destinationPort = buffer.readUInt16BE(length - 2);
      receipts.push({ host, port: destinationPort });
      const target = destinations[host];
      const forward = !target && forwardSocks && forwardHosts.includes(host);
      if ((!target && !forward) || destinationPort === 0 || buffer[1] !== 1) {
        socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      phase = "stream";
      socket.removeListener("data", onData);
      socket.pause();
      const connect = async () => {
        if (socket.destroyed) return;
        let upstream;
        try {
          upstream = forward ? (await SocksClient.createConnection({ proxy: { ...forwardSocks, type: 5 }, command: "connect",
            destination: { host, port: destinationPort }, timeout: 8000 })).socket
            : net.connect({ host: "127.0.0.1", port: target, localAddress: sourceAddress });
        } catch { socket.destroy(); return; }
        if (socket.destroyed) { upstream.destroy(); return; }
        sockets.add(upstream);
        upstream.on("close", () => sockets.delete(upstream));
        upstream.on("error", () => socket.destroy());
        socket.on("close", () => upstream.destroy());
        upstream.on("close", () => socket.destroy());
        const connected = () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (buffer.length > length) upstream.write(buffer.subarray(length));
          socket.pipe(upstream).pipe(socket);
      };
      if (upstream.connecting) upstream.once("connect", connected); else connected();
      };
      if (forward) forwarded.add(socket);
      if (forward && pausedForward) pending.set(socket, connect); else void connect();
    };
    socket.on("data", onData);
  });
  const actualPort = await listen(server, "127.0.0.1", port);
  return {
    port: actualPort, receipts,
    pauseForward() {
      pausedForward = true;
      for (const socket of forwarded) socket.destroy();
    },
    resumeForward() {
      pausedForward = false;
      const waiting = [...pending.values()];pending.clear();
      for (const connect of waiting) void connect();
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}
