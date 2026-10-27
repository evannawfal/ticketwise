"use client";

export interface Settings {
  apiUrl: string;
  token: string;
}

const KEY = "ticketwise.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { apiUrl: "", token: "", ...JSON.parse(raw) };
  } catch {
    // Storage blocked (private mode etc.): fall through to defaults.
  }
  return { apiUrl: "", token: "" };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

/** Deployed builds ship a config.json with the API URL (written by CDK). */
export async function loadDeployedConfig(): Promise<{ apiUrl?: string }> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/config.json`, { cache: "no-store" });
    if (res.ok) return (await res.json()) as { apiUrl?: string };
  } catch {
    // not deployed with config
  }
  return {};
}

export const isDemo = process.env.NEXT_PUBLIC_DEMO === "1";
