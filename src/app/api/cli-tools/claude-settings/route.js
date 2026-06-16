"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

// Whitelist of env keys this endpoint is allowed to write into the host's
// ~/.claude/settings.json. The POST body is attacker-controllable if the
// dashboard guard is ever bypassed (or in requireLogin=false local mode), so we
// refuse to write arbitrary env — only the Anthropic/9router integration keys
// the feature actually manages. Mirrors RESET_ENV_KEYS (the keys DELETE clears).
const ALLOWED_ENV_KEYS = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "API_TIMEOUT_MS",
]);

// Get claude settings path based on OS
const getClaudeSettingsPath = () => {
  const homeDir = os.homedir();
  return path.join(homeDir, ".claude", "settings.json");
};


// Check if claude CLI is installed (via which/where or config file exists)
const checkClaudeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where claude" : "which claude";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getClaudeSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings
const readSettings = async () => {
  try {
    const settingsPath = getClaudeSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

// GET - Check claude CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkClaudeInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Claude CLI is not installed",
      });
    }

    const settings = await readSettings();
    const has9Router = !!(settings?.env?.ANTHROPIC_BASE_URL);

    return NextResponse.json({
      installed: true,
      settings: settings,
      has9Router: has9Router,
      settingsPath: getClaudeSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking claude settings:", error);
    return NextResponse.json(
      { error: "Failed to check claude settings" },
      { status: 500 }
    );
  }
}

// POST - Backup old fields and write new settings
export async function POST(request) {
  try {
    const { env } = await request.json();

    if (!env || typeof env !== "object") {
      return NextResponse.json(
        { error: "Invalid env object" },
        { status: 400 }
      );
    }

    // Reject arbitrary env keys — only the managed integration keys may be
    // written to the host settings file (prevents injecting unrelated env into
    // the user's Claude CLI). Unknown keys cause a hard 400, not a silent drop.
    const unknownKeys = Object.keys(env).filter((k) => !ALLOWED_ENV_KEYS.has(k));
    if (unknownKeys.length > 0) {
      return NextResponse.json(
        { error: `Disallowed env keys: ${unknownKeys.join(", ")}` },
        { status: 400 }
      );
    }

    const settingsPath = getClaudeSettingsPath();
    const claudeDir = path.dirname(settingsPath);

    // Ensure .claude directory exists
    await fs.mkdir(claudeDir, { recursive: true });

    // Read current settings
    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = JSON.parse(content);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    // Normalize ANTHROPIC_BASE_URL to ensure /v1 suffix
    if (env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL.endsWith("/v1") 
        ? env.ANTHROPIC_BASE_URL 
        : `${env.ANTHROPIC_BASE_URL}/v1`;
    }

    // Merge new env with existing settings
    const newSettings = {
      ...currentSettings,
      hasCompletedOnboarding: true,
      env: {
        ...(currentSettings.env || {}),
        ...env,
      },
    };

    // Write new settings
    await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings updated successfully",
    });
  } catch (error) {
    console.log("Error updating claude settings:", error);
    return NextResponse.json(
      { error: "Failed to update claude settings" },
      { status: 500 }
    );
  }
}

// Fields to remove when resetting
const RESET_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "API_TIMEOUT_MS",
];

// DELETE - Reset settings (remove env fields)
export async function DELETE() {
  try {
    const settingsPath = getClaudeSettingsPath();

    // Read current settings
    let currentSettings = {};
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      currentSettings = JSON.parse(content);
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({
          success: true,
          message: "No settings file to reset",
        });
      }
      throw error;
    }

    // Remove specified env fields
    if (currentSettings.env) {
      RESET_ENV_KEYS.forEach((key) => {
        delete currentSettings.env[key];
      });
      
      // Clean up empty env object
      if (Object.keys(currentSettings.env).length === 0) {
        delete currentSettings.env;
      }
    }

    // Write updated settings
    await fs.writeFile(settingsPath, JSON.stringify(currentSettings, null, 2));

    return NextResponse.json({
      success: true,
      message: "Settings reset successfully",
    });
  } catch (error) {
    console.log("Error resetting claude settings:", error);
    return NextResponse.json(
      { error: "Failed to reset claude settings" },
      { status: 500 }
    );
  }
}

