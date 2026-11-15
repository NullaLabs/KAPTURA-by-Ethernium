/**
 * Zero-dependency RFC 6455 WebSocket upgrade server for KAPTURA :3370.
 * Handles text control messages and continuous binary media/frame streaming.
 */
import crypto from "node:crypto";

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function encodeWsFrame(opcode, payloadBuf) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(String(payloadBuf || ""), "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function createFrameDecoder(onMessage, onClose) {
  let buf = Buffer.alloc(0);
  let fragOpcode = null;
  let fragChunks = [];

  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = Boolean(b0 & 0x80);
      const opcode = b0 & 0x0f;
      const masked = Boolean(b1 & 0x80);
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buf.length < offset + 2) return;
        payloadLen = buf.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (buf.length < offset + 8) return;
        const bigLen = buf.readBigUInt64BE(offset);
        if (bigLen > 64n * 1024n * 1024n) {
          onClose(1009, "Frame exceeds 64MB guard");
          return;
        }
        payloadLen = Number(bigLen);
        offset += 8;
      }

      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + payloadLen) return;

      let payload = Buffer.allocUnsafe(payloadLen);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        offset += 4;
        for (let i = 0; i < payloadLen; i++) {
          payload[i] = buf[offset + i] ^ mask[i & 3];
        }
      } else {
        buf.copy(payload, 0, offset, offset + payloadLen);
      }
      buf = buf.subarray(offset + payloadLen);

      if (opcode === 0x8) {
        onClose(1000, "Client closed");
        return;
      }
      if (opcode === 0x9) {
        onMessage(0x9, payload);
        continue;
      }
      if (opcode === 0x0a) continue;

      if (opcode !== 0x0) {
        fragOpcode = opcode;
        fragChunks = [payload];
      } else {
        fragChunks.push(payload);
      }

      if (fin && fragOpcode !== null) {
        const full = fragChunks.length === 1 ? fragChunks[0] : Buffer.concat(fragChunks);
        const op = fragOpcode;
        fragOpcode = null;
        fragChunks = [];
        onMessage(op, full);
      }
    }
  };
}

export function attachWebSocketServer(httpServer, onConnection) {
  const sockets = new Set();

  httpServer.on("upgrade", (req, socket) => {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const wsKey = req.headers["sec-websocket-key"];
    if (!wsKey) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const acceptKey = crypto.createHash("sha1").update(String(wsKey) + WS_MAGIC).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
    );

    let closed = false;
    sockets.add(socket);

    const peer = {
      pathname: reqUrl.pathname,
      sendJson: (obj) => {
        if (!closed && !socket.destroyed) socket.write(encodeWsFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8")));
      },
      sendBinary: (data) => {
        if (!closed && !socket.destroyed) socket.write(encodeWsFrame(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data)));
      },
      close: (code = 1000) => {
        if (closed) return;
        closed = true;
        try {
          const b = Buffer.allocUnsafe(2);
          b.writeUInt16BE(code, 0);
          if (!socket.destroyed) socket.write(encodeWsFrame(0x8, b));
          socket.end();
        } catch {}
      },
      onText: null,
      onBinary: null,
      onClose: null,
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      sockets.delete(socket);
      if (typeof peer.onClose === "function") {
        try { peer.onClose(); } catch {}
      }
    };

    const decode = createFrameDecoder(
      (opcode, payload) => {
        if (opcode === 0x9) {
          if (!closed && !socket.destroyed) socket.write(encodeWsFrame(0x0a, payload));
          return;
        }
        if (opcode === 0x1 && typeof peer.onText === "function") {
          peer.onText(payload.toString("utf8"));
        } else if (opcode === 0x2 && typeof peer.onBinary === "function") {
          peer.onBinary(payload);
        }
      },
      () => {
        cleanup();
        try { socket.end(); } catch {}
      }
    );

    socket.on("data", decode);
    socket.on("close", cleanup);
    socket.on("error", cleanup);

    onConnection(peer, reqUrl);
  });

  return {
    closeAll: () => {
      for (const s of sockets) {
        try { s.destroy(); } catch {}
      }
      sockets.clear();
    },
  };
}
