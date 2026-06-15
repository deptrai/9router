#!/usr/bin/env node
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(path.join(projectRoot, ".env"));
loadEnvFile(path.join(projectRoot, ".env.local"));

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = path.join(process.env.HOME || "~", ".9router");
}

const { default: BetterSqlite3 } = await import("better-sqlite3");

const dbDir = path.join(process.env.DATA_DIR, "db");
const dbFile = path.join(dbDir, "data.sqlite");

if (!fs.existsSync(dbFile)) {
  console.error("DB not found at", dbFile);
  process.exit(1);
}

const db = new BetterSqlite3(dbFile);

function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function now() {
  return new Date().toISOString();
}

const kiroData = {
  type: "kiro",
  access_token: "aoaAAAAAGousXAyTAZ433V7QygOQbujQXehod9dPfbvG6gQqVVZa-cpXwo3BUME9rczOeVAjp_qptnZzxHAg9JZNICkc0:MGYCMQD48HA8XszGkud3noUByCB9MyEZ0fWCFfT831R15liovI1CNy2p+ntFCqsETToWUOwCMQDprzuX2s8WGoHo5yUcV+C6Af8m2dbU9UpPsFg8QK73KjTvB3X/pTW/fEcn+Tedqys",
  refresh_token: "aorAAAAAGqlSQ0stnZmF5sktILa1OvI_0aZ6t_m-u6XPfPB_lCob5jZ6_r5fpzrRapWvzFIAnf0E0dONKAQN1guLICkc0:MGQCMEUFZMQgeC+FxBYB3qHZ4s2TIsldy3hOJtgqxsyHBnfA3uSnAovS9GmjhdSbHRxebgIwAOhk17pp82gnYo5PygPVOq3xhyD68w1Zt2wF50hL6AAknYshd5PKf7ew3Cn4ssbS",
  expires_in: 3600,
  expires_at: "2026-06-14T13:49:37.592Z",
  profile_arn: "arn:aws:codewhisperer:us-east-1:026177432232:profile/D4G9RHAAAPWV",
  client_id: "sbhsQRrGmJu5VC-g_X9xinVzLWVhc3QtMQ",
  client_secret: "eyJraWQiOiJrZXktMTU2NDAyODA5OSIsImFsZyI6IkhTMzg0In0.eyJzZXJpYWxpemVkIjoie1wiY2xpZW50SWRcIjp7XCJ2YWx1ZVwiOlwic2Joc1FSckdtSnU1VkMtZ19YOXhpblZ6TFdWaGMzUXRNUVwifSxcImlkZW1wb3RlbnRLZXlcIjpudWxsLFwidGVuYW50SWRcIjpudWxsLFwiY2xpZW50TmFtZVwiOlwia2lyby1vYXV0aC1jbGllbnRcIixcImJhY2tmaWxsVmVyc2lvblwiOm51bGwsXCJjbGllbnRUeXBlXCI6XCJQVUJMSUNcIixcInRlbXBsYXRlQXJuXCI6bnVsbCxcInRlbXBsYXRlQ29udGV4dFwiOm51bGwsXCJleHBpcmF0aW9uVGltZXN0YW1wXCI6MTc4OTIxNzM2Ni43MzAyMDMwODIsXCJjcmVhdGVkVGltZXN0YW1wXCI6MTc4MTQ0MTM2Ni43MzAyMDMwODIsXCJ1cGRhdGVkVGltZXN0YW1wXCI6MTc4MTQ0MTM2Ni43MzAyMDMwODIsXCJjcmVhdGVkQnlcIjpudWxsLFwidXBkYXRlZEJ5XCI6bnVsbCxcInN0YXR1c1wiOm51bGwsXCJpbml0aWF0ZUxvZ2luVXJpXCI6bnVsbCxcImVudGl0bGVkUmVzb3VyY2VJZFwiOm51bGwsXCJlbnRpdGxlZFJlc291cmNlQ29udGFpbmVySWRcIjpudWxsLFwiZXh0ZXJuYWxJZFwiOm51bGwsXCJzb2Z0d2FyZUlkXCI6bnVsbCxcInNjb3Blc1wiOlt7XCJmdWxsU2NvcGVcIjpcImNvZGV3aGlzcGVyZXI6Y29tcGxldGlvbnNcIixcInN0YXR1c1wiOlwiSU5JVElBTFwiLFwiYXBwbGljYXRpb25Bcm5cIjpudWxsLFwiZnJpZW5kbHlJZFwiOlwiY29kZXdoaXNwZXJlclwiLFwidXNlQ2FzZUFjdGlvblwiOlwiY29tcGxldGlvbnNcIixcInNjb3BlVHlwZVwiOlwiQUNDRVNTX1NDT1BFXCIsXCJ0eXBlXCI6XCJJbW11dGFibGVBY2Nlc3NTY29wZVwifSx7XCJmdWxsU2NvcGVcIjpcImNvZGV3aGlzcGVyZXI6YW5hbHlzaXNcIixcInN0YXR1c1wiOlwiSU5JVElBTFwiLFwiYXBwbGljYXRpb25Bcm5cIjpudWxsLFwiZnJpZW5kbHlJZFwiOlwiY29kZXdoaXNwZXJlclwiLFwidXNlQ2FzZUFjdGlvblwiOlwiYW5hbHlzaXNcIixcInNjb3BlVHlwZVwiOlwiQUNDRVNTX1NDT1BFXCIsXCJ0eXBlXCI6XCJJbW11dGFibGVBY2Nlc3NTY29wZVwifSx7XCJmdWxsU2NvcGVcIjpcImNvZGV3aGlzcGVyZXI6Y29udmVyc2F0aW9uc1wiLFwic3RhdHVzXCI6XCJJTklUSUFMXCIsXCJhcHBsaWNhdGlvbkFyblwiOm51bGwsXCJmcmllbmRseUlkXCI6XCJjb2Rld2hpc3BlcmVyXCIsXCJ1c2VDYXNlQWN0aW9uXCI6XCJjb252ZXJzYXRpb25zXCIsXCJzY29wZVR5cGVcIjpcIkFDQ0VTU19TQ09QRVwiLFwidHlwZVwiOlwiSW1tdXRhYmxlQWNjZXNzU2NvcGVcIn1dLFwiYXV0aGVudGljYXRpb25Db25maWd1cmF0aW9uXCI6bnVsbCxcInNoYWRvd0F1dGhlbnRpY2F0aW9uQ29uZmlndXJhdGlvblwiOm51bGwsXCJlbmFibGVkR3JhbnRzXCI6bnVsbCxcImVuZm9yY2VBdXRoTkNvbmZpZ3VyYXRpb25cIjpudWxsLFwib3duZXJBY2NvdW50SWRcIjpudWxsLFwic3NvSW5zdGFuY2VBY2NvdW50SWRcIjpudWxsLFwidXNlckNvbnNlbnRcIjpudWxsLFwibm9uSW50ZXJhY3RpdmVTZXNzaW9uc0VuYWJsZWRcIjpudWxsLFwiYXNzb2NpYXRlZEluc3RhbmNlQXJuXCI6bnVsbCxcImdyb3VwU2NvcGVzQnlGcmllbmRseUlkXCI6e1wiY29kZXdoaXNwZXJlclwiOlt7XCJmdWxsU2NvcGVcIjpcImNvZGV3aGlzcGVyZXI6Y29udmVyc2F0aW9uc1wiLFwic3RhdHVzXCI6XCJJTklUSUFMXCIsXCJhcHBsaWNhdGlvbkFyblwiOm51bGwsXCJmcmllbmRseUlkXCI6XCJjb2Rld2hpc3BlcmVyXCIsXCJ1c2VDYXNlQWN0aW9uXCI6XCJjb252ZXJzYXRpb25zXCIsXCJzY29wZVR5cGVcIjpcIkFDQ0VTU19TQ09QRVwiLFwidHlwZVwiOlwiSW1tdXRhYmxlQWNjZXNzU2NvcGVcIn0se1wiZnVsbFNjb3BlXCI6XCJjb2Rld2hpc3BlcmVyOmFuYWx5c2lzXCIsXCJzdGF0dXNcIjpcIklOSVRJQUxcIixcImFwcGxpY2F0aW9uQXJuXCI6bnVsbCxcImZyaWVuZGx5SWRcIjpcImNvZGV3aGlzcGVyZXJcIixcInVzZUNhc2VBY3Rpb25cIjpcImFuYWx5c2lzXCIsXCJzY29wZVR5cGVcIjpcIkFDQ0VTU19TQ09QRVwiLFwidHlwZVwiOlwiSW1tdXRhYmxlQWNjZXNzU2NvcGVcIn0se1wiZnVsbFNjb3BlXCI6XCJjb2Rld2hpc3BlcmVyOmNvbXBsZXRpb25zXCIsXCJzdGF0dXNcIjpcIklOSVRJQUxcIixcImFwcGxpY2F0aW9uQXJuXCI6bnVsbCxcImZyaWVuZGx5SWRcIjpcImNvZGV3aGlzcGVyZXJcIixcInVzZUNhc2VBY3Rpb25cIjpcImNvbXBsZXRpb25zXCIsXCJzY29wZVR5cGVcIjpcIkFDQ0VTU19TQ09QRVwiLFwidHlwZVwiOlwiSW1tdXRhYmxlQWNjZXNzU2NvcGVcIn1dfSxcInNob3VsZEdldFZhbHVlRnJvbVRlbXBsYXRlXCI6dHJ1ZSxcImhhc1JlcXVlc3RlZFNjb3Blc1wiOmZhbHNlLFwiY29udGFpbnNPbmx5U3NvU2NvcGVzXCI6ZmFsc2UsXCJzc29TY29wZXNcIjpbXSxcImlzVjFCYWNrZmlsbGVkXCI6ZmFsc2UsXCJpc1YyQmFja2ZpbGxlZFwiOmZhbHNlLFwiaXNWM0JhY2tmaWxsZWRcIjpmYWxzZSxcImlzVjRCYWNrZmlsbGVkXCI6ZmFsc2UsXCJpc0V4cGlyZWRcIjpmYWxzZSxcImlzQmFja2ZpbGxlZFwiOmZhbHNlLFwiaGFzSW5pdGlhbFNjb3Blc1wiOnRydWUsXCJhcmVBbGxTY29wZXNDb25zZW50ZWRUb1wiOmZhbHNlfSJ9.c8j_hdXuchRh3_UXUjwaG4bD4UMJjgPN7CZiGf9bQVju5p258Sh_0LnQwS0p3tWm",
  region: "us-east-1",
  auth_method: "idc",
  email: "",
  start_url: "https://d-906673429b.awsapps.com/start"
};

