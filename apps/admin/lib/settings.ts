"use client";

export interface Settings {
  apiUrl: string;
  token: string;
  /** Separate URL for streamed answers (the Lambda function URL on AWS). Empty = same as apiUrl. */
  streamUrl: string;
}

const KEY = "ticketwise.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { apiUrl: "", token: "", streamUrl: "", ...JSON.parse(raw) };
  } catch {
    // Storage blocked (private mode etc.): fall through to defaults.
  }
  return { apiUrl: "", token: "", streamUrl: "" };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

/** Deployed builds ship a config.json with the API URL (written by CDK). */
export async function loadDeployedConfig(): Promise<{ apiUrl?: string; streamUrl?: string }> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/config.json`, { cache: "no-store" });
    if (res.ok) return (await res.json()) as { apiUrl?: string; streamUrl?: string };
  } catch {
    // not deployed with config
  }
  return {};
}

export const isDemo = process.env.NEXT_PUBLIC_DEMO === "1";

/** Where CI publishes the benchmark history (the eval-history branch). */
export const EVAL_HISTORY_URL =
  process.env.NEXT_PUBLIC_EVAL_HISTORY_URL || "https://raw.githubusercontent.com/evannawfal/ticketwise/eval-history";
