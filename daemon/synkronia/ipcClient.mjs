/**
 * SYNKRONIA IPC CLIENT v2.0 — Event-Driven Backoff WebSocket Client for KAPTURA
 * Connects silently when Synkronia SNN hub (:8765) is available and backs off cleanly offline.
 */

import http from "node:http";
import { ebwpProtocol, EBWP_MAGIC_0, EBWP_MAGIC_1 } from "./ebwpProtocol.mjs";

const MSG_HEARTBEAT = 0x01;
const MSG_TELEMETRY = 0x03;
const MSG_NODE_ANNOUNCE = 0x04;

const INITIAL_RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 2500;

function encodeClientFrame(data, opcode = 0x02) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const len = payload.length;

  let headerLen = 2;
  if (len >= 126 && len < 65536) headerLen = 4;
  else if (len >= 65536) headerLen = 10;

  const frame = Buffer.alloc(headerLen + 4 + len);
  frame[0] = 0x80 | opcode;
  let offset = 1;

  if (len < 126) {
    frame[offset++] = 0x80 | len;
  } else if (len < 65536) {
    frame[offset++] = 0x80 | 126;
    frame.writeUInt16BE(len, offset);
    offset += 2;
  } else {
    frame[offset++] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), offset);
    offset += 8;
  }

  const mask = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) mask[i] = Math.floor(Math.random() * 256);
  mask.copy(frame, offset);
  offset += 4;

  for (let i = 0; i < len; i++) {
    frame[offset + i] = payload[i] ^ mask[i & 3];
  }
  return frame;
}

function decodeServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let payloadLen = buffer[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  if (buffer.length < offset + payloadLen) return null;
  const payload = buffer.subarray(offset, offset + payloadLen);
  return { opcode, payload, totalLength: offset + payloadLen };
}

function buildMessage(type, hlcEngine, jsonPayload = null) {
  const hlcBin = hlcEngine.toBinary();
  const typeBuf = Buffer.alloc(1);
  typeBuf[0] = type;
  const parts = [typeBuf, Buffer.from(hlcBin)];
  if (jsonPayload) {
    parts.push(Buffer.from(JSON.stringify(jsonPayload), "utf8"));
  }
  return Buffer.concat(parts);
}

function parseMessage(buf) {
  if (buf.length === 32 && buf[0] === EBWP_MAGIC_0 && buf[1] === EBWP_MAGIC_1) {
    const decoded = ebwpProtocol.decode(buf);
    if (decoded && decoded.valid) {
      return {
        type: decoded.opCode,
        hlc: decoded.hlc,
        payload: { isEbwp: true, metrics: decoded.metrics, nodeId: decoded.nodeId },
      };
    }
  }

  if (buf.length < 21) return null;
  const type = buf[0];
  const hlcView = new DataView(buf.buffer, buf.byteOffset + 1, 20);
  const hlc = {
    l: hlcView.getBigUint64(0, true).toString(),
    c: hlcView.getUint32(8, true),
    wallMs: hlcView.getFloat64(12, true),
  };
  let payload = null;
  if (buf.length > 21) {
    try {
      payload = JSON.parse(buf.subarray(21).toString("utf8"));
    } catch {
      payload = null;
    }
  }
  return { type, hlc, payload };
}

export function createIpcClient({ hlcEngine, hubUrl = "ws://127.0.0.1:8765", nodeId = "kaptura-video-3370" }) {
  let socket = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let connected = false;
  let closed = false;
  let reconnectDelay = INITIAL_RECONNECT_MS;
  let lastMeshSnapshot = null;

  function cleanup() {
    connected = false;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (socket) {
      try { socket.destroy(); } catch {}
      socket = null;
    }
  }

  function scheduleReconnect() {
    if (closed || connected || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(MAX_RECONNECT_MS, reconnectDelay * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed && !connected) connect();
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function connect() {
    if (closed) return;
    const parsed = new URL(`${hubUrl}?nodeId=${encodeURIComponent(nodeId)}`);
    const host = parsed.hostname;
    const port = parseInt(parsed.port, 10) || 80;
    const reqPath = parsed.pathname + parsed.search;

    const wsKey = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) wsKey[i] = Math.floor(Math.random() * 256);

    const req = http.request({
      host,
      port,
      path: reqPath,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": wsKey.toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });

    req.on("response", (res) => {
      if (res.statusCode !== 101) {
        cleanup();
        scheduleReconnect();
      }
    });

    req.on("upgrade", (_res, sock) => {
      socket = sock;
      connected = true;
      reconnectDelay = INITIAL_RECONNECT_MS;
      console.log(`[SYNKRONIA IPC] Connected to hub as "${nodeId}"`);

      const announce = buildMessage(MSG_NODE_ANNOUNCE, hlcEngine, { nodeId });
      sock.write(encodeClientFrame(announce, 0x02));

      heartbeatTimer = setInterval(() => {
        if (!connected) return;
        try {
          const hb = buildMessage(MSG_HEARTBEAT, hlcEngine);
          sock.write(encodeClientFrame(hb, 0x02));
        } catch {
          cleanup();
          scheduleReconnect();
        }
      }, HEARTBEAT_INTERVAL_MS);
      if (heartbeatTimer.unref) heartbeatTimer.unref();

      let buffer = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          const frame = decodeServerFrame(buffer);
          if (!frame) break;
          buffer = buffer.subarray(frame.totalLength);

          if (frame.opcode === 0x08) {
            cleanup();
            scheduleReconnect();
            return;
          }
          if (frame.opcode === 0x09) {
            try { sock.write(encodeClientFrame(frame.payload, 0x0a)); } catch {}
            continue;
          }
          if (frame.opcode === 0x01 || frame.opcode === 0x02) {
            const msg = parseMessage(frame.payload);
            if (!msg) continue;
            if (msg.hlc) hlcEngine.receive(msg.hlc);
            if (msg.type === MSG_TELEMETRY && msg.payload) {
              lastMeshSnapshot = msg.payload;
            }
          }
        }
      });

      sock.on("close", () => { cleanup(); scheduleReconnect(); });
      sock.on("error", () => { cleanup(); scheduleReconnect(); });
    });

    req.on("error", () => { cleanup(); scheduleReconnect(); });
    req.end();
  }

  connect();

  return {
    isConnected: () => connected,
    getMeshSnapshot: () => lastMeshSnapshot,
    getNodeId: () => nodeId,
    close: () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      cleanup();
    },
  };
}