const id = uuidv4();
const ts = now();
const email = kiroData.email || "";

const data = {
  accessToken: kiroData.access_token,
  refreshToken: kiroData.refresh_token,
  expiresIn: kiroData.expires_in,
  expiresAt: kiroData.expires_at,
  tokenType: "Bearer",
  testStatus: "active",
  providerSpecificData: {
    profileArn: kiroData.profile_arn,
    region: kiroData.region,
    authMethod: kiroData.auth_method,
    clientId: kiroData.client_id,
    clientSecret: kiroData.client_secret,
    startUrl: kiroData.start_url,
  }
};

const dataJson = JSON.stringify(data);

db.transaction(() => {
  const existing = db.prepare(
    `SELECT id FROM providerConnections WHERE provider = ? AND authType = ? AND email = ?`
  ).get("kiro", "oauth", email);

  if (existing) {
    console.log("Kiro provider already exists (id:", existing.id, "). Updating...");
    db.prepare(`
      UPDATE providerConnections
      SET data = ?, updatedAt = ?
      WHERE id = ?
    `).run(dataJson, ts, existing.id);
    console.log("Updated:", existing.id);
    return;
  }

  const priority = db.prepare(
    `SELECT COALESCE(MAX(priority), 0) + 1 AS nextPri FROM providerConnections WHERE provider = ?`
  ).get("kiro").nextPri;

  db.prepare(`
    INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
    VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(id, "kiro", "oauth", email || `Kiro Account`, email, priority, dataJson, ts, ts);

  db.prepare(`
    UPDATE providerConnections
    SET priority = (
      SELECT seq FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY priority, updatedAt DESC) AS seq
        FROM providerConnections WHERE provider = 'kiro'
      ) WHERE id = providerConnections.id
    )
    WHERE provider = 'kiro'
  `).run();

  console.log("Inserted kiro provider:", id);
})();

console.log("Done.");
db.close();
