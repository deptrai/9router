/**
 * gRPC-web gateway cho Devin CLI / Windsurf CLI.
 *
 * Route catch-all: POST /api/grpc/{service}/{method}
 *   vd: /api/grpc/exa.api_server_pb.ApiServerService/GetDevstralStream
 *       /api/grpc/exa.auth_pb.AuthService/GetUserJwt
 *       /api/grpc/exa.seat_management_pb.SeatManagementService/GetUserStatus
 *
 * Flow:
 *   Devin CLI ──gRPC-web──→ /api/grpc/...
 *     └── auth: Bearer sk-... (router API key) → pick windsurf token từ pool
 *     └── parse gRPC-web frame → inject pool token vào protobuf metadata (field 3)
 *     └── forward lên server.self-serve.windsurf.com/exa.{service}/{method}
 *     └── stream response về Devin CLI
 *
 * Set trong Devin CLI:
 *   WINDSURF_API_SERVER_URL=https://router.chainlens.net/api/grpc
 *
 * Force-dynamic: route phụ thuộc DB pool (session-dependent) — không static.
 */

import "open-sse/index.js";
import { getProviderCredentials, extractApiKey, isValidApiKey } from "@/sse/services/auth.js";
import { getCachedJwt, invalidateJwt } from "open-sse/utils/windsurfAuth.js";
import { ProtobufEncoder, decodeVarint } from "open-sse/utils/windsurfProtobuf.js";
import { gunzipSync, gzipSync } from "node:zlib";

// Upstream base — Devin CLI mặc định trỏ về server.codeium.com,
// nhưng 9router executor dùng server.self-serve.windsurf.com (cùng backend).
// Cho phép override qua env nếu cần.
const UPSTREAM_BASE = process.env.GRPC_UPSTREAM_BASE || "https://server.self-serve.windsurf.com";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// gRPC-web trailer marker (field 7 trong end-of-stream frame)
const GRPC_WEB_TRAILER = 0x80;

/**
 * Parse gRPC-web frame: [1 byte flags][4 bytes BE length][payload]
 * Trả về mảng {flags, payload} frames.
 */
function parseGrpcWebFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const flags = buf[i];
    const length = buf.readUInt32BE(i + 1);
    i += 5;
    if (i + length > buf.length) {
      // Truncated — best-effort: lấy phần còn lại
      frames.push({ flags, payload: Buffer.from(buf.subarray(i)) });
      break;
    }
    frames.push({ flags, payload: Buffer.from(buf.subarray(i, i + length)) });
    i += length;
  }
  return frames;
}

/**
 * Encode lại thành gRPC-web stream bytes.
 */
function encodeGrpcWebFrame(flags, payload) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/**
 * Decompress payload nếu flags bit 0 = 1 (gzip).
 */
function maybeDecompress(flags, payload) {
  if (flags & 1) {
    try { return gunzipSync(payload); } catch { return payload; }
  }
  return payload;
}

/**
 * Compress payload nếu flags bit 0 = 1.
 */
function maybeCompress(flags, payload) {
  if (flags & 1) {
    try { return gzipSync(payload); } catch { return payload; }
  }
  return payload;
}

/**
 * Inject apiKey + JWT vào protobuf metadata message.
 *
 * Windsurf/Devin protobuf wire format (metadata là field 1 của outer message):
 *   metadata {
 *     1: ideName (string)
 *     2: ideVersion (string)
 *     3: apiKey (string)         ← thay bằng pool token
 *     4: language (string)
 *     7: extensionVersion (string)
 *     21: auth_token (string)    ← inject JWT
 *     ...
 *   }
 *
 * Strategy: parse outer message, tìm sub-message field 1 (metadata),
 * trong metadata tìm field 3 (apiKey) → replace value.
 * Nếu không tìm thấy → append field 3 vào metadata.
 *
 * Return: Buffer protobuf mới (chưa frame, chưa compress).
 */
