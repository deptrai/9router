#!/usr/bin/env node
// Test gRPC-web gateway với GetUserStatus (endpoint cần JWT trong metadata)
// So sánh: qua router (sk-... key) vs direct upstream

import { ProtobufEncoder, extractStrings } from "./open-sse/utils/windsurfProtobuf.js";

const ROUTER = "http://localhost:20128";
const ROUTER_KEY = "sk-seed-machine-01-aky6r2-lyvsnowp";
const UPSTREAM = "https://server.self-serve.windsurf.com";
const POOL_TOKEN = "devin-session-token$eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXNzaW9uX2lkIjoid2luZHN1cmYtc2Vzc2lvbi0xNTAwMmExMzc1YzQ0ZGYzYTgzZDg4ZTBlNzEzZTY0ZiJ9.IROhoTI4hVmPRZoN7II5wlOMGOnUg7QASLK1qDF-IqQ";

// GetUserStatus request: chỉ cần metadata (field 1) với apiKey + auth_token (JWT)
// Router sẽ tự fetch JWT và inject vào field 21
function buildGetUserStatusRequest(apiKey, jwt) {
  const meta = new ProtobufEncoder();
  meta.writeString(1, "windsurf");
  meta.writeString(2, "1.48.2");
  meta.writeString(3, apiKey);
  meta.writeString(4, "en");
  meta.writeString(7, "1.9544.35");
  if (jwt) meta.writeString(21, jwt);

  const outer = new ProtobufEncoder();
  outer.writeMessage(1, meta);
  return outer.toBuffer();
}

function encodeGrpcWeb(protoBytes) {
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(protoBytes.length, 1);
  return Buffer.concat([header, protoBytes]);
}

function parseResponse(buf) {
  const results = { trailers: [], strings: [] };
  let i = 0;
  while (i + 5 <= buf.length) {
    const flags = buf[i];
    const len = buf.readUInt32BE(i + 1);
    i += 5;
    const payload = buf.subarray(i, i + len);
    i += len;
    if (flags & 0x80) {
      results.trailers.push(payload.toString("utf-8").trim());
    } else {
      results.strings.push(...extractStrings(payload));
    }
  }
  return results;
}

const ENDPOINT = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

console.log("=== Test 1: Qua router với sk-... key (router fetch JWT + inject) ===");
{
  // Body dùng dummy apiKey + KHÔNG jwt — router sẽ replace apiKey và inject JWT
  const proto = buildGetUserStatusRequest("dummy", null);
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
  const buf = Buffer.from(await r.arrayBuffer());
  const { trailers, strings } = parseResponse(buf);
  console.log("Trailers:", trailers);
  // Tìm planName, email trong strings
  const plan = strings.find(s => /pro|free|team|enterprise/i.test(s) && s.length < 30);
  const email = strings.find(s => /@/.test(s) && s.length < 50);
  console.log("Plan:", plan || "(not found)");
  console.log("Email:", email || "(not found)");
  console.log("Sample strings:", strings.slice(0, 5));
}

console.log("\n=== Test 2: Direct upstream (control với JWT thật) ===");
{
  // Fetch JWT trước
  const { getCachedJwt } = await import("./open-sse/utils/windsurfAuth.js");
  const jwt = await getCachedJwt(POOL_TOKEN);

  const proto = buildGetUserStatusRequest(POOL_TOKEN, jwt);
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
  const { trailers, strings } = parseResponse(buf);
  console.log("Trailers:", trailers);
  const plan = strings.find(s => /pro|free|team|enterprise/i.test(s) && s.length < 30);
  const email = strings.find(s => /@/.test(s) && s.length < 50);
  console.log("Plan:", plan || "(not found)");
  console.log("Email:", email || "(not found)");
}
