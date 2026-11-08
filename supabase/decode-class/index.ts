// Decode Space Adventure: learner class sign-in + progress sync relay.
// Learners never get database access. They sign in with a class code + 4 pictures,
// get a random pass (token) for their own record only, and send progress through here.
// Teachers read the data directly from the dashboard; row-level security limits each
// teacher to their own classes.
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// Optional: lock class sign-in and sync to the school's own internet address(es).
// ALLOWED_IPS="203.0.113.10,198.51.100.*"  (a trailing * matches a range). Empty = allow anywhere.
const ALLOWED_IPS = (Deno.env.get("ALLOWED_IPS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ipAllowed = (ip: string) => !ALLOWED_IPS.length || ALLOWED_IPS.some((a) => a.endsWith("*") ? ip.startsWith(a.slice(0, -1)) : ip === a);
const MAX_FAILS = 5, LOCK_MIN = 5;
const AVATARS = ["🧑‍🚀","👩‍🚀","👨‍🚀","🤖","👽","🦊","🐱","🐉","🦄","🐼","🦖","🐙"];

function originAllowed(o: string) {
  if (!o) return false;
  if (ALLOWED.length) return ALLOWED.includes(o);
  return /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}
function hdrs(o: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": originAllowed(o) ? o : "null",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}
const json = (b: unknown, s: number, o: string) => new Response(JSON.stringify(b), { status: s, headers: hdrs(o) });
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const cleanCode = (c: unknown) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
const UUID = /^[0-9a-f-]{36}$/i;
const int = (v: unknown, max = 1e7) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0; };
const strs = (a: unknown, n = 60) => (Array.isArray(a) ? a : []).slice(0, n).map((x) => String(x).slice(0, 40));
const small = (v: unknown, max: number) => { try { const s = JSON.stringify(v ?? null); return s.length <= max ? JSON.parse(s) : null; } catch { return null; } };

// Best-effort brake on class-code guessing (per server instance).
const hits = new Map<string, { n: number; t: number }>();
function tooMany(ip: string) {
  const now = Date.now(), h = hits.get(ip);
  if (!h || now - h.t > 10 * 60_000) { hits.set(ip, { n: 1, t: now }); return false; }
  h.n++; return h.n > 30;
}

async function learnerFromToken(token: unknown) {
  const t = String(token ?? "");
  if (t.length < 20) return null;
  const { data } = await db.from("decode_tokens").select("learner_id").eq("token_hash", await sha256(t)).maybeSingle();
  return data?.learner_id ?? null;
}

Deno.serve(async (req) => {
  const o = req.headers.get("origin") ?? "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: hdrs(o) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, o);
  if (!originAllowed(o)) return json({ error: "origin_not_allowed" }, 403, o);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400, o); }
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "?";
  if (!ipAllowed(ip)) return json({ error: "school_network_only" }, 403, o);

  try {
    // 1) Class code -> class name + first names/avatars (nothing else).
    if (b.action === "lookup") {
      if (tooMany(ip)) return json({ error: "slow_down" }, 429, o);
      const code = cleanCode(b.code);
      if (code.length !== 6) return json({ error: "no_class" }, 404, o);
      const { data: c } = await db.from("decode_classes").select("id,name").eq("code", code).maybeSingle();
      if (!c) return json({ error: "no_class" }, 404, o);
      const { data: ls } = await db.from("decode_learners").select("id,name,avatar").eq("class_id", c.id).order("name");
      return json({ className: c.name, learners: ls ?? [] }, 200, o);
    }

    // 2) Picture PIN sign-in -> pass for this learner only.
    if (b.action === "login") {
      const code = cleanCode(b.code), id = String(b.learnerId ?? ""), pin = String(b.pin ?? "");
      if (!UUID.test(id) || !/^[0-8]-[0-8]-[0-8]-[0-8]$/.test(pin)) return json({ error: "bad_request" }, 400, o);
      const { data: l } = await db.from("decode_learners")
        .select("id,name,avatar,pin,failed,locked_until,class_id,decode_classes!inner(code,name)")
        .eq("id", id).maybeSingle();
      const cls: any = l && (l as any).decode_classes;
      if (!l || !cls || cls.code !== code) return json({ error: "no_learner" }, 404, o);
      if (l.locked_until && new Date(l.locked_until).getTime() > Date.now()) {
        return json({ error: "locked", minutes: Math.ceil((new Date(l.locked_until).getTime() - Date.now()) / 60000) }, 423, o);
      }
      if (l.pin !== pin) {
        const failed = (l.failed ?? 0) + 1;
        const lock = failed >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null;
        await db.from("decode_learners").update({ failed: lock ? 0 : failed, locked_until: lock }).eq("id", id);
        return json({ error: lock ? "locked" : "wrong_pin", minutes: lock ? LOCK_MIN : undefined, left: lock ? 0 : MAX_FAILS - failed }, lock ? 423 : 401, o);
      }
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const token = btoa(String.fromCharCode(...raw)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" }[c]!));
      await db.from("decode_tokens").insert({ token_hash: await sha256(token), learner_id: id });
      const now = new Date().toISOString();
      await db.from("decode_learners").update({ failed: 0, locked_until: null, last_login: now }).eq("id", id);
      await db.from("decode_logins").insert({ learner_id: id, at: now, device: String(b.device ?? "").slice(0, 20) || null });
      const { data: snap } = await db.from("decode_snapshots").select("state").eq("learner_id", id).maybeSingle();
      return json({ token, learner: { id: l.id, name: l.name, avatar: l.avatar }, className: cls.name, state: snap?.state ?? null }, 200, o);
    }

    // 3) Progress sync (rounds, scans, logins, and a snapshot of the save).
    if (b.action === "sync") {
      const lid = await learnerFromToken(b.token);
      if (!lid) return json({ error: "unlinked" }, 401, o);
      const ev = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
      const at = (v: unknown) => { const d = new Date(String(v)); return isNaN(+d) || +d > Date.now() + 864e5 ? new Date().toISOString() : d.toISOString(); };
      const rounds = ev.filter((e: any) => e?.type === "round").map((e: any) => ({
        learner_id: lid, at: at(e.at), mission: String(e.mission ?? "").slice(0, 12),
        first_try: int(e.first, 500), total: int(e.total, 500), points: int(e.points, 5000), missed: strs(e.missed),
      }));
      const scans = ev.filter((e: any) => e?.type === "scan").map((e: any) => ({
        learner_id: lid, at: at(e.at), scores: small(e.scores, 2000) ?? {}, wpm: e.wpm == null ? null : int(e.wpm, 999),
        missed: strs(e.missed), misses: small(e.misses, 30000) ?? [],
      }));
      const logins = ev.filter((e: any) => e?.type === "login").map((e: any) => ({ learner_id: lid, at: at(e.at), device: String(e.device ?? "").slice(0, 20) || null }));
      if (rounds.length) await db.from("decode_rounds").insert(rounds);
      if (scans.length) await db.from("decode_scans").insert(scans);
      if (logins.length) {
        await db.from("decode_logins").insert(logins);
        await db.from("decode_learners").update({ last_login: logins[logins.length - 1].at }).eq("id", lid);
      }
      if (AVATARS.includes(b.avatar)) {
        await db.from("decode_learners").update({ avatar: b.avatar }).eq("id", lid);
      }
      let restore = null;
      if (b.snap) {
        const s = b.snap, state = small(s.state, 400000), savedAt = String(state?.savedAt ?? "");
        const { data: cur } = await db.from("decode_snapshots").select("state").eq("learner_id", lid).maybeSingle();
        const curAt = String((cur?.state as any)?.savedAt ?? "");
        if (!cur || !curAt || savedAt >= curAt) {
          await db.from("decode_snapshots").upsert({
            learner_id: lid, updated_at: new Date().toISOString(), xp: int(s.xp), streak: int(s.streak, 5000),
            rank: String(s.rank ?? "").slice(0, 20), badges: int(s.badges, 100), stickers: int(s.stickers, 100), mastered: int(s.mastered, 50), state,
          });
        } else restore = cur.state; // another device has newer progress
      }
      return json({ ok: true, restore }, 200, o);
    }
    return json({ error: "unknown_action" }, 400, o);
  } catch (e) {
    console.error("class_failure", e instanceof Error ? e.message : e);
    return json({ error: "server_error" }, 500, o);
  }
});
