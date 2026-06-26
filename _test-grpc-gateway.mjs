#!/usr/bin/env node
// Test gRPC-web gateway: gọi /api/grpc/exa.auth_pb.AuthService/GetUserJwt
// qua router với sk-... key, router sẽ inject pool token và forward lên upstream.
//
// So sánh:
//   1. Qua router (sk-... key) → router inject pool token
//   2. Direct upstream (devin-session-token$...) → control

import { ProtobufEncoder } from "./open-sse/utils/windsurfProtobuf.js";
import { gzipSync } from "node:zlib";

const ROUTER = "http://localhost:20128";
const ROUTER_KEY = "sk-seed-machine-01-aky6r2-lyvsnowp";
const UPSTREAM = "https://server.self-serve.windsurf.com";
const POOL_TOKEN = "devin-session-token$eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXNzaW9uX2lkIjoid2luZHN1cmYtc2Vzc2lvbi0xNTAwMmExMzc1YzQ0ZGYzYTgzZDg4ZTBlNzEzZTY0ZiJ9.IROhoTI4hVmPRZoN7II5wlOMGOnUg7QASLK1qDF-IqQ";

// Build GetUserJwt request protobuf (giống windsurfAuth.js fetchJwt)
function buildGetUserJwtRequest(apiKey) {
  const meta = new ProtobufEncoder();
  meta.writeString(1, "windsurf");
  meta.writeString(2, "1.48.2");
  meta.writeString(3, apiKey);
  meta.writeString(4, "en");
  meta.writeString(7, "1.9544.35");
  meta.writeString(12, "windsurf");
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));

  const outer = new ProtobufEncoder();
  outer.writeMessage(1, meta);
  return outer.toBuffer();
}

// Encode gRPC-web frame (uncompressed)
function encodeGrpcWeb(protoBytes) {
  const header = Buffer.alloc(5);
  header[0] = 0; // no compression
  header.writeUInt32BE(protoBytes.length, 1);
  return Buffer.concat([header, protoBytes]);
}

const ENDPOINT = "/exa.auth_pb.AuthService/GetUserJwt";

console.log("=== Test 1: Qua router với sk-... key (pool injection) ===");
{
  // Body dùng dummy apiKey — router sẽ replace bằng pool token
  const proto = buildGetUserJwtRequest("dummy-will-be-replaced");
  const frame = encodeGrpcWeb(proto);

  const r = await fetch(`${ROUTER}/api/grpc${ENDPOINT}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/grpc-web+proto",
      "Connect-Protocol-Version": "1",
      "Authorization": `Bearer ${ROUTER_KEY}`,
    },
    body: frame,
  });

  console.log("HTTP:", r.status);
  console.log("Content-Type:", r.headers.get("Content-Type"));
  const buf = Buffer.from(await r.arrayBuffer());
  console.log("Body length:", buf.length);

  // Parse gRPC-web response frames
  let i = 0;
  while (i + 5 <= buf.length) {
    const flags = buf[i];
    const len = buf.readUInt32BE(i + 1);
    i += 5;
    const payload = buf.subarray(i, i + len);
    i += len;

    if (flags & 0x80) {
      // Trailer
      console.log("Trailer:", payload.toString("utf-8").trim());
    } else {
      // Data frame — extract strings để xem JWT
      const { extractStrings } = await import("./open-sse/utils/windsurfProtobuf.js");
      const strings = extractStrings(payload);
      const jwt = strings.find(s => s.startsWith("eyJ") && s.includes("."));
      if (jwt) {
        console.log("✓ Got JWT, prefix:", jwt.substring(0, 40));
        console.log("  JWT length:", jwt.length);
      } else {
        console.log("Data frame strings:", strings.slice(0, 3));
      }
    }
  }
}

console.log("\n=== Test 2: Direct upstream (control) ===");
{
  const proto = buildGetUserJwtRequest(POOL_TOKEN);
  const frame = encodeGrpcWeb(proto);

  const r = await fetch(`${UPSTREAM}${ENDPOINT}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/grpc-web+proto",
      "Connect-Protocol-Version": "1",
    },
    body: frame,
  });

  console.log("HTTP:", r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  console.log("Body length:", buf.length);

  let i = 0;
  while (i + 5 <= buf.length) {
    const flags = buf[i];
    const len = buf.readUInt32BE(i + 1);
    i += 5;
    const payload = buf.subarray(i, i + len);
    i += len;

    if (flags & 0x80) {
      console.log("Trailer:", payload.toString("utf-8").trim());
    } else {
      const { extractStrings } = await import("./open-sse/utils/windsurfProtobuf.js");
      const strings = extractStrings(payload);
      const jwt = strings.find(s => s.startsWith("eyJ") && s.includes("."));
      if (jwt) {
        console.log("✓ Got JWT, prefix:", jwt.substring(0, 40));
      }
    }
  }
}

console.log("\n=== Test 3: Qua router với devin-session-token$ passthrough ===");
{
  const proto = buildGetUserJwtRequest("dummy");
  const frame = encodeGrpcWeb(proto);

  const r = await fetch(`${ROUTER}/api/grpc${ENDPOINT}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/grpc-web+proto",
      "Connect-Protocol-Version": "1",
      "Authorization": `Bearer ${POOL_TOKEN}`,
    },
    body: frame,
  });

  console.log("HTTP:", r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  let i = 0;
  while (i + 5 <= buf.length) {
    const flags = buf[i];
    const len = buf.readUInt32BE(i + 1);
    i += 5;
    const payload = buf.subarray(i, i + len);
    i += len;
    if (flags & 0x80) {
      console.log("Trailer:", payload.toString("utf-8").trim());
    } else {
      const { extractStrings } = await import("./open-sse/utils/windsurfProtobuf.js");
      const strings = extractStrings(payload);
      const jwt = strings.find(s => s.startsWith("eyJ") && s.includes("."));
      if (jwt) console.log("✓ Got JWT, prefix:", jwt.substring(0, 40));
    }
  }
}
