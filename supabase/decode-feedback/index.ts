// Decode: app feedback relay. Saves every comment to decode_feedback and emails it to Andrew.
// Secrets (Supabase > Edge Functions > Secrets):
//   RESEND_API_KEY  (needed for email) API key from resend.com
//   FEEDBACK_TO     (optional) default kray1075@hotmail.com
//   FEEDBACK_FROM   (optional) default "Decode Feedback <onboarding@resend.dev>"
//   ALLOWED_ORIGINS (optional) comma-separated site origins
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TO = Deno.env.get("FEEDBACK_TO") || "kray1075@hotmail.com";
const FROM = Deno.env.get("FEEDBACK_FROM") || "Decode Feedback <onboarding@resend.dev>";
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const LABELS: Record<string, string> = {
  overall: "Overall", missions: "Missions (the games)", voice: "Orbit's voice & instructions", scan: "Level Scan",
  rewards: "Rewards (ranks, badges, crates)", look: "Look & animations", speed: "Runs smoothly",
  setup: "Easy to set up", roster: "Roster & needs-help flags", detail: "Learner detail & next steps",
  insights: "Class insights", cards: "Sign-in cards & CSV",
};
const KINDS: Record<string, string> = { love: "💚 Something I love", idea: "💡 An idea", broken: "🔧 Something isn't working", other: "💬 Other" };
const ROLES = ["student", "parent", "teacher", "other"];

function originAllowed(o: string) {
  if (o === "null") return true; // the downloaded (offline) version runs from a file
  if (!o) return false;
  if (ALLOWED.length) return ALLOWED.includes(o);
  return /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(o) || /^https:\/\/(www\.)?akratechnologies\.com$/i.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}
const hdrs = (o: string): Record<string, string> => ({
  "Access-Control-Allow-Origin": originAllowed(o) ? o : "null",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin", "Content-Type": "application/json",
});
const json = (b: unknown, s: number, o: string) => new Response(JSON.stringify(b), { status: s, headers: hdrs(o) });
const esc = (t: unknown) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hits = new Map<string, { n: number; t: number }>();
function tooMany(ip: string) {
  const now = Date.now(), h = hits.get(ip);
  if (!h || now - h.t > 10 * 60_000) { hits.set(ip, { n: 1, t: now }); return false; }
  h.n++; return h.n > 6;
}
const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

Deno.serve(async (req) => {
  const o = req.headers.get("origin") ?? "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: hdrs(o) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, o);
  if (!originAllowed(o)) return json({ error: "origin_not_allowed" }, 403, o);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400, o); }
  if (b.website) return json({ ok: true }, 200, o); // honeypot: bots fill hidden fields
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "?";
  if (tooMany(ip)) return json({ error: "slow_down" }, 429, o);

  const source = b.source === "dashboard" ? "dashboard" : "game";
  const kind = KINDS[b.kind] ? b.kind : "other";
  const role = ROLES.includes(b.role) ? b.role : null;
  const message = String(b.message ?? "").trim().slice(0, 1500);
  if (!message) return json({ error: "empty" }, 400, o);
  const name = String(b.name ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || null;
  let reply = String(b.reply_email ?? "").trim().slice(0, 120);
  if (role === "student" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reply)) reply = ""; // never keep a student's email
  const ratings: Record<string, number> = {};
  for (const [k, v] of Object.entries(b.ratings ?? {})) {
    const n = Math.round(Number(v));
    if (LABELS[k] && n >= 1 && n <= 5) ratings[k] = n;
  }
  const row = {
    source, kind, role, name, message, reply_email: reply || null, ratings,
    rating: ratings.overall ?? null, app_version: String(b.version ?? "").slice(0, 20) || null,
    device: String(b.device ?? "").slice(0, 20) || null, ip_hash: (await sha256("decode:" + ip)).slice(0, 16),
  };

  try {
    const { data, error } = await db.from("decode_feedback").insert(row).select("id").single();
    if (error) throw error;
    let emailed = false;
    const key = Deno.env.get("RESEND_API_KEY");
    if (key) {
      const who = [role ? role[0].toUpperCase() + role.slice(1) : "Someone", name].filter(Boolean).join(" · ");
      const rows = Object.entries(ratings).map(([k, n]) =>
        `<tr><td style="padding:6px 12px;border-bottom:1px solid #e5e7eb">${esc(LABELS[k])}</td><td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;color:#C9A227;font-size:18px;letter-spacing:2px">${stars(n)}</td><td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280">${n}/5</td></tr>`).join("");
      const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:620px;color:#1f2937">
        <div style="background:#1B2A4A;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0"><b style="font-size:18px">Decode feedback</b><br><span style="color:#C9A227">${esc(source === "dashboard" ? "Teacher dashboard" : "Decode Space Adventure (game)")}</span></div>
        <div style="border:1px solid #e5e7eb;border-top:0;padding:16px 18px;border-radius:0 0 10px 10px">
        <p style="margin:0 0 6px"><b>From:</b> ${esc(who)}${reply ? ` · <a href="mailto:${esc(reply)}">${esc(reply)}</a>` : ""}</p>
        <p style="margin:0 0 6px"><b>Type:</b> ${esc(KINDS[kind])}</p>
        ${rows ? `<table style="border-collapse:collapse;margin:12px 0;width:100%">${rows}</table>` : ""}
        <p style="margin:12px 0 4px"><b>Comment:</b></p>
        <div style="white-space:pre-wrap;background:#f7f9fc;border-left:4px solid #C9A227;padding:10px 12px;border-radius:6px">${esc(message)}</div>
        <p style="color:#6b7280;font-size:12px;margin-top:14px">App version ${esc(row.app_version ?? "?")} · ${esc(row.device ?? "?")} · Feedback #${data.id}</p></div></div>`;
      const subject = `Decode feedback: ${KINDS[kind].replace(/^\S+\s/, "")} (${source === "dashboard" ? "Teacher" : who.split(" · ")[0]}${ratings.overall ? `, ${ratings.overall}★` : ""})`;
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [TO], subject, html, ...(reply ? { reply_to: reply } : {}) }),
      });
      emailed = r.ok;
      if (!r.ok) console.error("resend_error", r.status, (await r.text()).slice(0, 300));
      else await db.from("decode_feedback").update({ emailed: true }).eq("id", data.id);
    }
    return json({ ok: true, emailed }, 200, o);
  } catch (e) {
    console.error("feedback_failure", e instanceof Error ? e.message : e);
    return json({ error: "server_error" }, 500, o);
  }
});