function injectTokenIntoMetadata(protoBytes, poolApiKey, jwt) {
  // Parse outer message: lặp qua các field, tìm field 1 (wire type 2 = length-delimited)
  const out = [];
  let i = 0;
  let foundMetadata = false;

  while (i < protoBytes.length) {
    const [tag, afterTag] = decodeVarint(protoBytes, i);
    const field = tag >>> 3;
    const wire = tag & 0x7;
    i = afterTag;

    if (wire === 2) {
      const [len, afterLen] = decodeVarint(protoBytes, i);
      i = afterLen;
      const subBuf = protoBytes.subarray(i, i + len);
      i += len;

      if (field === 1) {
        // metadata sub-message — inject token
        foundMetadata = true;
        const injected = injectApiKeyInMetadata(subBuf, poolApiKey, jwt);
        out.push(encodeField(1, 2, injected));
      } else {
        // Giữ nguyên field khác
        out.push(encodeField(field, wire, subBuf));
      }
    } else if (wire === 0) {
      const [val, after] = decodeVarint(protoBytes, i);
      i = after;
      out.push(encodeVarintField(field, val));
    } else if (wire === 1) {
      const val = protoBytes.subarray(i, i + 8);
      i += 8;
      out.push(encodeField(field, wire, val));
    } else if (wire === 5) {
      const val = protoBytes.subarray(i, i + 4);
      i += 4;
      out.push(encodeField(field, wire, val));
    } else {
      // Unknown wire — copy rest
      out.push(protoBytes.subarray(i));
      break;
    }
  }

  // Nếu outer message không có field 1 (metadata) → append mới
  if (!foundMetadata) {
    const meta = new ProtobufEncoder();
    meta.writeString(1, "windsurf");
    meta.writeString(2, process.env.WS_APP_VER || "1.48.2");
    meta.writeString(3, poolApiKey);
    meta.writeString(4, "en");
    if (jwt) meta.writeString(21, jwt);
    out.push(encodeField(1, 2, meta.toBuffer()));
  }

  return Buffer.concat(out);
}

/**
 * Inject apiKey (field 3) + JWT (field 21) vào metadata sub-message.
 * Replace nếu đã có, append nếu chưa.
 */
function injectApiKeyInMetadata(metaBytes, poolApiKey, jwt) {
  const out = [];
  let i = 0;
  let foundApiKey = false;
  let foundJwt = false;

  while (i < metaBytes.length) {
    const [tag, afterTag] = decodeVarint(metaBytes, i);
    const field = tag >>> 3;
    const wire = tag & 0x7;
    i = afterTag;

    if (wire === 2) {
      const [len, afterLen] = decodeVarint(metaBytes, i);
      i = afterLen;
      const val = metaBytes.subarray(i, i + len);
      i += len;

      if (field === 3) {
        foundApiKey = true;
        out.push(encodeField(3, 2, Buffer.from(poolApiKey, "utf-8")));
      } else if (field === 21) {
        foundJwt = true;
        if (jwt) out.push(encodeField(21, 2, Buffer.from(jwt, "utf-8")));
        // Nếu không có jwt → bỏ field 21 (client tự auth bằng apiKey)
      } else {
        out.push(encodeField(field, wire, val));
      }
    } else if (wire === 0) {
      const [val, after] = decodeVarint(metaBytes, i);
      i = after;
      out.push(encodeVarintField(field, val));
    } else if (wire === 1) {
      const val = metaBytes.subarray(i, i + 8);
      i += 8;
      out.push(encodeField(field, wire, val));
    } else if (wire === 5) {
      const val = metaBytes.subarray(i, i + 4);
      i += 4;
      out.push(encodeField(field, wire, val));
    } else {
      out.push(metaBytes.subarray(i));
      break;
    }
  }

  if (!foundApiKey) {
    out.push(encodeField(3, 2, Buffer.from(poolApiKey, "utf-8")));
  }
  if (!foundJwt && jwt) {
    out.push(encodeField(21, 2, Buffer.from(jwt, "utf-8")));
  }

  return Buffer.concat(out);
}

function encodeField(field, wire, value) {
  const tag = encodeVarint((field << 3) | wire);
  if (wire === 2) {
    return Buffer.concat([tag, encodeVarint(value.length), value]);
  }
  return Buffer.concat([tag, value]);
}

function encodeVarintField(field, value) {
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(value)]);
}

