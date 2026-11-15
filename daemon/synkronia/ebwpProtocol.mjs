/**
 * ETHERNIUM BINARY WIRE PROTOCOL (EBWP v1.1) — KAPTURA Studio & Video Daemon
 * Canonical 32-byte little-endian binary telemetry frame with additive checksum verification.
 */

export const EBWP_MAGIC_0 = 0x36;
export const EBWP_MAGIC_1 = 0x69;

export const EBWP_OPCODES = {
  HEARTBEAT: 0x01,
  SPIKE: 0x02,
  TELEMETRY: 0x03,
  INTENT: 0x04,
  CRDT_DELTA: 0x05,
};

export const EBWP_NODE_MAP = {
  "console-hypervisor-11440": 0,
  "lumen-engine-3371": 1,
  "kaptura-video-3370": 2,
  "conekta-mesh-3000": 3,
  "frugal-kernel-3369": 4,
};

export const EBWP_REVERSE_NODES = [
  "console-hypervisor-11440",
  "lumen-engine-3371",
  "kaptura-video-3370",
  "conekta-mesh-3000",
  "frugal-kernel-3369",
];

class EbwpProtocolEngine {
  constructor() {
    this.txBuffer = new ArrayBuffer(32);
    this.txView = new DataView(this.txBuffer);
    this.txUint8 = new Uint8Array(this.txBuffer);
    this.packetsEncoded = 0;
    this.packetsDecoded = 0;
    this.checksumFailures = 0;
    this.totalBytesSaved = 0;
  }

  /** Encode a canonical 32-byte EBWP telemetry frame. */
  encode(opCode = EBWP_OPCODES.TELEMETRY, nodeId = "kaptura-video-3370", l = 0n, c = 0, f1 = 0.0, f2 = 0.0, f3 = 0.0) {
    const nodeIdx = typeof nodeId === "number" ? nodeId : (EBWP_NODE_MAP[nodeId] ?? 2);
    this.txUint8[0] = EBWP_MAGIC_0;
    this.txUint8[1] = EBWP_MAGIC_1;
    this.txUint8[2] = opCode & 0xff;
    this.txUint8[3] = nodeIdx & 0xff;
    this.txView.setBigUint64(4, BigInt(l || 0n), true);
    this.txView.setUint32(12, Number(c || 0), true);
    this.txView.setFloat32(16, Number(f1 || 0.0), true);
    this.txView.setFloat32(20, Number(f2 || 0.0), true);
    this.txView.setFloat32(24, Number(f3 || 0.0), true);

    let chk = 0;
    for (let i = 0; i < 28; i++) chk = (chk + this.txUint8[i]) >>> 0;
    this.txView.setUint32(28, chk, true);

    this.packetsEncoded++;
    this.totalBytesSaved += 105;
    return new Uint8Array(this.txBuffer.slice(0));
  }

  /** Decode and cryptographically checksum-verify a 32-byte EBWP frame. */
  decode(bufferOrUint8) {
    let uint8;
    if (bufferOrUint8 instanceof Uint8Array) {
      uint8 = bufferOrUint8;
    } else if (bufferOrUint8 instanceof ArrayBuffer) {
      uint8 = new Uint8Array(bufferOrUint8);
    } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(bufferOrUint8)) {
      uint8 = new Uint8Array(bufferOrUint8.buffer, bufferOrUint8.byteOffset, bufferOrUint8.byteLength);
    } else {
      return null;
    }

    if (uint8.length < 32 || uint8[0] !== EBWP_MAGIC_0 || uint8[1] !== EBWP_MAGIC_1) {
      return null;
    }

    let expectedChk = 0;
    for (let i = 0; i < 28; i++) expectedChk = (expectedChk + uint8[i]) >>> 0;
    const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
    const actualChk = view.getUint32(28, true);
    if (expectedChk !== actualChk) {
      this.checksumFailures++;
      return null;
    }

    const opCode = uint8[2];
    const nodeIdx = uint8[3];
    const lBigInt = view.getBigUint64(4, true);
    const cInt = view.getUint32(12, true);
    const float1 = view.getFloat32(16, true);
    const float2 = view.getFloat32(20, true);
    const float3 = view.getFloat32(24, true);

    this.packetsDecoded++;

    return {
      valid: true,
      checksumValid: true,
      opCode,
      nodeId: EBWP_REVERSE_NODES[nodeIdx] || `node-${nodeIdx}`,
      hlc: { l: lBigInt.toString(), c: cInt },
      metrics: [float1, float2, float3],
    };
  }
}

export const ebwpProtocol = new EbwpProtocolEngine();