function encodeVarint(value) {
  const bytes = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

/**
 * Map path `/exa.api_server_pb.ApiServerService/GetDevstralStream` → upstream URL.
 * Hỗ trợ cả path có/prefix "exa." hoặc không.
 */
function buildUpstreamUrl(pathSegments) {
  const path = pathSegments.join("/");
  // Path đã có dạng "exa.service/method" → ghép thẳng
  return `${UPSTREAM_BASE}/${path}`;
}

/**
 * CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "*",
    },
  });
}

/**
 * POST handler — gRPC-web proxy với token injection.
 */
export async function POST(request, { params }) {
  const { path: pathSegments } = await params;
  const upstreamUrl = buildUpstreamUrl(pathSegments);

  // 1. Auth: lấy API key từ header
  const clientApiKey = extractApiKey(request);
  if (!clientApiKey) {
    return grpcErrorResponse(1, "UNAUTHENTICATED", "Missing API key");
  }

  // 2. Validate router API key (sk-...) — cho phép cả devin-session-token$ passthrough
  const isRouterKey = await isValidApiKey(clientApiKey);
  let poolToken = null;
  let jwt = null;

  if (isRouterKey) {
    // Router API key → pick windsurf token từ pool
    const creds = await getProviderCredentials("windsurf");
    if (!creds || creds.ownedOnlyUnavailable) {
      return grpcErrorResponse(1, "UNAVAILABLE", "No windsurf provider connection in pool");
    }
    poolToken = creds.apiKey;
    if (!poolToken) {
      return grpcErrorResponse(1, "UNAVAILABLE", "Pool connection has no apiKey");
    }

    // Fetch JWT cho pool token (cần cho các endpoint yêu cầu auth_token)
    // GetUserJwt thì không cần JWT (chính nó là lấy JWT), bỏ qua cho endpoint đó
    const isGetUserJwt = pathSegments.some(p => p === "GetUserJwt");
    if (!isGetUserJwt) {
      try {
        jwt = await getCachedJwt(poolToken);
      } catch (e) {
        return grpcErrorResponse(2, "UNAUTHENTICATED", `Failed to fetch JWT: ${e.message}`);
      }
    }
  } else if (clientApiKey.startsWith("devin-session-token$")) {
    // Passthrough: client dùng token của chính nó, không qua pool
    poolToken = clientApiKey;
    const isGetUserJwt = pathSegments.some(p => p === "GetUserJwt");
    if (!isGetUserJwt) {
      try {
        jwt = await getCachedJwt(poolToken);
      } catch (e) {
        return grpcErrorResponse(2, "UNAUTHENTICATED", `Failed to fetch JWT: ${e.message}`);
      }
    }
  } else {
    return grpcErrorResponse(1, "UNAUTHENTICATED", "Invalid API key (expected sk-... or devin-session-token$...)");
  }

  // 3. Read body bytes
  const bodyBuf = Buffer.from(await request.arrayBuffer());
  if (bodyBuf.length === 0) {
    return grpcErrorResponse(3, "INVALID_ARGUMENT", "Empty body");
  }

  // 4. Parse gRPC-web frames, inject token, re-encode
  const frames = parseGrpcWebFrames(bodyBuf);
  const outFrames = frames.map(({ flags, payload }) => {
    // Skip trailer frames (flags bit 7 = 1)
    if (flags & GRPC_WEB_TRAILER) {
      return encodeGrpcWebFrame(flags, payload);
    }
    // Decompress nếu cần
    const decompressed = maybeDecompress(flags, payload);
    // Inject token vào protobuf metadata
    const injected = injectTokenIntoMetadata(decompressed, poolToken, jwt);
    // Compress lại nếu frame gốc compressed
    const recompressed = maybeCompress(flags, injected);
    return encodeGrpcWebFrame(flags, recompressed);
  });

  const outBody = Buffer.concat(outFrames);

  // 5. Forward lên upstream
  const upstreamHeaders = {
    "Content-Type": request.headers.get("Content-Type") || "application/grpc-web+proto",
    "Connect-Protocol-Version": request.headers.get("Connect-Protocol-Version") || "1",
    "User-Agent": request.headers.get("User-Agent") || "connect-go/1.18.1",
    "Accept-Encoding": "gzip",
  };

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: outBody,
      signal: AbortSignal.timeout(300000), // 5 min cho streaming
    });
  } catch (e) {
    return grpcErrorResponse(14, "UNAVAILABLE", `Upstream fetch failed: ${e.message}`);
  }

  // 6. Nếu 401 từ upstream → invalidate JWT cache, trả error
  if (upstreamResp.status === 401) {
    invalidateJwt(poolToken);
    return grpcErrorResponse(16, "UNAUTHENTICATED", "Upstream rejected token (JWT invalid)");
  }

  // 7. Stream response về client — giữ nguyên content-type, headers, body stream
  const respHeaders = new Headers();
  respHeaders.set("Content-Type", upstreamResp.headers.get("Content-Type") || "application/grpc-web+proto");
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("Access-Control-Expose-Headers", "*");
  // Copy grpc-status/trailer headers nếu có
  for (const [k, v] of upstreamResp.headers.entries()) {
    if (k.startsWith("grpc-") || k.startsWith("x-")) {
      respHeaders.set(k, v);
    }
  }

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}

/**
 * Trả gRPC-web error response (trailer frame với grpc-status + grpc-message).
 */
function grpcErrorResponse(status, code, message) {
  const trailer = Buffer.from(`grpc-status: ${status}\r\ngrpc-message: ${message}\r\n`);
  const frame = encodeGrpcWebFrame(GRPC_WEB_TRAILER, trailer);
  return new Response(frame, {
    status: 200, // gRPC-web luôn HTTP 200, error trong trailer
    headers: {
      "Content-Type": "application/grpc-web+proto",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
    },
  });
}
