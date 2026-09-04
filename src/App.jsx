import React, { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Dumbbell, Flame, Users, ChevronRight, Play, Pause, Plus, Apple, Chrome, Search, MoreHorizontal, GripVertical, Link2, X, Home as HomeIcon, LayoutList, Save, ArrowLeft, Check, SkipForward, ArrowRight, SplitSquareHorizontal, Trophy, TrendingUp, Activity, Calendar, Copy, UserPlus, LogOut, Mail, MessageCircle, Send, Music, Crown, Zap, Camera } from "lucide-react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

/* ============================================================
   FORGE — Design tokens
   ============================================================ */
/* ============================================================
   PERSISTENT STORAGE — uses the artifact's window.storage API when
   running in the Claude.ai preview, and falls back to the browser's
   real localStorage when running as a standalone deployed site.
   ============================================================ */
async function storageGet(key) {
  try {
    if (window.storage) {
      const res = await window.storage.get(key);
      return res ? JSON.parse(res.value) : null;
    }
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
async function storageSet(key, value) {
  try {
    if (window.storage) {
      await window.storage.set(key, JSON.stringify(value));
      return;
    }
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable — app still works in-memory for this session
  }
}

/* ============================================================
   SUPABASE — real backend, talked to directly over REST (no SDK,
   since @supabase/supabase-js isn't available in this environment).
   Auth uses Supabase's GoTrue REST API; data uses PostgREST.
   ============================================================ */
const SUPABASE_URL = "https://txuxgkqytfrdsxakjziz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4dXhna3F5dGZyZHN4YWtqeml6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczMzk1NDIsImV4cCI6MjEwMjkxNTU0Mn0.YY42ohOKoo0MZ8bIGGb1q0RLUUYm9m-9c9cscrCI_Fo";

function friendlyAuthError(data, status) {
  const msg = data?.error_description || data?.msg || data?.error || data?.message || "";
  if (/already registered|already exists/i.test(msg)) return "That email is already registered — try signing in instead.";
  if (/invalid login credentials/i.test(msg)) return "Incorrect email or password.";
  if (status === 422 && /password/i.test(msg)) return "Password must be at least 6 characters.";
  return msg || "Something went wrong. Please try again.";
}

async function supabaseAuthRequest(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyAuthError(data, res.status));
  return data;
}

const supabaseSignUp = (email, password, name) => supabaseAuthRequest("signup", { email, password, data: { name } });
const supabaseSignIn = (email, password) => supabaseAuthRequest("token?grant_type=password", { email, password });
const supabaseRefreshToken = (refresh_token) => supabaseAuthRequest("token?grant_type=refresh_token", { refresh_token });

function toSession(authData) {
  return {
    access_token: authData.access_token,
    refresh_token: authData.refresh_token,
    expires_at: Date.now() + (authData.expires_in || 3600) * 1000,
    user: { id: authData.user?.id, email: authData.user?.email, name: authData.user?.user_metadata?.name },
  };
}

// Returns a valid (non-expired) access token, refreshing first if needed.
// Clears the session (forcing re-login) if the refresh token itself has expired.
async function getValidToken(session, setSession) {
  if (!session) return null;
  if (session.expires_at && Date.now() < session.expires_at - 30000) return session.access_token;
  try {
    const refreshed = toSession(await supabaseRefreshToken(session.refresh_token));
    refreshed.user = session.user;
    setSession(refreshed);
    return refreshed.access_token;
  } catch {
    setSession(null);
    return null;
  }
}

async function supabaseRest(path, { method = "GET", token, body, extraHeaders = {} } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      Prefer: "return=representation",
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(errText || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function fetchHasOnboarded(token, userId) {
  const rows = await supabaseRest(`profiles?id=eq.${userId}&select=has_onboarded`, { token });
  return rows?.[0]?.has_onboarded ?? false;
}

async function markOnboarded(token, userId) {
  await supabaseRest(`profiles?id=eq.${userId}`, { method: "PATCH", token, body: { has_onboarded: true } });
}

async function fetchProfileExtras(token, userId) {
  const rows = await supabaseRest(`profiles?id=eq.${userId}&select=has_onboarded,avatar_url`, { token });
  return rows?.[0] || { has_onboarded: false, avatar_url: null };
}

async function uploadAvatar(token, userId, file) {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${userId}/avatar.${ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": file.type || "image/jpeg",
      "x-upsert": "true",
    },
    body: file,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(errText || `Upload failed (${res.status})`);
  }
  // cache-bust so a re-uploaded photo at the same path shows immediately
  return `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}?t=${Date.now()}`;
}

async function updateProfileAvatar(token, userId, avatarUrl) {
  await supabaseRest(`profiles?id=eq.${userId}`, { method: "PATCH", token, body: { avatar_url: avatarUrl } });
}

const C = {
  bg: "#07070F",
  bgRaised: "#0F0F1A",
  bgCard: "#13131F",
  line: "#1E1E2E",
  blue: "#2563EB",
  accent: "#60A5FA",
  amber: "#F59E0B",
  textHi: "#F5F5FA",
  textLo: "#7A7A8C",
};

const FontImport = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap');
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    .fg-display { font-family: 'Barlow Condensed', sans-serif; letter-spacing: 0.01em; }
    .fg-mono { font-family: 'DM Mono', monospace; }
    ::selection { background: ${C.blue}; color: white; }
    input::placeholder { color: ${C.textLo}; }
    button { font-family: inherit; cursor: pointer; transition: transform 0.12s ease, opacity 0.12s ease, background 0.15s ease, border-color 0.15s ease; }
    button:active { transform: scale(0.97); opacity: 0.9; }
    .fg-tap { transition: transform 0.12s ease, opacity 0.12s ease, border-color 0.15s ease, background 0.15s ease; }
    .fg-tap:active { transform: scale(0.98); opacity: 0.85; }
    @media (prefers-reduced-motion: reduce) {
      * { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
      html { scroll-behavior: auto; }
    }
    @keyframes fgPulse { 0% { opacity: 0.55; } 50% { opacity: 1; } 100% { opacity: 0.55; } }
    .fg-pulse { animation: fgPulse 1.6s ease-in-out infinite; }
    @keyframes fgScreenIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .fg-screen-in { animation: fgScreenIn 0.32s cubic-bezier(0.16, 1, 0.3, 1); }
    @keyframes fgSheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .fg-sheet-in { animation: fgSheetUp 0.28s cubic-bezier(0.16, 1, 0.3, 1); }
    @keyframes fgFadeIn { from { opacity: 0; } to { opacity: 1; } }
    .fg-fade-in { animation: fgFadeIn 0.2s ease-out; }
  `}</style>
);

/* ============================================================
   AUTH SCREEN
   ============================================================ */
function AuthScreen({ onAuthed }) {
  const [mode, setMode] = useState("welcome"); // welcome | signin | create
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const inputStyle = {
    width: "100%",
    background: C.bgCard,
    border: `1px solid ${C.line}`,
    borderRadius: 10,
    padding: "14px 16px",
    color: C.textHi,
    fontSize: 15,
    fontFamily: "'DM Mono', monospace",
    outline: "none",
    marginBottom: 12,
  };

  const primaryBtn = {
    width: "100%",
    background: loading ? C.line : C.blue,
    border: "none",
    borderRadius: 10,
    padding: "15px",
    color: "white",
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 700,
    fontSize: 18,
    letterSpacing: "0.02em",
    marginTop: 4,
  };

  const submit = async () => {
    setError("");
    if (!email.trim() || !password.trim()) {
      setError("Email and password are required.");
      return;
    }
    if (mode === "create" && !name.trim()) {
      setError("Please enter your name.");
      return;
    }
    setLoading(true);
    try {
      const authData = mode === "create" ? await supabaseSignUp(email.trim(), password, name.trim()) : await supabaseSignIn(email.trim(), password);
      if (mode === "create" && !authData.access_token) {
        // Supabase project has email confirmation on — no session yet
        setError("Account created! Check your email to confirm, then sign in.");
        setMode("signin");
        setLoading(false);
        return;
      }
      onAuthed(toSession(authData));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <FontImport />

      {/* ambient glow */}
      <div
        style={{
          position: "absolute",
          top: "-20%",
          left: "50%",
          transform: "translateX(-50%)",
          width: 600,
          height: 600,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${C.blue}22 0%, transparent 70%)`,
          pointerEvents: "none",
        }}
      />

      <div style={{ width: "100%", maxWidth: 400, position: "relative" }}>
        {mode === "welcome" && (
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                width: 64,
                height: 64,
                margin: "0 auto 28px",
                borderRadius: 16,
                background: `linear-gradient(135deg, ${C.blue}, ${C.accent})`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: `0 0 40px ${C.blue}55`,
              }}
            >
              <Dumbbell size={30} color={C.bg} strokeWidth={2.5} />
            </div>
            <h1
              className="fg-display"
              style={{
                fontSize: 56,
                fontWeight: 800,
                color: C.textHi,
                margin: 0,
                lineHeight: 0.95,
              }}
            >
              FORGE
            </h1>
            <p
              className="fg-mono"
              style={{
                color: C.textLo,
                fontSize: 13,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                margin: "10px 0 44px",
              }}
            >
              Train together. In sync.
            </p>

            <button style={primaryBtn} onClick={() => { setError(""); setMode("create"); }}>
              Create Account
            </button>
            <button
              style={{
                width: "100%",
                background: "transparent",
                border: "none",
                color: C.accent,
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 600,
                fontSize: 16,
                padding: "16px",
              }}
              onClick={() => { setError(""); setMode("signin"); }}
            >
              Sign In
            </button>
          </div>
        )}

        {(mode === "signin" || mode === "create") && (
          <div>
            <button
              className="fg-mono"
              style={{
                background: "none",
                border: "none",
                color: C.textLo,
                fontSize: 13,
                marginBottom: 24,
                padding: 0,
              }}
              onClick={() => { setError(""); setMode("welcome"); }}
            >
              ← BACK
            </button>
            <h2
              className="fg-display"
              style={{ fontSize: 34, fontWeight: 700, color: C.textHi, margin: "0 0 4px" }}
            >
              {mode === "signin" ? "Welcome back" : "Get started"}
            </h2>
            <p style={{ color: C.textLo, fontSize: 14, margin: "0 0 28px" }}>
              {mode === "signin" ? "Sign in to your account." : "Create your real FORGE account."}
            </p>

            {mode === "create" && (
              <input
                style={inputStyle}
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
            <input
              style={inputStyle}
              placeholder="Email"
              type="email"
              autoCapitalize="none"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              style={inputStyle}
              placeholder="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />

            {error && (
              <div className="fg-mono" style={{ color: error.startsWith("Account created") ? "#4ADE80" : "#F87171", fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
                {error}
              </div>
            )}

            <button style={primaryBtn} onClick={submit} disabled={loading}>
              {loading ? "Please wait..." : mode === "signin" ? "Sign In" : "Create Account"}
            </button>

            <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, textAlign: "center", marginTop: 16, lineHeight: 1.5 }}>
              Real account, real password — stored securely by Supabase, not by us.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   HOME SCREEN
   ============================================================ */
function getWeekStripData(history) {
  const dayKeys = new Set((history || []).map((s) => new Date(s.date).toDateString()));
  const today = new Date();
  const dow = today.getDay(); // 0=Sun..6=Sat
  const mondayOffset = dow === 0 ? 6 : dow - 1;
  const monday = new Date(today);
  monday.setDate(today.getDate() - mondayOffset);
  const labels = ["M", "T", "W", "T", "F", "S", "S"];
  return Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return {
      d: labels[i],
      done: dayKeys.has(d.toDateString()),
      isToday: d.toDateString() === today.toDateString(),
    };
  });
}

const relativeDay = (ts) => {
  const diffDays = Math.floor((Date.now() - ts) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return `${diffDays} days ago`;
};

function HomeScreen({ user, history, templates, squadMembers, activeProgramRow, onStartBuild, onLoadTemplate, onStartFreestyle, onOpenHistory, onOpenSocial, onOpenPrograms, onStartTodayWorkout }) {
  const firstName = (user?.name || "Casey").split(" ")[0];
  const onlinePartner = (squadMembers || []).find((m) => !m.isMe && m.online);
  const recentSessions = (history || []).slice(0, 3).map((s) => ({
    name: s.source === "freestyle" ? "Freestyle Session" : `${s.mode} Workout`,
    when: relativeDay(s.date),
    sets: s.sets.length,
    duration: s.durationSec ? `${Math.round(s.durationSec / 60)} min` : "duration unknown",
  }));
  const activeProgram = activeProgramRow ? PROGRAMS.find((p) => p.id === activeProgramRow.program_id) : null;
  const todayInfo = activeProgramRow ? getTodayProgramDay(activeProgramRow) : null;
  const weekStrip = getWeekStripData(history);

  const sectionLabel = (text) => (
    <div
      className="fg-mono"
      style={{
        fontSize: 12,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: C.textLo,
        marginBottom: 12,
      }}
    >
      {text}
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: 40 }}>
      <FontImport />

      {/* header */}
      <div style={{ padding: "28px 20px 8px", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 13 }}>
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </div>
          <h1
            className="fg-display"
            style={{ fontSize: 38, fontWeight: 700, color: C.textHi, margin: "2px 0 0" }}
          >
            Hey, {firstName}
          </h1>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            onClick={onOpenPrograms}
            style={{
              width: 40, height: 40, borderRadius: 10, background: C.bgCard, border: `1px solid ${C.line}`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <TrendingUp size={18} color={C.textLo} />
          </button>
          <button
            onClick={onOpenSocial}
            style={{
              width: 40, height: 40, borderRadius: 10, background: C.bgCard, border: `1px solid ${C.line}`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <Users size={18} color={C.textLo} />
          </button>
          <button
            onClick={onOpenHistory}
            style={{
              width: 40, height: 40, borderRadius: 10, background: C.bgCard, border: `1px solid ${C.line}`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <Calendar size={18} color={C.textLo} />
          </button>
        </div>
      </div>

      {/* week strip */}
      <div style={{ padding: "18px 20px 6px", display: "flex", gap: 8 }}>
        {weekStrip.map((day, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "10px 0",
              borderRadius: 10,
              background: day.done ? `${C.blue}22` : C.bgCard,
              border: `1px solid ${day.isToday ? C.accent : day.done ? C.blue + "55" : C.line}`,
            }}
          >
            <div className="fg-mono" style={{ fontSize: 11, color: day.isToday ? C.accent : C.textLo, marginBottom: 6, fontWeight: day.isToday ? 700 : 400 }}>
              {day.d}
            </div>
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                margin: "0 auto",
                background: day.done ? C.accent : C.line,
              }}
            />
          </div>
        ))}
      </div>

      {/* today's program workout */}
      {activeProgram && todayInfo && !todayInfo.complete && (
        <div style={{ padding: "18px 20px 6px" }}>
          <div
            onClick={onOpenPrograms}
            className="fg-tap"
            style={{
              background: `${activeProgram.color}14`, border: `1px solid ${activeProgram.color}`, borderRadius: 14,
              padding: 16, cursor: "pointer",
            }}
          >
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>
              {activeProgram.name} · Week {todayInfo.week} of {activeProgram.durationWeeks}
            </div>
            <div className="fg-display" style={{ color: C.textHi, fontSize: 20, fontWeight: 700, marginBottom: 12 }}>
              {todayInfo.dayDef && todayInfo.dayDef.type === "workout" ? todayInfo.dayDef.label : "Rest Day"}
            </div>
            {todayInfo.dayDef && todayInfo.dayDef.type === "workout" && (
              <button
                onClick={(e) => { e.stopPropagation(); onStartTodayWorkout(todayInfo.dayDef); }}
                className="fg-display"
                style={{ background: activeProgram.color, border: "none", borderRadius: 10, padding: "12px 20px", color: "white", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}
              >
                <Play size={14} fill="white" /> Start Today's Workout
              </button>
            )}
          </div>
        </div>
      )}

      {/* partner status */}
      <div style={{ padding: "22px 20px 6px" }}>
        <div
          onClick={onOpenSocial}
          className="fg-tap"
          style={{
            background: C.bgCard,
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            padding: 16,
            display: "flex",
            alignItems: "center",
            gap: 12,
            cursor: "pointer",
          }}
        >
          <div style={{ position: "relative" }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                background: onlinePartner ? `linear-gradient(135deg, ${onlinePartner.color[0]}, ${onlinePartner.color[1]})` : `linear-gradient(135deg, ${C.line}, ${C.textLo})`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {onlinePartner ? (
                <span className="fg-display" style={{ color: C.bg, fontWeight: 700, fontSize: 18 }}>{onlinePartner.name[0]}</span>
              ) : (
                <Users size={20} color={C.bg} />
              )}
            </div>
            <div
              style={{
                position: "absolute",
                bottom: -1,
                right: -1,
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: onlinePartner ? "#22C55E" : C.textLo,
                border: `2px solid ${C.bgCard}`,
              }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div className="fg-display" style={{ color: C.textHi, fontSize: 17, fontWeight: 600 }}>
              {onlinePartner ? `${onlinePartner.name} is online` : "No one's online right now"}
            </div>
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 12 }}>
              {onlinePartner ? "In the squad · tap to join or check in" : "Head to Social to start a squad session"}
            </div>
          </div>
          <ChevronRight size={18} color={C.textLo} />
        </div>
      </div>

      {/* quick start CTA */}
      <div style={{ padding: "18px 20px 6px" }}>
        <button
          onClick={onStartBuild}
          style={{
            width: "100%",
            background: `linear-gradient(135deg, ${C.blue}, #1D4ED8)`,
            border: "none",
            borderRadius: 16,
            padding: "22px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            boxShadow: `0 8px 30px ${C.blue}33`,
          }}
        >
          <div style={{ textAlign: "left" }}>
            <div
              className="fg-mono"
              style={{ color: "#DBEAFE", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase" }}
            >
              Quick Start
            </div>
            <div className="fg-display" style={{ color: "white", fontSize: 26, fontWeight: 700, marginTop: 2 }}>
              Start a Workout
            </div>
          </div>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.15)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Play size={20} color="white" fill="white" />
          </div>
        </button>
        <button
          onClick={onStartFreestyle}
          className="fg-mono"
          style={{
            width: "100%", background: "none", border: "none", color: C.textLo,
            fontSize: 12, letterSpacing: "0.04em", padding: "12px 0 2px", textAlign: "center",
          }}
        >
          or log freestyle, no builder needed →
        </button>
      </div>

      {/* templates */}
      <div style={{ padding: "26px 20px 6px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {sectionLabel("Templates")}
          <Plus size={16} color={C.textLo} onClick={onStartBuild} style={{ cursor: "pointer" }} />
        </div>
        <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
          {(templates || []).map((t) => (
            <div
              key={t.id}
              onClick={() => onLoadTemplate(t)}
              className="fg-tap"
              style={{
                minWidth: 150,
                background: C.bgCard,
                border: `1px solid ${C.line}`,
                borderRadius: 14,
                padding: 16,
                flexShrink: 0,
                cursor: "pointer",
              }}
            >
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: `${t.isPreset ? C.amber : C.blue}22`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: 14,
                }}
              >
                <Dumbbell size={15} color={t.isPreset ? C.amber : C.blue} />
              </div>
              <div className="fg-display" style={{ color: C.textHi, fontSize: 18, fontWeight: 600 }}>
                {t.name}
              </div>
              <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 4 }}>
                {(t.buildItems || []).length} exercises · {t.config.mode}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* recent sessions */}
      <div style={{ padding: "24px 20px 0" }}>
        {sectionLabel("Recent Sessions")}
        {recentSessions.length === 0 ? (
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, textAlign: "center", padding: 26, border: `1px dashed ${C.line}`, borderRadius: 12 }}>
            No sessions yet — start your first workout above.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {recentSessions.map((s, i) => (
              <div
                key={i}
                style={{
                  background: C.bgCard,
                  border: `1px solid ${C.line}`,
                  borderRadius: 12,
                  padding: "14px 16px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <div className="fg-display" style={{ color: C.textHi, fontSize: 17, fontWeight: 600 }}>
                    {s.name}
                  </div>
                  <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, marginTop: 2 }}>
                    {s.when} · {s.sets} sets · {s.duration}
                  </div>
                </div>
                <Flame size={16} color={C.amber} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   LIBRARY + BUILDER — data
   ============================================================ */
const CATEGORIES = ["All", "Chest", "Back", "Shoulders", "Arms", "Legs", "Core", "HIIT", "Mobility", "Full Body"];
const DIFFICULTIES = ["All", "Beginner", "Intermediate", "Advanced"];
const DIFFICULTY_ORDER = ["Beginner", "Intermediate", "Advanced"];

const EXERCISES = [
  { id: "ex1", name: "Barbell Bench Press", category: "Chest", muscles: ["Chest", "Triceps", "Shoulders"], equipment: "Barbell", equipmentAlternatives: ["Dumbbell", "Machine"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex2", name: "Pull-Up", category: "Back", muscles: ["Back", "Biceps"], equipment: "Bodyweight", equipmentAlternatives: ["Machine"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex3", name: "Overhead Press", category: "Shoulders", muscles: ["Shoulders", "Triceps"], equipment: "Barbell", equipmentAlternatives: ["Dumbbell", "Machine"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex4", name: "Barbell Curl", category: "Arms", muscles: ["Biceps"], equipment: "Barbell", equipmentAlternatives: ["Dumbbell", "Band"], movementType: "Isolation", difficulty: "Beginner", videoUrl: "" },
  { id: "ex5", name: "Back Squat", category: "Legs", muscles: ["Quads", "Glutes"], equipment: "Barbell", equipmentAlternatives: ["Dumbbell", "Machine"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex6", name: "Plank", category: "Core", muscles: ["Core"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Isolation", difficulty: "Beginner", videoUrl: "" },
  { id: "ex7", name: "Burpees", category: "HIIT", muscles: ["Full Body"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Compound", difficulty: "Advanced", videoUrl: "" },
  { id: "ex8", name: "Downward Dog", category: "Mobility", muscles: ["Shoulders", "Back"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Mobility", difficulty: "Beginner", videoUrl: "" },
  { id: "ex9", name: "Kettlebell Swing", category: "Full Body", muscles: ["Glutes", "Back", "Core"], equipment: "Kettlebell", equipmentAlternatives: ["Dumbbell"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex10", name: "Romanian Deadlift", category: "Legs", muscles: ["Hamstrings", "Glutes", "Back"], equipment: "Barbell", equipmentAlternatives: ["Dumbbell", "Kettlebell"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },

  // Chest
  { id: "ex11", name: "Push-Up", category: "Chest", muscles: ["Chest", "Triceps", "Shoulders"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Compound", difficulty: "Beginner", videoUrl: "" },
  { id: "ex12", name: "Incline Dumbbell Press", category: "Chest", muscles: ["Chest", "Shoulders", "Triceps"], equipment: "Dumbbell", equipmentAlternatives: ["Barbell", "Machine"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex13", name: "Cable Chest Fly", category: "Chest", muscles: ["Chest"], equipment: "Cable", equipmentAlternatives: ["Dumbbell"], movementType: "Isolation", difficulty: "Beginner", videoUrl: "" },
  { id: "ex14", name: "Dip", category: "Chest", muscles: ["Chest", "Triceps"], equipment: "Bodyweight", equipmentAlternatives: ["Machine"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },

  // Back
  { id: "ex15", name: "Barbell Row", category: "Back", muscles: ["Back", "Biceps"], equipment: "Barbell", equipmentAlternatives: ["Dumbbell", "Cable"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex16", name: "Lat Pulldown", category: "Back", muscles: ["Back", "Biceps"], equipment: "Machine", equipmentAlternatives: [], movementType: "Compound", difficulty: "Beginner", videoUrl: "" },
  { id: "ex17", name: "Seated Cable Row", category: "Back", muscles: ["Back", "Biceps"], equipment: "Cable", equipmentAlternatives: ["Machine"], movementType: "Compound", difficulty: "Beginner", videoUrl: "" },

  // Shoulders
  { id: "ex18", name: "Lateral Raise", category: "Shoulders", muscles: ["Shoulders"], equipment: "Dumbbell", equipmentAlternatives: ["Cable", "Band"], movementType: "Isolation", difficulty: "Beginner", videoUrl: "" },
  { id: "ex19", name: "Arnold Press", category: "Shoulders", muscles: ["Shoulders", "Triceps"], equipment: "Dumbbell", equipmentAlternatives: [], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex20", name: "Face Pull", category: "Shoulders", muscles: ["Shoulders", "Back"], equipment: "Cable", equipmentAlternatives: ["Band"], movementType: "Isolation", difficulty: "Beginner", videoUrl: "" },

  // Arms
  { id: "ex21", name: "Tricep Pushdown", category: "Arms", muscles: ["Triceps"], equipment: "Cable", equipmentAlternatives: ["Band"], movementType: "Isolation", difficulty: "Beginner", videoUrl: "" },
  { id: "ex22", name: "Hammer Curl", category: "Arms", muscles: ["Biceps"], equipment: "Dumbbell", equipmentAlternatives: ["Band"], movementType: "Isolation", difficulty: "Beginner", videoUrl: "" },
  { id: "ex23", name: "Skull Crusher", category: "Arms", muscles: ["Triceps"], equipment: "Barbell", equipmentAlternatives: ["Dumbbell"], movementType: "Isolation", difficulty: "Intermediate", videoUrl: "" },

  // Legs
  { id: "ex24", name: "Walking Lunge", category: "Legs", muscles: ["Quads", "Glutes"], equipment: "Dumbbell", equipmentAlternatives: ["Bodyweight", "Kettlebell"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex25", name: "Leg Press", category: "Legs", muscles: ["Quads", "Glutes"], equipment: "Machine", equipmentAlternatives: [], movementType: "Compound", difficulty: "Beginner", videoUrl: "" },
  { id: "ex26", name: "Bulgarian Split Squat", category: "Legs", muscles: ["Quads", "Glutes"], equipment: "Dumbbell", equipmentAlternatives: ["Bodyweight", "Kettlebell"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex27", name: "Calf Raise", category: "Legs", muscles: ["Calves"], equipment: "Bodyweight", equipmentAlternatives: ["Machine", "Dumbbell"], movementType: "Isolation", difficulty: "Beginner", videoUrl: "" },
  { id: "ex28", name: "Good Morning", category: "Legs", muscles: ["Hamstrings", "Back", "Glutes"], equipment: "Barbell", equipmentAlternatives: [], movementType: "Compound", difficulty: "Advanced", videoUrl: "" },

  // Core
  { id: "ex29", name: "Russian Twist", category: "Core", muscles: ["Core"], equipment: "Bodyweight", equipmentAlternatives: ["Dumbbell", "Kettlebell"], movementType: "Isolation", difficulty: "Beginner", videoUrl: "" },
  { id: "ex30", name: "Hanging Leg Raise", category: "Core", muscles: ["Core"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Isolation", difficulty: "Advanced", videoUrl: "" },
  { id: "ex31", name: "Bicycle Crunch", category: "Core", muscles: ["Core"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Isolation", difficulty: "Beginner", videoUrl: "" },

  // HIIT
  { id: "ex32", name: "Mountain Climbers", category: "HIIT", muscles: ["Core", "Full Body"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex33", name: "Jump Squats", category: "HIIT", muscles: ["Quads", "Glutes"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex34", name: "Box Jumps", category: "HIIT", muscles: ["Quads", "Glutes"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Compound", difficulty: "Advanced", videoUrl: "" },

  // Mobility
  { id: "ex35", name: "Cat-Cow", category: "Mobility", muscles: ["Back"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Mobility", difficulty: "Beginner", videoUrl: "" },
  { id: "ex36", name: "World's Greatest Stretch", category: "Mobility", muscles: ["Full Body"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Mobility", difficulty: "Beginner", videoUrl: "" },
  { id: "ex37", name: "Hip Flexor Stretch", category: "Mobility", muscles: ["Legs"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Mobility", difficulty: "Beginner", videoUrl: "" },

  // Full Body
  { id: "ex38", name: "Clean and Press", category: "Full Body", muscles: ["Full Body"], equipment: "Barbell", equipmentAlternatives: ["Dumbbell", "Kettlebell"], movementType: "Compound", difficulty: "Advanced", videoUrl: "" },
  { id: "ex39", name: "Turkish Get-Up", category: "Full Body", muscles: ["Full Body", "Core"], equipment: "Kettlebell", equipmentAlternatives: ["Dumbbell"], movementType: "Compound", difficulty: "Advanced", videoUrl: "" },
  { id: "ex40", name: "Thrusters", category: "Full Body", muscles: ["Quads", "Shoulders", "Full Body"], equipment: "Dumbbell", equipmentAlternatives: ["Barbell", "Kettlebell"], movementType: "Compound", difficulty: "Advanced", videoUrl: "" },

  // Mobility / Recovery
  { id: "ex41", name: "Thoracic Spine Rotation", category: "Mobility", muscles: ["Back"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Mobility", difficulty: "Beginner", videoUrl: "" },
  { id: "ex42", name: "Ankle Mobility Drill", category: "Mobility", muscles: ["Legs"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Mobility", difficulty: "Beginner", videoUrl: "" },
  { id: "ex43", name: "Pigeon Pose", category: "Mobility", muscles: ["Legs", "Glutes"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Mobility", difficulty: "Beginner", videoUrl: "" },
  { id: "ex44", name: "Standing Quad Stretch", category: "Mobility", muscles: ["Quads"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Mobility", difficulty: "Beginner", videoUrl: "" },
  { id: "ex45", name: "Child's Pose", category: "Mobility", muscles: ["Back", "Shoulders"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Mobility", difficulty: "Beginner", videoUrl: "" },

  // Athletic / Power
  { id: "ex46", name: "Broad Jump", category: "HIIT", muscles: ["Quads", "Glutes"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Compound", difficulty: "Advanced", videoUrl: "" },
  { id: "ex47", name: "Lateral Bounds", category: "HIIT", muscles: ["Quads", "Glutes"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Compound", difficulty: "Advanced", videoUrl: "" },
  { id: "ex48", name: "Dumbbell Slam", category: "Full Body", muscles: ["Full Body", "Core"], equipment: "Dumbbell", equipmentAlternatives: ["Kettlebell"], movementType: "Compound", difficulty: "Advanced", videoUrl: "" },
  { id: "ex49", name: "Single-Leg Romanian Deadlift", category: "Legs", muscles: ["Hamstrings", "Glutes"], equipment: "Dumbbell", equipmentAlternatives: ["Kettlebell", "Barbell"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex50", name: "High Knees", category: "HIIT", muscles: ["Core", "Full Body"], equipment: "Bodyweight", equipmentAlternatives: [], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },

  // More machines / variety
  { id: "ex51", name: "Cable Woodchopper", category: "Core", muscles: ["Core"], equipment: "Cable", equipmentAlternatives: ["Band"], movementType: "Isolation", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex52", name: "Leg Extension", category: "Legs", muscles: ["Quads"], equipment: "Machine", equipmentAlternatives: [], movementType: "Isolation", difficulty: "Beginner", videoUrl: "" },
  { id: "ex53", name: "Leg Curl Machine", category: "Legs", muscles: ["Hamstrings"], equipment: "Machine", equipmentAlternatives: [], movementType: "Isolation", difficulty: "Beginner", videoUrl: "" },
  { id: "ex54", name: "Chest Press Machine", category: "Chest", muscles: ["Chest", "Triceps"], equipment: "Machine", equipmentAlternatives: [], movementType: "Compound", difficulty: "Beginner", videoUrl: "" },
  { id: "ex55", name: "Assisted Pull-Up Machine", category: "Back", muscles: ["Back", "Biceps"], equipment: "Machine", equipmentAlternatives: [], movementType: "Compound", difficulty: "Beginner", videoUrl: "" },
  { id: "ex56", name: "Preacher Curl", category: "Arms", muscles: ["Biceps"], equipment: "Barbell", equipmentAlternatives: ["Dumbbell"], movementType: "Isolation", difficulty: "Intermediate", videoUrl: "" },

  // Full body / conditioning
  { id: "ex57", name: "Devil's Press", category: "Full Body", muscles: ["Full Body"], equipment: "Dumbbell", equipmentAlternatives: [], movementType: "Compound", difficulty: "Advanced", videoUrl: "" },
  { id: "ex58", name: "Farmer's Carry", category: "Full Body", muscles: ["Full Body", "Core"], equipment: "Dumbbell", equipmentAlternatives: ["Kettlebell"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex59", name: "Wall Ball", category: "Full Body", muscles: ["Quads", "Shoulders", "Full Body"], equipment: "Kettlebell", equipmentAlternatives: ["Dumbbell"], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
  { id: "ex60", name: "Rowing Sprint", category: "HIIT", muscles: ["Full Body"], equipment: "Machine", equipmentAlternatives: [], movementType: "Compound", difficulty: "Intermediate", videoUrl: "" },
];

const ALL_EQUIPMENT = ["Bodyweight", "Barbell", "Dumbbell", "Kettlebell", "Cable", "Machine", "Band"];
const ALL_MUSCLES = [...new Set(EXERCISES.flatMap((e) => e.muscles))].sort();
const MOVEMENT_TYPES = ["Compound", "Isolation", "Mobility"];

const exerciseUsesEquipment = (ex, equip) => ex.equipment === equip || (ex.equipmentAlternatives || []).includes(equip);
const exerciseNoEquipmentFriendly = (ex) => ex.equipment === "Bodyweight";

let uidCounter = 1000;
const nextUid = () => `bi_${uidCounter++}`;

const exById = (id) => EXERCISES.find((e) => e.id === id);

const WEIGHT_TYPES = ["Bodyweight", "Barbell", "Dumbbell", "Kettlebell", "Band", "Machine", "Cable", "Other"];

const defaultWeightType = (equipment) => {
  if (!equipment) return "Other";
  const match = WEIGHT_TYPES.find((w) => equipment.toLowerCase().includes(w.toLowerCase()));
  return match || "Other";
};

/* ============================================================
   TEMPLATES — presets + serialize/instantiate helpers
   A template stores exercises by id (not uid), so it can be
   loaded into the Builder fresh, any number of times, with new
   uids generated each time.
   ============================================================ */
const PRESET_TEMPLATES = [
  {
    id: "preset_push",
    name: "Push Day",
    isPreset: true,
    description: "Chest, shoulders, triceps — classic push split.",
    config: { mode: "Timer", work: 40, rest: 20, rounds: 3, targetReps: 10 },
    buildItems: [{ exerciseId: "ex1" }, { exerciseId: "ex3" }, { exerciseId: "ex12" }, { exerciseId: "ex21" }],
    burnoutItems: [{ exerciseId: "ex14" }],
  },
  {
    id: "preset_pull",
    name: "Pull Day",
    isPreset: true,
    description: "Back and biceps, straight sets.",
    config: { mode: "Reps", work: 40, rest: 25, rounds: 4, targetReps: 8 },
    buildItems: [{ exerciseId: "ex2" }, { exerciseId: "ex15" }, { exerciseId: "ex16" }, { exerciseId: "ex22" }],
    burnoutItems: [],
  },
  {
    id: "preset_leg_strength",
    name: "Leg Day Strength",
    isPreset: true,
    description: "Heavy compound lower-body work, longer rest.",
    config: { mode: "Timer", work: 45, rest: 45, rounds: 4, targetReps: 6 },
    buildItems: [{ exerciseId: "ex5" }, { exerciseId: "ex10" }, { exerciseId: "ex25" }, { exerciseId: "ex26" }],
    burnoutItems: [{ exerciseId: "ex27" }],
  },
  {
    id: "preset_hiit_lower",
    name: "HIIT Lower Body",
    isPreset: true,
    description: "Fast-paced lower-body conditioning circuit.",
    config: { mode: "Timer", work: 30, rest: 15, rounds: 4, targetReps: 15 },
    buildItems: [{ exerciseId: "ex33" }, { exerciseId: "ex24" }, { exerciseId: "ex34" }, { exerciseId: "ex9" }],
    burnoutItems: [{ exerciseId: "ex7" }],
  },
  {
    id: "preset_full_body_hiit",
    name: "Full Body HIIT",
    isPreset: true,
    description: "Total-body conditioning, minimal rest.",
    config: { mode: "Timer", work: 30, rest: 15, rounds: 4, targetReps: 12 },
    buildItems: [{ exerciseId: "ex7" }, { exerciseId: "ex9" }, { exerciseId: "ex32" }, { exerciseId: "ex40" }],
    burnoutItems: [],
  },
];

/* ============================================================
   PROGRAMS — multi-week guided plans. Each day is shaped exactly
   like a Template (config + buildItems + burnoutItems), which
   means the exact same instantiateTemplate() function that turns
   a Template into a real Builder session also works here — no
   separate engine needed. The same weekly pattern repeats for the
   program's full duration; progressionNote is shown as guidance
   rather than mechanically changing the workout.
   day: 0=Sunday .. 6=Saturday, matching JS Date.getDay().
   ============================================================ */
const PROGRAMS = [
  {
    id: "program_weight_loss",
    name: "Weight Loss",
    goal: "Weight Loss",
    color: C.amber,
    durationWeeks: 4,
    description: "Full-body HIIT and conditioning circuits to maximize calorie burn, with active recovery built in.",
    progressionNote: "Weeks 3–4: add one extra round to each circuit once the pace starts to feel manageable.",
    days: [
      { day: 0, type: "rest" },
      {
        day: 1, type: "workout", label: "Full Body HIIT",
        config: { mode: "Timer", work: 30, rest: 15, rounds: 4, targetReps: 12, rotationMode: "Circuit", circuitTransition: 10 },
        buildItems: [{ exerciseId: "ex7" }, { exerciseId: "ex9" }, { exerciseId: "ex32" }, { exerciseId: "ex40" }],
        burnoutItems: [],
      },
      {
        day: 2, type: "workout", label: "Active Recovery",
        config: { mode: "Sequence", rounds: 1 },
        buildItems: [{ exerciseId: "ex35" }, { exerciseId: "ex8" }, { exerciseId: "ex37" }, { exerciseId: "ex36" }],
        burnoutItems: [],
      },
      {
        day: 3, type: "workout", label: "Lower Body Circuit",
        config: { mode: "Timer", work: 30, rest: 15, rounds: 3, targetReps: 15, rotationMode: "Circuit", circuitTransition: 10 },
        buildItems: [{ exerciseId: "ex33" }, { exerciseId: "ex24" }, { exerciseId: "ex34" }, { exerciseId: "ex9" }],
        burnoutItems: [],
      },
      { day: 4, type: "rest" },
      {
        day: 5, type: "workout", label: "Upper Body + Core",
        config: { mode: "Timer", work: 40, rest: 20, rounds: 3, targetReps: 12 },
        buildItems: [{ exerciseId: "ex11" }, { exerciseId: "ex15" }, { exerciseId: "ex6" }, { exerciseId: "ex29" }],
        burnoutItems: [],
      },
      {
        day: 6, type: "workout", label: "HIIT Circuit",
        config: { mode: "Timer", work: 20, rest: 10, rounds: 4, targetReps: 15, rotationMode: "Circuit", circuitTransition: 8 },
        buildItems: [{ exerciseId: "ex7" }, { exerciseId: "ex32" }, { exerciseId: "ex50" }, { exerciseId: "ex33" }],
        burnoutItems: [],
      },
    ],
  },
  {
    id: "program_full_body_strength",
    name: "Full Body Strength",
    goal: "Strength",
    color: C.blue,
    durationWeeks: 4,
    description: "Classic push/pull/legs split with real rest days — build strength without burning out.",
    progressionNote: "Weeks 3–4: add 5–10 lbs to your main lifts if last week felt manageable at RPE 7 or below.",
    days: [
      { day: 0, type: "rest" },
      {
        day: 1, type: "workout", label: "Push",
        config: { mode: "Reps", work: 40, rest: 25, rounds: 3, targetReps: 10 },
        buildItems: [{ exerciseId: "ex1" }, { exerciseId: "ex3" }, { exerciseId: "ex12" }, { exerciseId: "ex21" }],
        burnoutItems: [{ exerciseId: "ex14" }],
      },
      {
        day: 2, type: "workout", label: "Pull",
        config: { mode: "Reps", work: 40, rest: 25, rounds: 4, targetReps: 8 },
        buildItems: [{ exerciseId: "ex2" }, { exerciseId: "ex15" }, { exerciseId: "ex16" }, { exerciseId: "ex56" }],
        burnoutItems: [],
      },
      { day: 3, type: "rest" },
      {
        day: 4, type: "workout", label: "Legs",
        config: { mode: "Timer", work: 45, rest: 45, rounds: 4, targetReps: 6 },
        buildItems: [{ exerciseId: "ex5" }, { exerciseId: "ex10" }, { exerciseId: "ex25" }, { exerciseId: "ex26" }],
        burnoutItems: [{ exerciseId: "ex27" }],
      },
      {
        day: 5, type: "workout", label: "Full Body Accessory",
        config: { mode: "Reps", work: 40, rest: 20, rounds: 3, targetReps: 12 },
        buildItems: [{ exerciseId: "ex58" }, { exerciseId: "ex51" }, { exerciseId: "ex20" }, { exerciseId: "ex27" }],
        burnoutItems: [],
      },
      { day: 6, type: "rest" },
    ],
  },
  {
    id: "program_athletic",
    name: "Athletic Performance",
    goal: "Athletics",
    color: "#8B5CF6",
    durationWeeks: 4,
    description: "Power, speed, and conditioning work modeled on how athletes actually train — with real mobility days.",
    progressionNote: "Weeks 3–4: push for slightly more explosive effort on Power and Speed days — quality over fatigue.",
    days: [
      { day: 0, type: "rest" },
      {
        day: 1, type: "workout", label: "Power",
        config: { mode: "Timer", work: 20, rest: 40, rounds: 4, targetReps: 8, rotationMode: "Circuit", circuitTransition: 15 },
        buildItems: [{ exerciseId: "ex46" }, { exerciseId: "ex34" }, { exerciseId: "ex48" }, { exerciseId: "ex9" }],
        burnoutItems: [],
      },
      {
        day: 2, type: "workout", label: "Speed & Agility",
        config: { mode: "Timer", work: 20, rest: 20, rounds: 4, targetReps: 15, rotationMode: "Circuit", circuitTransition: 10 },
        buildItems: [{ exerciseId: "ex47" }, { exerciseId: "ex50" }, { exerciseId: "ex32" }, { exerciseId: "ex7" }],
        burnoutItems: [],
      },
      {
        day: 3, type: "workout", label: "Mobility",
        config: { mode: "Sequence", rounds: 1 },
        buildItems: [{ exerciseId: "ex41" }, { exerciseId: "ex43" }, { exerciseId: "ex42" }, { exerciseId: "ex36" }],
        burnoutItems: [],
      },
      {
        day: 4, type: "workout", label: "Strength",
        config: { mode: "Timer", work: 45, rest: 45, rounds: 3, targetReps: 6 },
        buildItems: [{ exerciseId: "ex5" }, { exerciseId: "ex10" }, { exerciseId: "ex26" }, { exerciseId: "ex57" }],
        burnoutItems: [],
      },
      {
        day: 5, type: "workout", label: "Conditioning",
        config: { mode: "Timer", work: 30, rest: 15, rounds: 4, targetReps: 15, rotationMode: "Circuit", circuitTransition: 10 },
        buildItems: [{ exerciseId: "ex60" }, { exerciseId: "ex59" }, { exerciseId: "ex9" }, { exerciseId: "ex7" }],
        burnoutItems: [],
      },
      {
        day: 6, type: "workout", label: "Active Recovery",
        config: { mode: "Sequence", rounds: 1 },
        buildItems: [{ exerciseId: "ex8" }, { exerciseId: "ex35" }, { exerciseId: "ex44" }, { exerciseId: "ex45" }],
        burnoutItems: [],
      },
    ],
  },
  {
    id: "program_recovery",
    name: "Recovery & Mobility",
    goal: "Recovery",
    color: "#16A34A",
    durationWeeks: 4,
    description: "Low-intensity mobility and light full-body work — for deloads, injury recovery, or just a reset.",
    progressionNote: "This program isn't meant to progress in intensity — the goal is consistency, not overload.",
    days: [
      { day: 0, type: "rest" },
      {
        day: 1, type: "workout", label: "Mobility Flow",
        config: { mode: "Sequence", rounds: 1 },
        buildItems: [{ exerciseId: "ex8" }, { exerciseId: "ex35" }, { exerciseId: "ex45" }, { exerciseId: "ex43" }],
        burnoutItems: [],
      },
      {
        day: 2, type: "workout", label: "Light Core",
        config: { mode: "Reps", work: 30, rest: 30, rounds: 2, targetReps: 10 },
        buildItems: [{ exerciseId: "ex6" }, { exerciseId: "ex29" }, { exerciseId: "ex31" }],
        burnoutItems: [],
      },
      { day: 3, type: "rest" },
      {
        day: 4, type: "workout", label: "Mobility Flow",
        config: { mode: "Sequence", rounds: 1 },
        buildItems: [{ exerciseId: "ex41" }, { exerciseId: "ex37" }, { exerciseId: "ex44" }, { exerciseId: "ex42" }],
        burnoutItems: [],
      },
      {
        day: 5, type: "workout", label: "Light Full Body",
        config: { mode: "Reps", work: 30, rest: 30, rounds: 2, targetReps: 10 },
        buildItems: [{ exerciseId: "ex11" }, { exerciseId: "ex24" }, { exerciseId: "ex6" }],
        burnoutItems: [],
      },
      { day: 6, type: "rest" },
    ],
  },
];

function getTodayProgramDay(activeProgramRow) {
  if (!activeProgramRow) return null;
  const program = PROGRAMS.find((p) => p.id === activeProgramRow.program_id);
  if (!program) return null;
  const startDay = new Date(activeProgramRow.started_at);
  startDay.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysSinceStart = Math.round((today.getTime() - startDay.getTime()) / 86400000);
  const totalDays = program.durationWeeks * 7;
  if (daysSinceStart >= totalDays) return { program, complete: true };
  const currentWeek = Math.floor(daysSinceStart / 7) + 1;
  const dayDef = program.days.find((d) => d.day === today.getDay());
  return { program, week: currentWeek, dayDef, complete: false };
}

function serializeTemplate(name, buildList, burnoutList, config) {
  const groupIds = {};
  let groupCounter = 0;
  return {
    id: `tpl_${Date.now()}`,
    name,
    isPreset: false,
    description: `${buildList.length} exercises · ${config.mode}`,
    config: { ...config },
    buildItems: buildList.map((item) => {
      let group = null;
      if (item.supersetGroup) {
        if (!(item.supersetGroup in groupIds)) groupIds[item.supersetGroup] = `g${groupCounter++}`;
        group = groupIds[item.supersetGroup];
      }
      return {
        exerciseId: item.id,
        modeOverride: item.modeOverride || "Session Default",
        customWork: item.customWork || null,
        customReps: item.customReps || null,
        note: item.note || "",
        supersetGroup: group,
        supersetTransition: item.supersetTransition || null,
      };
    }),
    burnoutItems: burnoutList.map((item) => ({ exerciseId: item.id })),
  };
}

function instantiateTemplate(template) {
  const groupMap = {};
  const buildList = (template.buildItems || [])
    .map((bi) => {
      const ex = exById(bi.exerciseId);
      if (!ex) return null;
      let group = null;
      if (bi.supersetGroup) {
        if (!groupMap[bi.supersetGroup]) groupMap[bi.supersetGroup] = `sg_${nextUid()}`;
        group = groupMap[bi.supersetGroup];
      }
      return {
        ...ex,
        uid: nextUid(),
        modeOverride: bi.modeOverride || "Session Default",
        customWork: bi.customWork || null,
        customReps: bi.customReps || null,
        note: bi.note || "",
        supersetGroup: group,
        supersetTransition: bi.supersetTransition || null,
      };
    })
    .filter(Boolean);
  const burnoutList = (template.burnoutItems || [])
    .map((bi) => {
      const ex = exById(bi.exerciseId);
      return ex ? { ...ex, uid: nextUid() } : null;
    })
    .filter(Boolean);
  return { buildList, burnoutList, config: { ...template.config } };
}

/* ============================================================
   CLOUD SYNC — transforms between local shapes and Supabase rows,
   plus the actual fetch/insert calls for History and Templates.
   ============================================================ */
function sessionRecordToDbPayload(record, userId) {
  return {
    session: {
      user_id: userId,
      source: record.source,
      mode: record.mode,
      duration_sec: record.durationSec,
      started_at: new Date(record.date).toISOString(),
      overall_rpe: record.overallRpe || null,
    },
    sets: record.sets.map((s) => ({
      exercise_id: s.exerciseId,
      set_number: s.setNumber || null,
      reps: s.reps || null,
      weight: s.weight || null,
      weight_type: s.weightType || null,
      rpe: s.rpe || null,
      logged_at: new Date(s.loggedAt || record.date).toISOString(),
    })),
  };
}

function dbSessionToRecord(row) {
  return {
    id: row.id,
    date: new Date(row.started_at).getTime(),
    source: row.source,
    mode: row.mode,
    durationSec: row.duration_sec,
    overallRpe: row.overall_rpe,
    sets: (row.sets || []).map((s) => ({
      id: s.id,
      exerciseId: s.exercise_id,
      exerciseName: s.exercises?.name || exById(s.exercise_id)?.name || "Exercise",
      setNumber: s.set_number,
      reps: s.reps,
      weight: s.weight,
      weightType: s.weight_type,
      rpe: s.rpe,
      loggedAt: new Date(s.logged_at).getTime(),
    })),
  };
}

function templateToDbPayload(tpl, userId) {
  const buildRows = tpl.buildItems.map((bi, i) => ({
    exercise_id: bi.exerciseId,
    order_index: i,
    mode_override: bi.modeOverride || null,
    custom_work: bi.customWork || null,
    custom_reps: bi.customReps || null,
    note: bi.note || null,
    superset_group: bi.supersetGroup || null,
    superset_transition: bi.supersetTransition || null,
    is_burnout: false,
  }));
  const burnoutRows = tpl.burnoutItems.map((bi, i) => ({
    exercise_id: bi.exerciseId,
    order_index: i,
    mode_override: null,
    custom_work: null,
    custom_reps: null,
    note: null,
    superset_group: null,
    superset_transition: null,
    is_burnout: true,
  }));
  return {
    template: { owner_id: userId, name: tpl.name, is_preset: false, config: tpl.config },
    items: [...buildRows, ...burnoutRows],
  };
}

function dbTemplateToLocal(row) {
  const items = [...(row.template_exercises || [])].sort((a, b) => a.order_index - b.order_index);
  const buildItems = items.filter((i) => !i.is_burnout);
  return {
    id: row.id,
    name: row.name,
    isPreset: row.is_preset,
    description: `${buildItems.length} exercises · ${row.config?.mode || "Timer"}`,
    config: row.config,
    buildItems: buildItems.map((i) => ({
      exerciseId: i.exercise_id,
      modeOverride: i.mode_override || "Session Default",
      customWork: i.custom_work,
      customReps: i.custom_reps,
      note: i.note || "",
      supersetGroup: i.superset_group,
      supersetTransition: i.superset_transition,
    })),
    burnoutItems: items.filter((i) => i.is_burnout).map((i) => ({ exerciseId: i.exercise_id })),
  };
}

async function fetchCloudHistory(token) {
  const rows = await supabaseRest("sessions?select=*,sets(*,exercises(name))&order=started_at.desc", { token });
  return (rows || []).map(dbSessionToRecord);
}

async function insertCloudSession(token, userId, record) {
  const { session, sets } = sessionRecordToDbPayload(record, userId);
  const [insertedSession] = await supabaseRest("sessions", { method: "POST", token, body: session });
  let insertedSets = [];
  if (sets.length) {
    insertedSets = await supabaseRest("sets", { method: "POST", token, body: sets.map((s) => ({ ...s, session_id: insertedSession.id })) });
  }
  // PostgREST returns bulk-inserted rows in the same order submitted — match them
  // back up positionally so each set carries its real id (needed to edit/delete later).
  const setsWithNames = (insertedSets || []).map((s, i) => ({ ...s, exercises: { name: record.sets[i]?.exerciseName } }));
  return dbSessionToRecord({ ...insertedSession, sets: setsWithNames });
}

async function updateCloudSet(token, setId, patch) {
  const dbPatch = {};
  if ("reps" in patch) dbPatch.reps = patch.reps;
  if ("weight" in patch) dbPatch.weight = patch.weight;
  if ("weightType" in patch) dbPatch.weight_type = patch.weightType;
  if ("rpe" in patch) dbPatch.rpe = patch.rpe;
  await supabaseRest(`sets?id=eq.${setId}`, { method: "PATCH", token, body: dbPatch });
}

async function deleteCloudSet(token, setId) {
  await supabaseRest(`sets?id=eq.${setId}`, { method: "DELETE", token });
}

async function deleteCloudSession(token, sessionId) {
  // sets cascade-delete automatically via the existing foreign key
  await supabaseRest(`sessions?id=eq.${sessionId}`, { method: "DELETE", token });
}

async function fetchActiveProgram(token) {
  const rows = await supabaseRest("user_programs?select=*&order=started_at.desc&limit=1", { token });
  return rows?.[0] || null;
}

async function startCloudProgram(token, userId, programId) {
  await supabaseRest(`user_programs?user_id=eq.${userId}`, { method: "DELETE", token });
  const [row] = await supabaseRest("user_programs", { method: "POST", token, body: { user_id: userId, program_id: programId, started_at: new Date().toISOString() } });
  return row;
}

async function cancelCloudProgram(token, userId) {
  await supabaseRest(`user_programs?user_id=eq.${userId}`, { method: "DELETE", token });
}

async function fetchCloudTemplates(token) {
  const rows = await supabaseRest("templates?select=*,template_exercises(*)&is_preset=eq.false&order=created_at.desc", { token });
  return (rows || []).map(dbTemplateToLocal);
}

async function insertCloudTemplate(token, userId, tpl) {
  const { template, items } = templateToDbPayload(tpl, userId);
  const [insertedTemplate] = await supabaseRest("templates", { method: "POST", token, body: template });
  let insertedItems = [];
  if (items.length) {
    insertedItems = await supabaseRest("template_exercises", { method: "POST", token, body: items.map((it) => ({ ...it, template_id: insertedTemplate.id })) });
  }
  return dbTemplateToLocal({ ...insertedTemplate, template_exercises: insertedItems });
}

// A superset group is only valid if it has 2+ members AND those members are still
// contiguous in the list. Dragging a member elsewhere, sending one to Burnout, or
// removing one from the build entirely can break this — this normalizes it.
function normalizeSupersetGroups(list) {
  const counts = {};
  const positions = {};
  list.forEach((b, i) => {
    if (b.supersetGroup) {
      counts[b.supersetGroup] = (counts[b.supersetGroup] || 0) + 1;
      (positions[b.supersetGroup] = positions[b.supersetGroup] || []).push(i);
    }
  });
  return list.map((b) => {
    if (!b.supersetGroup) return b;
    const pos = positions[b.supersetGroup];
    const contiguous = pos.every((p, idx) => idx === 0 || p === pos[idx - 1] + 1);
    if (counts[b.supersetGroup] < 2 || !contiguous) {
      return { ...b, supersetGroup: null, supersetTransition: null };
    }
    return b;
  });
}

/* ============================================================
   Shared small bits
   ============================================================ */
const Chip = ({ label, active, onClick, color }) => (
  <button
    onClick={onClick}
    className="fg-mono"
    style={{
      padding: "7px 14px",
      borderRadius: 20,
      fontSize: 12,
      letterSpacing: "0.03em",
      whiteSpace: "nowrap",
      border: `1px solid ${active ? (color || C.blue) : C.line}`,
      background: active ? `${color || C.blue}22` : "transparent",
      color: active ? (color || C.accent) : C.textLo,
      flexShrink: 0,
    }}
  >
    {label}
  </button>
);

/* ============================================================
   Exercise detail sheet (modal)
   ============================================================ */
function ExerciseDetailSheet({ exercise, onClose, onAddToBuild, onAddToBurnout, addedIds, burnoutIds }) {
  if (!exercise) return null;
  const isAdded = addedIds && addedIds.has(exercise.id);
  const isBurnout = burnoutIds && burnoutIds.has(exercise.id);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "flex-end",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()} className="fg-sheet-in"
        style={{
          width: "100%",
          background: C.bgRaised,
          borderTop: `1px solid ${C.line}`,
          borderRadius: "20px 20px 0 0",
          padding: 22,
          maxHeight: "70vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div
              className="fg-mono"
              style={{ color: C.accent, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase" }}
            >
              {exercise.category} · {exercise.equipment}
            </div>
            <h2 className="fg-display" style={{ color: C.textHi, fontSize: 28, fontWeight: 700, margin: "4px 0 0" }}>
              {exercise.name}
            </h2>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none" }}>
            <X size={22} color={C.textLo} />
          </button>
        </div>

        {/* placeholder muscle figure */}
        <div
          style={{
            marginTop: 18,
            height: 140,
            borderRadius: 14,
            background: `${C.blue}0F`,
            border: `1px solid ${C.line}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12 }}>
            [ anatomical figure — front / back ]
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
          {exercise.muscles.map((m) => (
            <Chip key={m} label={m} active color={C.accent} />
          ))}
          <Chip label={exercise.difficulty} active color={C.amber} />
          {exercise.movementType && <Chip label={exercise.movementType} active color="#8B5CF6" />}
        </div>

        {exercise.equipmentAlternatives && exercise.equipmentAlternatives.length > 0 && (
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>
            Also works with: {exercise.equipmentAlternatives.join(", ")}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
          <button
            onClick={() => { onAddToBuild(exercise); onClose(); }}
            className="fg-display"
            style={{
              flex: 1,
              background: isAdded ? "#16A34A" : C.blue,
              border: "none",
              borderRadius: 12,
              padding: "14px",
              color: "white",
              fontWeight: 700,
              fontSize: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            {isAdded ? <Check size={17} /> : <Plus size={17} />} {isAdded ? "Added" : "Add to Build"}
          </button>
          <button
            onClick={() => { onAddToBurnout(exercise); onClose(); }}
            className="fg-display"
            style={{
              flex: 1,
              background: isBurnout ? C.amber : "transparent",
              border: `1px solid ${C.amber}`,
              borderRadius: 12,
              padding: "14px",
              color: isBurnout ? C.bg : C.amber,
              fontWeight: 700,
              fontSize: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <Flame size={17} fill={isBurnout ? C.bg : "none"} /> {isBurnout ? "Queued for Burnout" : "Add to Burnout"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   LIBRARY TAB
   ============================================================ */
function LibraryTab({ onAddToBuild, onAddToBurnout, addedIds, burnoutIds }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [detail, setDetail] = useState(null);
  const [noEquipmentOnly, setNoEquipmentOnly] = useState(false);
  const [showFilterSheet, setShowFilterSheet] = useState(false);
  const [selectedMuscles, setSelectedMuscles] = useState([]);
  const [selectedEquipment, setSelectedEquipment] = useState([]);
  const [selectedDifficulties, setSelectedDifficulties] = useState([]);
  const [selectedMovementTypes, setSelectedMovementTypes] = useState([]);
  const [sortBy, setSortBy] = useState("Category");

  const toggleInArray = (arr, setArr, val) => setArr(arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]);

  const activeFilterCount =
    selectedMuscles.length + selectedEquipment.length + selectedDifficulties.length + selectedMovementTypes.length + (noEquipmentOnly ? 1 : 0);

  const clearAllFilters = () => {
    setSelectedMuscles([]);
    setSelectedEquipment([]);
    setSelectedDifficulties([]);
    setSelectedMovementTypes([]);
    setNoEquipmentOnly(false);
  };

  const filtered = EXERCISES.filter((ex) => {
    const q = query.toLowerCase();
    const matchesQuery = !q || ex.name.toLowerCase().includes(q) || ex.muscles.some((m) => m.toLowerCase().includes(q));
    const matchesCategory = category === "All" || ex.category === category;
    const matchesNoEquip = !noEquipmentOnly || exerciseNoEquipmentFriendly(ex);
    const matchesMuscles = selectedMuscles.length === 0 || selectedMuscles.some((m) => ex.muscles.includes(m));
    const matchesEquipment = selectedEquipment.length === 0 || selectedEquipment.some((eq) => exerciseUsesEquipment(ex, eq));
    const matchesDifficulty = selectedDifficulties.length === 0 || selectedDifficulties.includes(ex.difficulty);
    const matchesMovement = selectedMovementTypes.length === 0 || selectedMovementTypes.includes(ex.movementType);
    return matchesQuery && matchesCategory && matchesNoEquip && matchesMuscles && matchesEquipment && matchesDifficulty && matchesMovement;
  }).sort((a, b) => {
    if (sortBy === "Name") return a.name.localeCompare(b.name);
    if (sortBy === "Difficulty") return DIFFICULTY_ORDER.indexOf(a.difficulty) - DIFFICULTY_ORDER.indexOf(b.difficulty);
    return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
  });

  return (
    <div style={{ padding: "16px 20px 100px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: C.bgCard,
          border: `1px solid ${C.line}`,
          borderRadius: 12,
          padding: "12px 14px",
          marginBottom: 14,
        }}
      >
        <Search size={16} color={C.textLo} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or muscle"
          className="fg-mono"
          style={{
            background: "none",
            border: "none",
            outline: "none",
            color: C.textHi,
            fontSize: 14,
            width: "100%",
          }}
        />
      </div>

      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8 }}>
        {CATEGORIES.map((c) => (
          <Chip key={c} label={c} active={category === c} onClick={() => setCategory(c)} />
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, marginBottom: 4 }}>
        <button
          onClick={() => setNoEquipmentOnly((v) => !v)}
          className="fg-mono"
          style={{
            padding: "8px 14px", borderRadius: 20, fontSize: 12, display: "flex", alignItems: "center", gap: 6,
            border: `1px solid ${noEquipmentOnly ? "#22C55E" : C.line}`,
            background: noEquipmentOnly ? "#22C55E22" : "transparent",
            color: noEquipmentOnly ? "#4ADE80" : C.textLo,
            flexShrink: 0,
          }}
        >
          <Check size={12} style={{ opacity: noEquipmentOnly ? 1 : 0 }} /> No Equipment Needed
        </button>
        <button
          onClick={() => setShowFilterSheet(true)}
          className="fg-mono"
          style={{
            padding: "8px 14px", borderRadius: 20, fontSize: 12, display: "flex", alignItems: "center", gap: 6,
            border: `1px solid ${activeFilterCount > 0 ? C.blue : C.line}`,
            background: activeFilterCount > 0 ? `${C.blue}22` : "transparent",
            color: activeFilterCount > 0 ? C.accent : C.textLo,
            flexShrink: 0,
            position: "relative",
          }}
        >
          <MoreHorizontal size={13} /> Filters {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
        </button>
      </div>

      <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 10, marginBottom: 6 }}>
        {filtered.length} exercise{filtered.length !== 1 ? "s" : ""}
      </div>

      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.length === 0 && (
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, textAlign: "center", padding: 30 }}>
            No exercises match. Try different filters.
          </div>
        )}
        {filtered.map((ex) => {
          const isAdded = addedIds && addedIds.has(ex.id);
          const isBurnout = burnoutIds && burnoutIds.has(ex.id);
          return (
            <div
              key={ex.id}
              onClick={() => setDetail(ex)}
              className="fg-tap"
              style={{
                background: C.bgCard,
                border: `1px solid ${C.line}`,
                borderRadius: 12,
                padding: "14px 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div className="fg-display" style={{ color: C.textHi, fontSize: 17, fontWeight: 600 }}>
                  {ex.name}
                </div>
                <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 3 }}>
                  {ex.category} · {ex.equipment} · {ex.muscles.join(", ")}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={(e) => { e.stopPropagation(); onAddToBurnout(ex); }}
                  style={{
                    width: 32, height: 32, borderRadius: 8,
                    background: isBurnout ? C.amber : `${C.amber}18`,
                    border: `1px solid ${C.amber}${isBurnout ? "" : "44"}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <Flame size={14} color={isBurnout ? C.bg : C.amber} fill={isBurnout ? C.bg : "none"} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onAddToBuild(ex); }}
                  style={{
                    width: 32, height: 32, borderRadius: 8,
                    background: isAdded ? "#16A34A22" : `${C.blue}18`,
                    border: `1px solid ${isAdded ? "#16A34A" : C.blue + "44"}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {isAdded ? <Check size={16} color="#22C55E" /> : <Plus size={16} color={C.accent} />}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <ExerciseDetailSheet
        exercise={detail}
        onClose={() => setDetail(null)}
        onAddToBuild={onAddToBuild}
        onAddToBurnout={onAddToBurnout}
        addedIds={addedIds}
        burnoutIds={burnoutIds}
      />

      {showFilterSheet && (
        <FilterSheet
          onClose={() => setShowFilterSheet(false)}
          resultCount={filtered.length}
          selectedMuscles={selectedMuscles}
          setSelectedMuscles={setSelectedMuscles}
          selectedEquipment={selectedEquipment}
          setSelectedEquipment={setSelectedEquipment}
          selectedDifficulties={selectedDifficulties}
          setSelectedDifficulties={setSelectedDifficulties}
          selectedMovementTypes={selectedMovementTypes}
          setSelectedMovementTypes={setSelectedMovementTypes}
          sortBy={sortBy}
          setSortBy={setSortBy}
          onClearAll={clearAllFilters}
          toggleInArray={toggleInArray}
        />
      )}
    </div>
  );
}

/* ============================================================
   FILTER SHEET — the deeper exercise filtering modal
   ============================================================ */
function FilterSheet({
  onClose, resultCount,
  selectedMuscles, setSelectedMuscles,
  selectedEquipment, setSelectedEquipment,
  selectedDifficulties, setSelectedDifficulties,
  selectedMovementTypes, setSelectedMovementTypes,
  sortBy, setSortBy,
  onClearAll, toggleInArray,
}) {
  const section = (title, children) => (
    <div style={{ marginBottom: 20 }}>
      <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
        {title}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{children}</div>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 55, display: "flex", alignItems: "flex-end" }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()} className="fg-sheet-in"
        style={{ width: "100%", maxHeight: "85vh", overflowY: "auto", background: C.bgRaised, borderTop: `1px solid ${C.line}`, borderRadius: "20px 20px 0 0", padding: 22 }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div className="fg-display" style={{ color: C.textHi, fontSize: 22, fontWeight: 700 }}>Filters</div>
          <button onClick={onClose} style={{ background: "none", border: "none" }}>
            <X size={20} color={C.textLo} />
          </button>
        </div>

        {section(
          "Muscle Group",
          ALL_MUSCLES.map((m) => (
            <Chip key={m} label={m} active={selectedMuscles.includes(m)} onClick={() => toggleInArray(selectedMuscles, setSelectedMuscles, m)} color={C.accent} />
          ))
        )}

        {section(
          "Equipment",
          ALL_EQUIPMENT.map((eq) => (
            <Chip key={eq} label={eq} active={selectedEquipment.includes(eq)} onClick={() => toggleInArray(selectedEquipment, setSelectedEquipment, eq)} color={C.blue} />
          ))
        )}

        {section(
          "Movement Type",
          MOVEMENT_TYPES.map((mt) => (
            <Chip key={mt} label={mt} active={selectedMovementTypes.includes(mt)} onClick={() => toggleInArray(selectedMovementTypes, setSelectedMovementTypes, mt)} color="#8B5CF6" />
          ))
        )}

        {section(
          "Difficulty",
          DIFFICULTY_ORDER.map((d) => (
            <Chip key={d} label={d} active={selectedDifficulties.includes(d)} onClick={() => toggleInArray(selectedDifficulties, setSelectedDifficulties, d)} color={C.amber} />
          ))
        )}

        {section(
          "Sort By",
          ["Category", "Name", "Difficulty"].map((s) => (
            <Chip key={s} label={s} active={sortBy === s} onClick={() => setSortBy(s)} />
          ))
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button
            onClick={onClearAll}
            className="fg-display"
            style={{ flex: 1, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px", color: C.textLo, fontWeight: 600, fontSize: 15 }}
          >
            Clear All
          </button>
          <button
            onClick={onClose}
            className="fg-display"
            style={{ flex: 1, background: C.blue, border: "none", borderRadius: 12, padding: "14px", color: "white", fontWeight: 700, fontSize: 15 }}
          >
            Show {resultCount} Result{resultCount !== 1 ? "s" : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Per-exercise ··· override menu
   ============================================================ */
function OverrideMenu({ item, config, onChange, onClose, onUnlinkSuperset, onChangeTransition, groupSize }) {
  const resolvedMode = item.modeOverride && item.modeOverride !== "Session Default" ? item.modeOverride : config.mode;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "flex-end",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()} className="fg-sheet-in"
        style={{
          width: "100%",
          background: C.bgRaised,
          borderTop: `1px solid ${C.line}`,
          borderRadius: "20px 20px 0 0",
          padding: 22,
          maxHeight: "82vh",
          overflowY: "auto",
        }}
      >
        <div className="fg-display" style={{ color: C.textHi, fontSize: 20, fontWeight: 700, marginBottom: 16 }}>
          {item.name}
        </div>

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 8 }}>
          MODE OVERRIDE {item.modeOverride === "Session Default" || !item.modeOverride ? `(currently ${config.mode})` : ""}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          {["Session Default", "Timer", "Reps", "Sequence"].map((m) => (
            <Chip key={m} label={m} active={(item.modeOverride || "Session Default") === m} onClick={() => onChange({ modeOverride: m })} />
          ))}
        </div>

        {resolvedMode === "Timer" && (
          <>
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 8 }}>
              WORK TIME
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <Chip label="Use Session Default" active={!item.customWork} onClick={() => onChange({ customWork: null })} />
              <Chip label="Custom" active={!!item.customWork} onClick={() => onChange({ customWork: item.customWork || 40 })} />
            </div>
            {item.customWork ? (
              <div style={{ marginBottom: 18 }}>
                <DialInput value={Number(item.customWork)} onChange={(v) => onChange({ customWork: v })} min={5} max={300} step={5} unit="s" />
              </div>
            ) : (
              <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, marginBottom: 18 }}>Currently using the session default.</div>
            )}
          </>
        )}

        {resolvedMode === "Reps" && (
          <>
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 8 }}>
              TARGET REPS
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <Chip label="Use Session Default" active={!item.customReps} onClick={() => onChange({ customReps: null })} />
              <Chip label="Custom" active={!!item.customReps} onClick={() => onChange({ customReps: item.customReps || 10 })} />
            </div>
            {item.customReps ? (
              <div style={{ marginBottom: 18 }}>
                <DialInput value={Number(item.customReps)} onChange={(v) => onChange({ customReps: v })} min={1} max={100} step={1} unit="" />
              </div>
            ) : (
              <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, marginBottom: 18 }}>Currently using the session default.</div>
            )}
          </>
        )}

        {resolvedMode === "Sequence" && (
          <div
            className="fg-mono"
            style={{ color: C.textLo, fontSize: 12, background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginBottom: 18, lineHeight: 1.5 }}
          >
            No timer or rep target. You'll log this set and move on at your own pace.
          </div>
        )}

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 8 }}>
          COACHING CUE
        </div>
        <textarea
          value={item.note || ""}
          placeholder="e.g. Chest up, drive through heels"
          onChange={(e) => onChange({ note: e.target.value })}
          className="fg-mono"
          style={{
            width: "100%", background: C.bgCard, border: `1px solid ${C.line}`,
            borderRadius: 10, padding: "12px 14px", color: C.textHi, fontSize: 14, marginBottom: 18,
            minHeight: 60, resize: "none",
          }}
        />

        {item.supersetGroup ? (
          <>
            <div
              style={{
                background: "#8B5CF61A", border: `1px solid #8B5CF666`, borderRadius: 10, padding: "12px 14px", marginBottom: 12,
                display: "flex", alignItems: "center", gap: 8,
              }}
            >
              <Link2 size={15} color="#C4B5FD" />
              <span className="fg-mono" style={{ color: "#C4B5FD", fontSize: 12 }}>
                Part of a {groupSize}-exercise superset
              </span>
            </div>

            <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 8 }}>
              TRANSITION BETWEEN EXERCISES
            </div>
            <div style={{ marginBottom: 14 }}>
              <DialInput value={Number(item.supersetTransition ?? 5)} onChange={(v) => onChangeTransition(v)} min={0} max={60} step={1} unit="s" />
            </div>

            <button
              onClick={onUnlinkSuperset}
              className="fg-display"
              style={{
                width: "100%", background: "transparent", border: `1px solid ${C.line}`, borderRadius: 10,
                padding: "13px", color: C.textLo, fontWeight: 600, fontSize: 15, marginBottom: 4,
              }}
            >
              Unlink Superset
            </button>
          </>
        ) : (
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, marginBottom: 4 }}>
            To superset this exercise with others, use "Link Superset" in the build list.
          </div>
        )}

        <button
          onClick={onClose}
          className="fg-display"
          style={{
            width: "100%", marginTop: 16, background: C.blue, border: "none",
            borderRadius: 10, padding: "13px", color: "white", fontWeight: 700, fontSize: 15,
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   BUILDER TAB
   ============================================================ */
function BuilderTab({ buildList, setBuildList, burnoutList, setBurnoutList, config, setConfig, onSaveTemplate }) {
  const [menuItemId, setMenuItemId] = useState(null);
  const [dragIndex, setDragIndex] = useState(null);
  const [dragOverBurnout, setDragOverBurnout] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);

  const menuItem = buildList.find((b) => b.uid === menuItemId);
  const menuItemGroupSize = menuItem?.supersetGroup ? buildList.filter((b) => b.supersetGroup === menuItem.supersetGroup).length : 0;

  const updateItem = (uid, patch) => {
    setBuildList((list) => list.map((b) => (b.uid === uid ? { ...b, ...patch } : b)));
  };

  const removeItem = (uid) => setBuildList((list) => normalizeSupersetGroups(list.filter((b) => b.uid !== uid)));

  const handleDrop = (index) => {
    if (dragIndex === null || dragIndex === index) return;
    setBuildList((list) => {
      const next = [...list];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(index, 0, moved);
      return normalizeSupersetGroups(next);
    });
    setDragIndex(null);
  };

  const moveToBurnout = (uid) => {
    const item = buildList.find((b) => b.uid === uid);
    if (!item) return;
    setBurnoutList((l) => [...l, { ...item, supersetGroup: null, supersetTransition: null }]);
    removeItem(uid);
  };

  const unlinkGroup = (groupId) => {
    setBuildList((list) => list.map((b) => (b.supersetGroup === groupId ? { ...b, supersetGroup: null, supersetTransition: null } : b)));
  };

  const changeTransition = (groupId, value) => {
    setBuildList((list) => list.map((b) => (b.supersetGroup === groupId ? { ...b, supersetTransition: value } : b)));
  };

  const toggleSelected = (uid) => {
    setSelectedIds((ids) => (ids.includes(uid) ? ids.filter((x) => x !== uid) : [...ids, uid]));
  };

  const selectedIndices = selectedIds
    .map((uid) => buildList.findIndex((b) => b.uid === uid))
    .sort((a, b) => a - b);
  const isContiguous = selectedIndices.length >= 2 && selectedIndices.every((v, i) => i === 0 || v === selectedIndices[i - 1] + 1);

  const createSuperset = () => {
    if (!isContiguous) return;
    const groupId = `sg_${nextUid()}`;
    setBuildList((list) =>
      list.map((b, i) => (i >= selectedIndices[0] && i <= selectedIndices[selectedIndices.length - 1] ? { ...b, supersetGroup: groupId, supersetTransition: 5 } : b))
    );
    setSelectMode(false);
    setSelectedIds([]);
  };

  const modeLabel = (item) => (item.modeOverride && item.modeOverride !== "Session Default" ? item.modeOverride : config.mode);

  return (
    <div style={{ padding: "16px 20px 130px" }}>
      {/* session mode + timer config */}
      <div style={{ background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, marginBottom: 18 }}>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 10 }}>
          SESSION MODE
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {["Timer", "Reps", "Sequence"].map((m) => (
            <Chip key={m} label={m} active={config.mode === m} onClick={() => setConfig((c) => ({ ...c, mode: m }))} />
          ))}
        </div>

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 10 }}>
          ROTATION ORDER
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          {["Exercise-First", "Circuit"].map((m) => (
            <Chip key={m} label={m === "Exercise-First" ? "Complete Each Exercise" : "Rotate Through Circuit"} active={(config.rotationMode || "Exercise-First") === m} onClick={() => setConfig((c) => ({ ...c, rotationMode: m }))} color="#8B5CF6" />
          ))}
        </div>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginBottom: 16, lineHeight: 1.5 }}>
          {(config.rotationMode || "Exercise-First") === "Circuit"
            ? "A → B → C → D → E once (one round), round break, repeat — like moving through CrossFit stations."
            : "Finish all rounds of A, then move to B, then C — the classic straight-sets order."}
        </div>

        {(config.rotationMode || "Exercise-First") === "Circuit" && (
          <div style={{ marginBottom: 16 }}>
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, marginBottom: 6 }}>Transition Between Stations</div>
            <DialInput
              value={Number(config.circuitTransition) || 10}
              onChange={(v) => setConfig((c) => ({ ...c, circuitTransition: v }))}
              min={0}
              max={60}
              step={1}
              unit="s"
            />
          </div>
        )}

        {config.mode === "Timer" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              ["work", "Work (s)", 5, 300, 5],
              ["rest", "Rest (s)", 0, 300, 5],
              ["rounds", "Rounds", 1, 20, 1],
            ].map(([key, label, min, max, step]) => (
              <div key={key}>
                <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, marginBottom: 6 }}>{label}</div>
                <DialInput
                  value={Number(config[key]) || min}
                  onChange={(v) => setConfig((c) => ({ ...c, [key]: v }))}
                  min={min}
                  max={max}
                  step={step}
                />
              </div>
            ))}
          </div>
        )}

        {config.mode === "Reps" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              ["targetReps", "Target Reps", 1, 100, 1],
              ["rest", "Rest (s)", 0, 300, 5],
              ["rounds", "Rounds", 1, 20, 1],
            ].map(([key, label, min, max, step]) => (
              <div key={key}>
                <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, marginBottom: 6 }}>{label}</div>
                <DialInput
                  value={Number(config[key]) || min}
                  onChange={(v) => setConfig((c) => ({ ...c, [key]: v }))}
                  min={min}
                  max={max}
                  step={step}
                />
              </div>
            ))}
          </div>
        )}

        {config.mode === "Sequence" && (
          <>
            <div style={{ marginBottom: 12 }}>
              <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, marginBottom: 6 }}>Rounds</div>
              <DialInput
                value={Number(config.rounds) || 1}
                onChange={(v) => setConfig((c) => ({ ...c, rounds: v }))}
                min={1}
                max={20}
                step={1}
              />
            </div>
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, lineHeight: 1.5 }}>
              No timer, no rep target. Move through exercises in order, logging each as you go — built for strength/anaerobic work over tempo.
            </div>
          </>
        )}
      </div>

      {/* build list header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Build ({buildList.length})
        </div>
        {buildList.length >= 2 && (
          <button
            onClick={() => { setSelectMode((s) => !s); setSelectedIds([]); }}
            className="fg-mono"
            style={{
              background: "none", border: `1px solid ${selectMode ? "#8B5CF6" : C.line}`, borderRadius: 8,
              padding: "6px 10px", color: selectMode ? "#C4B5FD" : C.textLo, fontSize: 11, display: "flex", alignItems: "center", gap: 5,
            }}
          >
            <Link2 size={12} /> {selectMode ? "Cancel" : "Link Superset"}
          </button>
        )}
      </div>

      {selectMode && (
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, marginBottom: 10, lineHeight: 1.4 }}>
          Tap 2 or more <span style={{ color: C.textHi }}>consecutive</span> exercises to superset them together.
        </div>
      )}

      {buildList.length === 0 && (
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, textAlign: "center", padding: "30px 10px", border: `1px dashed ${C.line}`, borderRadius: 12 }}>
          Add exercises from the Library tab to start building.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {buildList.map((item, i) => {
          const selected = selectedIds.includes(item.uid);
          return (
            <div
              key={item.uid}
              draggable={!selectMode}
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(i)}
              onClick={() => selectMode && toggleSelected(item.uid)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: selected ? "#8B5CF622" : item.supersetGroup ? "#8B5CF611" : C.bgCard,
                border: `1px solid ${selected ? "#8B5CF6" : item.supersetGroup ? "#8B5CF666" : C.line}`,
                borderRadius: 12,
                padding: "12px 12px",
                cursor: selectMode ? "pointer" : "default",
              }}
            >
              {selectMode ? (
                <div
                  style={{
                    width: 20, height: 20, borderRadius: 6, flexShrink: 0,
                    border: `1.5px solid ${selected ? "#8B5CF6" : C.line}`,
                    background: selected ? "#8B5CF6" : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {selected && <Check size={13} color="white" />}
                </div>
              ) : (
                <GripVertical size={16} color={C.textLo} style={{ cursor: "grab", flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {item.supersetGroup && <Link2 size={12} color="#C4B5FD" />}
                  <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 600 }}>
                    {item.name}
                  </div>
                </div>
                <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 2 }}>
                  {modeLabel(item)}
                  {modeLabel(item) === "Timer" && item.customWork ? ` · ${item.customWork}s` : ""}
                  {modeLabel(item) === "Reps" && item.customReps ? ` · ${item.customReps} reps` : ""}
                  {item.note ? ` · "${item.note.slice(0, 22)}${item.note.length > 22 ? "…" : ""}"` : ""}
                </div>
              </div>
              {!selectMode && (
                <>
                  <button onClick={() => setMenuItemId(item.uid)} style={{ background: "none", border: "none", padding: 6 }}>
                    <MoreHorizontal size={18} color={C.textLo} />
                  </button>
                  <button
                    draggable
                    onDragStart={(e) => { e.stopPropagation(); setDragIndex(i); }}
                    onClick={() => moveToBurnout(item.uid)}
                    title="Drag or tap to send to Burnout"
                    style={{
                      width: 30, height: 30, borderRadius: 8, background: `${C.amber}18`,
                      border: `1px solid ${C.amber}44`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                    }}
                  >
                    <Flame size={13} color={C.amber} />
                  </button>
                  <button
                    onClick={() => removeItem(item.uid)}
                    title="Remove from workout"
                    style={{
                      width: 30, height: 30, borderRadius: 8, background: `${C.line}`,
                      border: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                    }}
                  >
                    <X size={14} color={C.textLo} />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {selectMode && (
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button
            onClick={() => { setSelectMode(false); setSelectedIds([]); }}
            className="fg-display"
            style={{ flex: 1, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px", color: C.textLo, fontWeight: 600, fontSize: 14 }}
          >
            Cancel
          </button>
          <button
            onClick={createSuperset}
            disabled={!isContiguous}
            className="fg-display"
            style={{
              flex: 1, background: isContiguous ? "#8B5CF6" : C.bgCard, border: "none", borderRadius: 10, padding: "12px",
              color: isContiguous ? "white" : C.textLo, fontWeight: 700, fontSize: 14,
            }}
          >
            {selectedIndices.length >= 2 && !isContiguous ? "Must be consecutive" : `Create Superset (${selectedIndices.length})`}
          </button>
        </div>
      )}

      {/* burnout drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOverBurnout(true); }}
        onDragLeave={() => setDragOverBurnout(false)}
        onDrop={() => {
          setDragOverBurnout(false);
          if (dragIndex !== null) moveToBurnout(buildList[dragIndex]?.uid);
        }}
        style={{
          marginTop: 22,
          border: `1.5px dashed ${dragOverBurnout ? C.amber : C.amber + "66"}`,
          background: dragOverBurnout ? `${C.amber}18` : `${C.amber}0A`,
          borderRadius: 14,
          padding: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: burnoutList.length ? 10 : 0 }}>
          <Flame size={15} color={C.amber} />
          <div className="fg-mono" style={{ color: C.amber, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Burnout ({burnoutList.length}) · drag exercises here
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {burnoutList.map((item) => (
            <div
              key={item.uid}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px",
              }}
            >
              <div className="fg-display" style={{ color: C.textHi, fontSize: 14, fontWeight: 600 }}>{item.name}</div>
              <button
                onClick={() => setBurnoutList((l) => l.filter((b) => b.uid !== item.uid))}
                style={{ background: "none", border: "none" }}
              >
                <X size={14} color={C.textLo} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* save as template */}
      <button
        onClick={onSaveTemplate}
        disabled={buildList.length === 0}
        className="fg-display"
        style={{
          width: "100%",
          marginTop: 20,
          background: buildList.length ? "#16A34A" : C.bgCard,
          border: "none",
          borderRadius: 12,
          padding: "15px",
          color: buildList.length ? "white" : C.textLo,
          fontWeight: 700,
          fontSize: 16,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        }}
      >
        <Save size={17} /> Save as Template
      </button>

      {menuItem && (
        <OverrideMenu
          item={menuItem}
          config={config}
          onChange={(patch) => updateItem(menuItem.uid, patch)}
          onClose={() => setMenuItemId(null)}
          onUnlinkSuperset={() => { unlinkGroup(menuItem.supersetGroup); setMenuItemId(null); }}
          onChangeTransition={(value) => changeTransition(menuItem.supersetGroup, value)}
          groupSize={menuItemGroupSize}
        />
      )}
    </div>
  );
}

/* ============================================================
   LIBRARY + BUILDER SCREEN (tabs: Library / Builder / Burnout)
   ============================================================ */
function LibraryBuilderScreen({ onBack, onStartWorkout, initialSession, onSaveTemplate }) {
  const [tab, setTab] = useState("Library");
  const [buildList, setBuildList] = useState(() => initialSession?.buildList || []);
  const [burnoutList, setBurnoutList] = useState(() => initialSession?.burnoutList || []);
  const [config, setConfig] = useState(() => initialSession?.config || { mode: "Timer", work: 40, rest: 20, rounds: 3, targetReps: 12, rotationMode: "Exercise-First", circuitTransition: 10 });
  const [savedToast, setSavedToast] = useState(false);
  const [namingTemplate, setNamingTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [previewing, setPreviewing] = useState(false);

  const addToBuild = (ex) =>
    setBuildList((l) => {
      const idx = l.findIndex((b) => b.id === ex.id);
      if (idx >= 0) {
        return normalizeSupersetGroups(l.filter((_, i) => i !== idx));
      }
      return [...l, { ...ex, uid: nextUid(), modeOverride: "Session Default" }];
    });
  const addToBurnout = (ex) =>
    setBurnoutList((l) => {
      const idx = l.findIndex((b) => b.id === ex.id);
      if (idx >= 0) return l.filter((_, i) => i !== idx);
      return [...l, { ...ex, uid: nextUid() }];
    });

  const handleSaveTemplate = () => {
    setTemplateName(`My Workout ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`);
    setNamingTemplate(true);
  };

  const confirmSaveTemplate = () => {
    const name = templateName.trim() || "Untitled Workout";
    onSaveTemplate(serializeTemplate(name, buildList, burnoutList, config));
    setNamingTemplate(false);
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 1800);
  };

  if (previewing) {
    return (
      <WorkoutPreviewScreen
        buildList={buildList}
        burnoutList={burnoutList}
        config={config}
        onBack={() => setPreviewing(false)}
        onConfirm={() => onStartWorkout({ buildList, burnoutList, config })}
      />
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg }}>
      <FontImport />

      {/* header */}
      <div style={{ padding: "22px 20px 10px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none" }}>
          <ArrowLeft size={20} color={C.textLo} />
        </button>
        <h1 className="fg-display" style={{ color: C.textHi, fontSize: 26, fontWeight: 700, margin: 0 }}>
          Build Workout
        </h1>
      </div>

      {/* tab switcher */}
      <div style={{ display: "flex", gap: 8, padding: "10px 20px 0" }}>
        {["Library", "Builder", "Burnout"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="fg-display"
            style={{
              flex: 1,
              padding: "11px 0",
              borderRadius: 10,
              border: `1px solid ${tab === t ? C.blue : C.line}`,
              background: tab === t ? `${C.blue}1A` : "transparent",
              color: tab === t ? C.accent : C.textLo,
              fontWeight: 600,
              fontSize: 15,
              position: "relative",
            }}
          >
            {t}
            {t === "Burnout" && burnoutList.length > 0 && (
              <span
                style={{
                  position: "absolute", top: 4, right: 10, width: 7, height: 7,
                  borderRadius: "50%", background: C.amber,
                }}
              />
            )}
          </button>
        ))}
      </div>

      {tab === "Library" && (
        <LibraryTab
          onAddToBuild={addToBuild}
          onAddToBurnout={addToBurnout}
          addedIds={new Set(buildList.map((b) => b.id))}
          burnoutIds={new Set(burnoutList.map((b) => b.id))}
        />
      )}

      {tab === "Builder" && (
        <BuilderTab
          buildList={buildList}
          setBuildList={setBuildList}
          burnoutList={burnoutList}
          setBurnoutList={setBurnoutList}
          config={config}
          setConfig={setConfig}
          onSaveTemplate={handleSaveTemplate}
        />
      )}

      {tab === "Burnout" && (
        <div style={{ padding: "16px 20px 100px" }}>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
            Burnout Stage ({burnoutList.length})
          </div>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
            Runs once after all main rounds complete. Max effort. Add exercises here directly, or drag them
            in from the Builder tab.
          </div>
          {burnoutList.length === 0 && (
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, textAlign: "center", padding: 30, border: `1px dashed ${C.amber}55`, borderRadius: 12 }}>
              No burnout exercises yet.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {burnoutList.map((item) => (
              <div
                key={item.uid}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  background: `${C.amber}0F`, border: `1px solid ${C.amber}44`, borderRadius: 12, padding: "13px 14px",
                }}
              >
                <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 600 }}>{item.name}</div>
                <button onClick={() => setBurnoutList((l) => l.filter((b) => b.uid !== item.uid))} style={{ background: "none", border: "none" }}>
                  <X size={15} color={C.textLo} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {namingTemplate && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 75, display: "flex", alignItems: "flex-end" }}
          onClick={() => setNamingTemplate(false)}
        >
          <div onClick={(e) => e.stopPropagation()} className="fg-sheet-in" style={{ width: "100%", background: C.bgRaised, borderTop: `1px solid ${C.line}`, borderRadius: "20px 20px 0 0", padding: 22 }}>
            <div className="fg-display" style={{ color: C.textHi, fontSize: 20, fontWeight: 700, marginBottom: 14 }}>
              Name this template
            </div>
            <input
              autoFocus
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") confirmSaveTemplate(); }}
              className="fg-mono"
              style={{ width: "100%", background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 10, padding: "13px 14px", color: C.textHi, fontSize: 16, marginBottom: 16 }}
            />
            <button
              onClick={confirmSaveTemplate}
              className="fg-display"
              style={{ width: "100%", background: "#16A34A", border: "none", borderRadius: 12, padding: "15px", color: "white", fontWeight: 700, fontSize: 16 }}
            >
              Save Template
            </button>
          </div>
        </div>
      )}

      {savedToast && (
        <div
          style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            background: "#16A34A", color: "white", padding: "12px 20px", borderRadius: 10,
            fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 600, fontSize: 15,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)", zIndex: 70,
          }}
        >
          ✓ Template saved
        </div>
      )}

      {buildList.length > 0 && !savedToast && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: 16, background: `linear-gradient(0deg, ${C.bg} 60%, transparent)` }}>
          <button
            onClick={() => setPreviewing(true)}
            className="fg-display"
            style={{
              width: "100%",
              background: `linear-gradient(135deg, ${C.blue}, #1D4ED8)`,
              border: "none",
              borderRadius: 14,
              padding: "16px",
              color: "white",
              fontWeight: 700,
              fontSize: 17,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              boxShadow: `0 8px 30px ${C.blue}44`,
            }}
          >
            <Play size={17} fill="white" /> Start Workout
          </button>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   ACTIVE WORKOUT — timeline engine
   ============================================================ */
function effectiveMode(item, config) {
  return item.modeOverride && item.modeOverride !== "Session Default" ? item.modeOverride : config.mode;
}

function groupSegments(buildList) {
  const segments = [];
  let i = 0;
  while (i < buildList.length) {
    const cur = buildList[i];
    if (cur.supersetGroup) {
      const group = [cur];
      let j = i + 1;
      while (j < buildList.length && buildList[j].supersetGroup === cur.supersetGroup) {
        group.push(buildList[j]);
        j += 1;
      }
      segments.push(group);
      i = j;
    } else {
      segments.push([cur]);
      i += 1;
    }
  }
  return segments;
}

function buildTimeline(buildList, burnoutList, config) {
  const rounds = Math.max(1, parseInt(config.rounds) || 1);
  const restDur = Math.max(0, parseInt(config.rest) || 20);
  const workDur = Math.max(1, parseInt(config.work) || 40);
  const circuitTransitionDur = Math.max(0, parseInt(config.circuitTransition) || 10);
  const segments = groupSegments(buildList);
  const phases = [];

  const workPhaseFor = (item, seg, r) => {
    const mode = effectiveMode(item, config);
    return {
      kind: "work",
      mode,
      exercise: item,
      exercises: seg,
      round: r,
      totalRounds: rounds,
      duration: mode === "Timer" ? Number(item.customWork) || workDur : null,
      stage: "main",
    };
  };

  if (config.rotationMode === "Circuit") {
    // A, B, C, D, E (one round) → round break → repeat.
    // Short transition between stations within a round; the configured
    // Rest is used as the longer break between full rounds.
    for (let r = 1; r <= rounds; r++) {
      segments.forEach((seg, segIdx) => {
        const transitionDur = Number(seg[0]?.supersetTransition) || 5;
        seg.forEach((item, itemIdx) => {
          phases.push(workPhaseFor(item, seg, r));
          if (itemIdx < seg.length - 1) {
            phases.push({ kind: "transition", duration: transitionDur, exercises: seg, next: [seg[itemIdx + 1]], stage: "main" });
          }
        });
        const isLastSegmentInRound = segIdx === segments.length - 1;
        const isLastPhaseOverall = r === rounds && isLastSegmentInRound;
        if (!isLastPhaseOverall) {
          const next = isLastSegmentInRound ? segments[0] : segments[segIdx + 1];
          phases.push({
            kind: isLastSegmentInRound ? "rest" : "transition",
            duration: isLastSegmentInRound ? restDur : circuitTransitionDur,
            exercises: seg,
            next,
            round: r,
            totalRounds: rounds,
            stage: "main",
          });
        }
      });
    }
  } else {
    // Exercise-First (default): complete all rounds of A before moving to B.
    segments.forEach((seg, segIdx) => {
      const segAllSequence = seg.every((item) => effectiveMode(item, config) === "Sequence");
      const transitionDur = Number(seg[0]?.supersetTransition) || 5;

      for (let r = 1; r <= rounds; r++) {
        seg.forEach((item, itemIdx) => {
          phases.push(workPhaseFor(item, seg, r));
          if (itemIdx < seg.length - 1) {
            phases.push({ kind: "transition", duration: transitionDur, exercises: seg, next: [seg[itemIdx + 1]], stage: "main" });
          }
        });
        const isLast = r === rounds && segIdx === segments.length - 1;
        if (!isLast) {
          const nextSeg = r < rounds ? seg : segments[segIdx + 1];
          phases.push({
            kind: "rest",
            duration: segAllSequence ? null : restDur,
            exercises: seg,
            next: nextSeg,
            round: r,
            totalRounds: rounds,
            stage: "main",
          });
        }
      }
    });
  }

  burnoutList.forEach((item, idx) => {
    phases.push({ kind: "work", mode: "Timer", exercise: item, exercises: [item], round: 1, totalRounds: 1, duration: 30, stage: "burnout" });
    if (idx < burnoutList.length - 1) {
      phases.push({ kind: "transition", duration: 3, exercises: [item], next: [burnoutList[idx + 1]], stage: "burnout" });
    }
  });

  return phases;
}

const MOCK_PARTNER_QUEUE = ["Romanian Deadlift", "Plank", "Kettlebell Swing", "Downward Dog"];

function MuscleFigurePlaceholder({ active, size = 140, tint, pulse }) {
  return (
    <div
      style={{
        height: size,
        borderRadius: 14,
        background: `${tint || C.blue}0F`,
        border: `1px solid ${C.line}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
      }}
    >
      {["Front", "Back"].map((label) => (
        <div
          key={label}
          className={active && pulse ? "fg-pulse" : ""}
          style={{
            width: 46,
            height: size - 30,
            borderRadius: 8,
            border: `1px solid ${active ? (tint || C.blue) : C.line}`,
            background: active ? `${tint || C.blue}22` : "transparent",
            boxShadow: active ? `0 0 20px ${(tint || C.blue)}55` : "none",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
          }}
        >
          <span className="fg-mono" style={{ fontSize: 9, color: C.textLo, marginBottom: 4 }}>
            {label[0]}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   WORKOUT PREVIEW — the final, customizable layout confirmation
   before starting. Shows the real order, targets, and breaks
   exactly as they'll run, without flattening every single round
   into a giant repeated list.
   ============================================================ */
function WorkoutPreviewScreen({ buildList, burnoutList, config, onBack, onConfirm }) {
  const segments = groupSegments(buildList);
  const rounds = Math.max(1, parseInt(config.rounds) || 1);
  const isCircuit = (config.rotationMode || "Exercise-First") === "Circuit";

  const targetLabel = (item) => {
    const mode = effectiveMode(item, config);
    if (mode === "Timer") return `${Number(item.customWork) || Number(config.work) || 40}s`;
    if (mode === "Reps") return `${item.customReps || config.targetReps || 10} reps`;
    return "self-paced";
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: 30 }}>
      <FontImport />

      <div style={{ padding: "22px 20px 6px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none" }}>
          <ArrowLeft size={20} color={C.textLo} />
        </button>
        <h1 className="fg-display" style={{ color: C.textHi, fontSize: 24, fontWeight: 700, margin: 0 }}>
          Workout Preview
        </h1>
      </div>

      <div style={{ padding: "10px 20px 0" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          <Chip label={config.mode} active color={C.blue} />
          <Chip label={isCircuit ? "Circuit" : "Exercise-First"} active color="#8B5CF6" />
          <Chip label={`${rounds} round${rounds !== 1 ? "s" : ""}`} active color={C.amber} />
        </div>

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, marginBottom: 20, lineHeight: 1.6 }}>
          {isCircuit
            ? `Go through every station below once (that's one round), rest, then repeat ${rounds} time${rounds !== 1 ? "s" : ""} total.`
            : `Complete all ${rounds} round${rounds !== 1 ? "s" : ""} of each exercise below before moving to the next.`}
        </div>

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
          {isCircuit ? "Station Order" : "Exercise Order"}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 22 }}>
          {segments.map((seg, i) => (
            <div key={seg[0].uid} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, width: 20, flexShrink: 0 }}>{i + 1}</div>
              <div style={{ flex: 1, background: seg.length > 1 ? "#8B5CF611" : C.bgCard, border: `1px solid ${seg.length > 1 ? "#8B5CF666" : C.line}`, borderRadius: 12, padding: "12px 14px" }}>
                {seg.map((item, j) => (
                  <div key={item.uid} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: j > 0 ? 6 : 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {seg.length > 1 && <Link2 size={11} color="#C4B5FD" />}
                      <span className="fg-display" style={{ color: C.textHi, fontSize: 15, fontWeight: 600 }}>{item.name}</span>
                    </div>
                    <span className="fg-mono" style={{ color: C.accent, fontSize: 12 }}>{targetLabel(item)}</span>
                  </div>
                ))}
                {!isCircuit && (
                  <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, marginTop: 6 }}>
                    × {rounds} round{rounds !== 1 ? "s" : ""}, {Number(config.rest) || 20}s rest between
                  </div>
                )}
              </div>
              {i < segments.length - 1 && (
                <ArrowRight size={14} color={C.textLo} style={{ flexShrink: 0 }} />
              )}
            </div>
          ))}
        </div>

        {isCircuit && (
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginBottom: 22, lineHeight: 1.6, padding: "12px 14px", background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 10 }}>
            {Number(config.circuitTransition) || 10}s between each station · {Number(config.rest) || 20}s round break after station {segments.length} · repeats {rounds} time{rounds !== 1 ? "s" : ""} total
          </div>
        )}

        {burnoutList.length > 0 && (
          <>
            <div className="fg-mono" style={{ color: C.amber, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
              <Flame size={13} /> Then Burnout (once, max effort)
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 22 }}>
              {burnoutList.map((item) => (
                <div key={item.uid} style={{ background: `${C.amber}0F`, border: `1px solid ${C.amber}44`, borderRadius: 12, padding: "12px 14px" }}>
                  <span className="fg-display" style={{ color: C.textHi, fontSize: 15, fontWeight: 600 }}>{item.name}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <button
          onClick={onConfirm}
          className="fg-display"
          style={{
            width: "100%", background: `linear-gradient(135deg, ${C.blue}, #1D4ED8)`, border: "none", borderRadius: 14,
            padding: "17px", color: "white", fontWeight: 700, fontSize: 17,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            boxShadow: `0 8px 30px ${C.blue}44`,
          }}
        >
          <Play size={17} fill="white" /> Start Workout
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   ACTIVE WORKOUT SCREEN
   ============================================================ */
function ActiveWorkoutScreen({ buildList, burnoutList, config, squadInfo, onExit, onSaveSession }) {
  const timeline = useMemo(() => buildTimeline(buildList, burnoutList, config), [buildList, burnoutList, config]);
  const [idx, setIdx] = useState(0);
  const [remaining, setRemaining] = useState(timeline[0]?.duration ?? null);
  const [running, setRunning] = useState(true);
  const [showPartner, setShowPartner] = useState(false);
  const [finished, setFinished] = useState(false);
  const [showRestLog, setShowRestLog] = useState(false);
  const [sessionLog, setSessionLog] = useState([]);
  const [queuedBurnout, setQueuedBurnout] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const [showSquadExpand, setShowSquadExpand] = useState(false);
  const [squadPingSent, setSquadPingSent] = useState(null);

  const phase = timeline[idx];

  const advance = () => {
    const next = idx + 1;
    if (next >= timeline.length) {
      setFinished(true);
      return;
    }
    setIdx(next);
    setRemaining(timeline[next].duration ?? null);
  };

  useEffect(() => {
    if (!running || finished || !phase || phase.duration == null) return;
    if (remaining <= 0) {
      advance();
      return;
    }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, running, finished, idx]);

  useEffect(() => {
    if (finished) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [finished]);

  if (timeline.length === 0) {
    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <FontImport />
        <div style={{ textAlign: "center" }}>
          <div className="fg-display" style={{ color: C.textHi, fontSize: 22, fontWeight: 700, marginBottom: 10 }}>
            Nothing to run yet
          </div>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, marginBottom: 20 }}>
            Add exercises in the Builder first.
          </div>
          <button onClick={onExit} style={{ background: C.blue, border: "none", borderRadius: 10, padding: "12px 24px", color: "white" }} className="fg-display">
            Back to Builder
          </button>
        </div>
      </div>
    );
  }

  if (finished) {
    return (
      <ReviewLogScreen
        sets={sessionLog}
        durationSec={elapsed}
        onBack={onExit}
        onConfirm={({ sets, overallRpe }) => {
          onSaveSession({
            id: `s_${Date.now()}`,
            date: Date.now(),
            source: "builder",
            mode: config.mode,
            durationSec: elapsed,
            sets,
            overallRpe,
          });
          onExit();
        }}
      />
    );
  }

  const isBurnout = phase.stage === "burnout";
  const themeColor = isBurnout ? C.amber : C.blue;
  const partnerExercise = MOCK_PARTNER_QUEUE[idx % MOCK_PARTNER_QUEUE.length];

  const pills = (
    <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 18 }}>
      {Array.from({ length: phase.totalRounds }).map((_, i) => (
        <div
          key={i}
          style={{
            width: 26,
            height: 5,
            borderRadius: 3,
            background: i < phase.round ? themeColor : C.line,
          }}
        />
      ))}
    </div>
  );

  const header = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 20px 0" }}>
      <button onClick={onExit} style={{ background: "none", border: "none" }}>
        <X size={22} color={C.textLo} />
      </button>
      <div className="fg-mono" style={{ color: isBurnout ? C.amber : C.textLo, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase" }}>
        {isBurnout ? "Burnout" : `Round ${phase.round} / ${phase.totalRounds}`}
      </div>
      <button onClick={() => setShowPartner((s) => !s)} style={{ background: "none", border: "none" }}>
        <SplitSquareHorizontal size={20} color={showPartner ? C.accent : C.textLo} />
      </button>
    </div>
  );

  let body;

  if (phase.kind === "transition") {
    body = (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div
          style={{
            width: 90, height: 90, borderRadius: "50%", border: `3px solid ${themeColor}`,
            display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 22,
            boxShadow: `0 0 30px ${themeColor}55`,
          }}
        >
          <span className="fg-display" style={{ fontSize: 36, fontWeight: 700, color: themeColor }}>
            {remaining}
          </span>
        </div>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>
          {phase.exercises.length > 1 ? "Superset transition" : "Get ready"}
        </div>
        <div className="fg-display" style={{ color: C.textHi, fontSize: 24, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
          {phase.next && phase.next[0] ? phase.next[0].name : "Next exercise"}
        </div>
      </div>
    );
  } else if (phase.kind === "rest") {
    const isOpenRest = phase.duration == null;
    const showGetReady = !isOpenRest && remaining <= 3;
    body = (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 20 }}>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", textAlign: "center", marginBottom: 10 }}>
          {isOpenRest ? "Log & Continue" : "Rest"}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 20 }}>
          {phase.exercises.map((ex) => (
            <MuscleFigurePlaceholder key={ex.uid} active tint={C.accent} size={130} />
          ))}
        </div>

        {isOpenRest ? (
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, textAlign: "center", marginBottom: 6, lineHeight: 1.6 }}>
            Log your set with ◈ Log Set below, then move on whenever you're ready.
          </div>
        ) : (
          <div style={{ textAlign: "center", marginBottom: 6 }}>
            <div className="fg-display" style={{ fontSize: 64, fontWeight: 800, color: showGetReady ? C.amber : C.textHi, lineHeight: 1 }}>
              {showGetReady ? remaining : `0:${String(remaining).padStart(2, "0")}`}
            </div>
            {showGetReady && (
              <div className="fg-mono" style={{ color: C.amber, fontSize: 13, letterSpacing: "0.12em", marginTop: 4 }}>
                GET READY
              </div>
            )}
          </div>
        )}

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, textAlign: "center", marginTop: 4 }}>
          Up next: {phase.next && phase.next[0] ? phase.next[0].name : "Burnout"}
        </div>

        <div style={{ flex: 1 }} />
        {isOpenRest ? (
          <button
            onClick={advance}
            className="fg-display"
            style={{ width: "100%", background: themeColor, border: "none", borderRadius: 12, padding: "15px", color: "white", fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
          >
            Continue <ArrowRight size={16} />
          </button>
        ) : (
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => setRemaining((r) => r + 15)}
              className="fg-display"
              style={{ flex: 1, background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px", color: C.textHi, fontWeight: 600, fontSize: 15 }}
            >
              +15s
            </button>
            <button
              onClick={advance}
              className="fg-display"
              style={{ flex: 1, background: "transparent", border: `1px solid ${themeColor}`, borderRadius: 12, padding: "14px", color: themeColor, fontWeight: 600, fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
            >
              Skip Rest <SkipForward size={15} />
            </button>
          </div>
        )}
      </div>
    );
  } else {
    // work phase
    const isReps = phase.mode === "Reps";
    const isSequence = phase.mode === "Sequence";
    body = (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 20 }}>
        {!isBurnout && pills}
        {isBurnout && (
          <div className="fg-mono" style={{ color: C.amber, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", textAlign: "center", marginBottom: 16 }}>
            Max Effort
          </div>
        )}

        <div
          style={{
            flex: showPartner ? "0 0 auto" : 1,
            borderRadius: 16,
            background: `${themeColor}0D`,
            border: `1px solid ${themeColor}44`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 18,
            minHeight: showPartner ? 150 : 220,
            position: "relative",
            overflow: "hidden",
          }}
        >
          {phase.exercise.videoUrl ? (
            <video
              key={phase.exercise.videoUrl}
              src={phase.exercise.videoUrl}
              autoPlay
              loop
              muted
              playsInline
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 12 }}>[ video — add a clip for this exercise ]</div>
          )}
          {phase.exercises.length > 1 && (
            <div style={{ position: "absolute", top: 10, right: 12 }}>
              <Link2 size={14} color="#C4B5FD" />
            </div>
          )}
        </div>

        {showPartner && (
          <div style={{ display: "flex", gap: 10, overflowX: "auto", marginBottom: 18, paddingBottom: 2 }}>
            {SQUAD_MEMBERS_SEED.filter((m) => !m.isMe).map((m, mi) => (
              <div
                key={m.id}
                style={{
                  borderRadius: 14,
                  background: C.bgCard,
                  border: `1px solid ${C.line}`,
                  padding: 14,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  flexShrink: 0,
                  minWidth: 170,
                }}
              >
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <MemberAvatar member={m} size={36} />
                  <div style={{ position: "absolute", bottom: -1, right: -1, width: 9, height: 9, borderRadius: "50%", background: m.online ? "#22C55E" : C.textLo, border: `2px solid ${C.bgCard}` }} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="fg-mono" style={{ color: C.textLo, fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase" }}>{m.name} · independent</div>
                  <div className="fg-display" style={{ color: C.textHi, fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {MOCK_PARTNER_QUEUE[(idx + mi) % MOCK_PARTNER_QUEUE.length]}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="fg-display" style={{ color: C.textHi, fontSize: 28, fontWeight: 700, textAlign: "center" }}>
          {phase.exercise.name}
        </div>
        {phase.exercise.note && (
          <div className="fg-mono" style={{ color: C.accent, fontSize: 12, textAlign: "center", marginTop: 6 }}>
            "{phase.exercise.note}"
          </div>
        )}

        <div style={{ textAlign: "center", margin: "20px 0" }}>
          {isReps ? (
            <div className="fg-display" style={{ fontSize: 40, fontWeight: 800, color: themeColor }}>
              {phase.exercise.customReps || config.targetReps || 12} reps
            </div>
          ) : isSequence ? (
            <div className="fg-mono" style={{ fontSize: 14, color: C.textLo, letterSpacing: "0.06em" }}>
              No target — go at your own pace
            </div>
          ) : (
            <div
              style={{
                width: 110, height: 110, borderRadius: "50%", border: `4px solid ${themeColor}`, margin: "0 auto",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: `0 0 30px ${themeColor}44`,
              }}
            >
              <span className="fg-display" style={{ fontSize: 34, fontWeight: 800, color: C.textHi }}>
                0:{String(remaining).padStart(2, "0")}
              </span>
            </div>
          )}
        </div>

        <div style={{ flex: 1 }} />
        {phase.duration != null ? (
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => setRunning((r) => !r)}
              className="fg-display"
              style={{ flex: 1, background: themeColor, border: "none", borderRadius: 12, padding: "15px", color: isBurnout ? C.bg : "white", fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
            >
              {running ? <Pause size={17} /> : <Play size={17} />} {running ? "Pause" : "Resume"}
            </button>
            <button
              onClick={advance}
              className="fg-display"
              style={{ flex: 1, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 12, padding: "15px", color: C.textHi, fontWeight: 600, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
            >
              Done <ArrowRight size={16} />
            </button>
          </div>
        ) : (
          <button
            onClick={advance}
            className="fg-display"
            style={{ width: "100%", background: themeColor, border: "none", borderRadius: 12, padding: "15px", color: isBurnout ? C.bg : "white", fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          >
            Done <ArrowRight size={17} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", transition: "background 0.4s" }}>
      <FontImport />
      {header}
      {body}

      {phase.stage === "main" && phase.kind !== "transition" && !showRestLog && (
        <button
          onClick={() => setShowRestLog(true)}
          className="fg-display"
          style={{
            position: "fixed", bottom: 90, right: 20, zIndex: 40,
            background: C.bgRaised, border: `1px solid ${C.line}`, borderRadius: 24,
            padding: "10px 16px", color: C.accent, fontWeight: 600, fontSize: 13,
            boxShadow: "0 6px 20px rgba(0,0,0,0.5)", display: "flex", alignItems: "center", gap: 6,
          }}
        >
          ◈ Log Set
        </button>
      )}

      {showRestLog && (
        <RestLogScreen
          exercises={phase.exercise ? [phase.exercise] : phase.exercises || []}
          setNumber={phase.round}
          totalSets={phase.totalRounds}
          squadInfo={squadInfo}
          onClose={() => setShowRestLog(false)}
          onLogSet={(entry) => setSessionLog((l) => [...l, entry])}
          onQueueBurnout={(ex) => setQueuedBurnout((q) => [...q, ex])}
        />
      )}

      {squadInfo && !showRestLog && (
        <button
          onClick={() => setShowSquadExpand(true)}
          className="fg-display"
          style={{
            position: "fixed", bottom: 90, left: 20, zIndex: 40,
            background: C.bgRaised, border: `1px solid ${C.line}`, borderRadius: 24,
            padding: "8px 14px 8px 8px", color: C.textHi, fontWeight: 600, fontSize: 13,
            boxShadow: "0 6px 20px rgba(0,0,0,0.5)", display: "flex", alignItems: "center", gap: 8,
          }}
        >
          <div style={{ display: "flex" }}>
            {squadInfo.members.slice(0, 3).map((m, i) => (
              <div
                key={m.id}
                style={{ marginLeft: i === 0 ? 0 : -8, border: `1.5px solid ${C.bgRaised}`, borderRadius: "50%" }}
              >
                <MemberAvatar member={m} size={20} />
              </div>
            ))}
          </div>
          Squad
        </button>
      )}

      {showSquadExpand && squadInfo && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 90, display: "flex", flexDirection: "column" }} onClick={() => setShowSquadExpand(false)}>
          <div onClick={(e) => e.stopPropagation()} className="fg-sheet-in" style={{ marginTop: "auto", background: C.bgRaised, borderTop: `1px solid ${C.line}`, borderRadius: "20px 20px 0 0", padding: 22, maxHeight: "85vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div className="fg-display" style={{ color: C.textHi, fontSize: 20, fontWeight: 700 }}>Squad</div>
              <button onClick={() => setShowSquadExpand(false)} style={{ background: "none", border: "none" }}>
                <X size={20} color={C.textLo} />
              </button>
            </div>

            {(() => {
              const leaderboard = [...squadInfo.members].map((m) => ({ ...m, points: m.completedCount * 10 + m.streak * 5 })).sort((a, b) => b.points - a.points);
              return leaderboard.some((m) => m.points > 0) ? (
                <div style={{ display: "flex", gap: 8, marginBottom: 18, overflowX: "auto" }}>
                  {leaderboard.slice(0, 3).map((m, i) => (
                    <div key={m.id} style={{ flex: 1, minWidth: 95, background: C.bgCard, border: `1px solid ${i === 0 ? C.amber : C.line}`, borderRadius: 12, padding: "10px 12px", display: "flex", alignItems: "center", gap: 7 }}>
                      {i === 0 ? <Crown size={12} color={C.amber} /> : <span className="fg-mono" style={{ color: C.textLo, fontSize: 10 }}>{i + 1}</span>}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="fg-display" style={{ color: C.textHi, fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</div>
                        <div className="fg-mono" style={{ color: C.accent, fontSize: 9, display: "flex", alignItems: "center", gap: 3 }}><Zap size={8} /> {m.points}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null;
            })()}

            <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>
              Station Rotation
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
              {squadInfo.sequence.map((st, i) => {
                const here = squadInfo.members.filter((m) => m.currentIndex % squadInfo.sequence.length === i);
                return (
                  <div key={st.uid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, background: here.length ? `${C.blue}0F` : "transparent" }}>
                    <span className="fg-mono" style={{ color: C.textLo, fontSize: 11, width: 18 }}>{i + 1}</span>
                    <span className="fg-display" style={{ color: C.textHi, fontSize: 15, fontWeight: 600, flex: 1 }}>{st.name}</span>
                    <div style={{ display: "flex", gap: 3 }}>
                      {here.map((m) => (
                        <div key={m.id} title={m.name}>
                          <MemberAvatar member={m} size={22} />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10, textAlign: "center" }}>
              Quick Ping
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              {["💪", "🔥", "👊", "⚡"].map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => { setSquadPingSent(emoji); setTimeout(() => setSquadPingSent(null), 1400); }}
                  style={{
                    width: 50, height: 50, borderRadius: "50%",
                    background: squadPingSent === emoji ? `${C.blue}33` : C.bgCard,
                    border: `1px solid ${squadPingSent === emoji ? C.blue : C.line}`,
                    fontSize: 21, display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
            {squadPingSent && (
              <div className="fg-mono" style={{ color: C.accent, fontSize: 12, textAlign: "center", marginTop: 10 }}>
                Sent {squadPingSent} to the squad
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   REST / LOG SCREEN — manual navigation, separate from auto-timer
   ============================================================ */
/* ============================================================
   DIAL INPUT — drag-to-scroll numeric picker
   The whole ruler is pre-rendered once and slid via a direct DOM
   transform during drag (not React state) so it tracks your finger
   with zero lag. Drag left = higher numbers slide in, drag right =
   lower numbers slide in — same physics as Apple Health's weight
   ruler. A tap (no real drag) opens a plain text field for typing
   an exact number.
   ============================================================ */
function DialInput({ value, onChange, min = 0, max = 999, step = 1, unit = "", pixelsPerStep = 18 }) {
  const containerRef = useRef(null);
  const stripRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(String(value));
  const [dragging, setDragging] = useState(false);
  const [liveValue, setLiveValue] = useState(value);
  const widthRef = useRef(280);
  const drag = useRef({ startX: 0, baseIndex: 0, moved: 0 });

  const clampVal = (v) => Math.min(max, Math.max(min, v));
  const clampIndex = (i) => Math.min(ticks.length - 1, Math.max(0, i));

  const ticks = useMemo(() => {
    const arr = [];
    for (let v = min; v <= max; v += step) arr.push(v);
    return arr;
  }, [min, max, step]);

  const indexOfValue = (v) => {
    const clamped = clampVal(v);
    return Math.round((clamped - min) / step);
  };

  useLayoutEffect(() => {
    if (containerRef.current) widthRef.current = containerRef.current.offsetWidth;
  }, []);

  useEffect(() => {
    setLiveValue(value);
  }, [value]);

  const restingTransform = (idx) => widthRef.current / 2 - idx * pixelsPerStep - pixelsPerStep / 2;

  // snap to resting position whenever value changes and we're not actively dragging
  useLayoutEffect(() => {
    if (drag.current.dragging) return;
    if (stripRef.current) {
      stripRef.current.style.transition = "transform 0.15s ease-out";
      stripRef.current.style.transform = `translateX(${restingTransform(indexOfValue(value))}px)`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const onPointerDown = (e) => {
    if (editing) return;
    drag.current = { startX: e.clientX, baseIndex: indexOfValue(value), moved: 0, dragging: true };
    setDragging(true);
    if (stripRef.current) stripRef.current.style.transition = "none";
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!drag.current.dragging) return;
    const dx = e.clientX - drag.current.startX;
    drag.current.moved = Math.max(drag.current.moved, Math.abs(dx));
    const basePx = restingTransform(drag.current.baseIndex);
    if (stripRef.current) stripRef.current.style.transform = `translateX(${basePx + dx}px)`;
    // drag left (negative dx) => higher index (higher value); drag right => lower index
    const deltaIndex = Math.round(-dx / pixelsPerStep);
    const newIndex = clampIndex(drag.current.baseIndex + deltaIndex);
    const newValue = ticks[newIndex];
    if (newValue !== liveValue) {
      setLiveValue(newValue);
      onChange(newValue);
    }
  };

  const endDrag = () => {
    if (!drag.current.dragging) return;
    drag.current.dragging = false;
    setDragging(false);
    if (drag.current.moved < 6) {
      setEditValue(String(value));
      setEditing(true);
    } else if (stripRef.current) {
      stripRef.current.style.transition = "transform 0.15s ease-out";
      stripRef.current.style.transform = `translateX(${restingTransform(indexOfValue(liveValue))}px)`;
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => { onChange(clampVal(Number(editValue) || 0)); setEditing(false); }}
        onKeyDown={(e) => { if (e.key === "Enter") { onChange(clampVal(Number(editValue) || 0)); setEditing(false); } }}
        className="fg-mono"
        style={{ width: "100%", background: C.bg, border: `1px solid ${C.blue}`, borderRadius: 10, padding: "12px", color: C.textHi, fontSize: 18, textAlign: "center" }}
      />
    );
  }

  const majorEvery = step * 5;

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        touchAction: "none",
        userSelect: "none",
        position: "relative",
        background: C.bg,
        border: `1px solid ${dragging ? C.blue : C.line}`,
        borderRadius: 10,
        padding: "10px 0 6px",
        overflow: "hidden",
        cursor: dragging ? "grabbing" : "grab",
      }}
    >
      <div className="fg-display" style={{ textAlign: "center", fontSize: 26, fontWeight: 800, color: dragging ? C.accent : C.textHi, marginBottom: 6 }}>
        {liveValue}{unit}
      </div>
      <div style={{ position: "relative", height: 34, overflow: "hidden" }}>
        <div
          style={{
            position: "absolute", left: "50%", top: 0, bottom: 0, width: 2,
            background: C.accent, transform: "translateX(-1px)", zIndex: 2, boxShadow: `0 0 6px ${C.accent}`,
          }}
        />
        <div
          ref={stripRef}
          style={{ position: "absolute", top: 0, left: 0, display: "flex", willChange: "transform" }}
        >
          {ticks.map((t) => {
            const isMajor = t % majorEvery === 0;
            return (
              <div key={t} style={{ width: pixelsPerStep, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ width: 1, height: isMajor ? 15 : 8, background: C.line, marginTop: isMajor ? 0 : 7 }} />
                {isMajor && (
                  <div className="fg-mono" style={{ fontSize: 8, color: C.textLo, marginTop: 2, whiteSpace: "nowrap" }}>{t}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="fg-mono" style={{ textAlign: "center", fontSize: 9, color: C.textLo, marginTop: 4, letterSpacing: "0.04em" }}>
        drag to scroll · tap to type
      </div>
    </div>
  );
}

const PARTNER_PINGS = ["💪", "🔥", "👊", "⚡"];

function RestLogScreen({ exercises, setNumber, totalSets, squadInfo, onClose, onLogSet, onQueueBurnout }) {
  const list = exercises && exercises.length ? exercises : [{ id: "unknown", name: "Exercise", uid: "unknown" }];
  const [activeIdx, setActiveIdx] = useState(0);
  const exercise = list[activeIdx] || list[0];

  const [reps, setReps] = useState(0);
  const [weight, setWeight] = useState(0);
  const [weightType, setWeightType] = useState(defaultWeightType(exercise.equipment));
  const [rpe, setRpe] = useState(null);
  const [logged, setLogged] = useState(false);
  const [queued, setQueued] = useState(false);
  const [pingSent, setPingSent] = useState(null);

  const pingTarget = squadInfo?.members?.find((m) => !m.isMe && m.online);

  useEffect(() => {
    setWeightType(defaultWeightType(exercise.equipment));
  }, [exercise.id]);

  const handleLog = () => {
    onLogSet({
      exerciseId: exercise.id,
      exerciseName: exercise.name,
      setNumber: setNumber || 1,
      totalSets: totalSets || 1,
      reps: reps || null,
      weight: weight || null,
      weightType: weight ? weightType : null,
      rpe,
      loggedAt: Date.now(),
    });
    setLogged(true);
    // Auto-close a beat after logging — designed for sweaty hands mid-set,
    // not for lingering on this screen. Tap the floating button again to
    // log another exercise in a superset.
    setTimeout(onClose, 850);
  };

  const handleQueue = () => {
    onQueueBurnout(exercise);
    setQueued(true);
    setTimeout(() => setQueued(false), 1400);
  };

  const sendPing = (emoji) => {
    setPingSent(emoji);
    setTimeout(() => setPingSent(null), 1400);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: C.bg,
        zIndex: 80,
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      <FontImport />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 20px 4px" }}>
        <button onClick={onClose} style={{ background: "none", border: "none", padding: 8 }}>
          <X size={26} color={C.textLo} />
        </button>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Log Set {setNumber ? `· Set ${setNumber}${totalSets ? ` of ${totalSets}` : ""}` : ""}
        </div>
        <div style={{ width: 42 }} />
      </div>

      <div style={{ padding: "8px 20px" }}>
        {list.length > 1 && (
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 10, flexWrap: "wrap" }}>
            {list.map((ex, i) => (
              <Chip key={ex.uid || ex.id} label={ex.name} active={i === activeIdx} onClick={() => setActiveIdx(i)} color="#8B5CF6" />
            ))}
          </div>
        )}

        <div className="fg-display" style={{ color: C.textHi, fontSize: 26, fontWeight: 700, textAlign: "center", marginBottom: 14 }}>
          {exercise.name}
        </div>

        <div style={{ display: "flex", justifyContent: "center", gap: 12, marginBottom: 20 }}>
          <MuscleFigurePlaceholder active pulse tint={C.accent} size={130} />
        </div>

        {/* log fields */}
        <div style={{ background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 18 }}>
          <div style={{ marginBottom: 18 }}>
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 8 }}>REPS THIS SET</div>
            <DialInput value={reps} onChange={setReps} min={0} max={100} step={1} unit="" />
          </div>
          <div style={{ marginBottom: 6 }}>
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 8 }}>WEIGHT (LBS)</div>
            <DialInput value={weight} onChange={setWeight} min={0} max={999} step={5} unit=" lbs" />
          </div>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginBottom: 18 }}>
            e.g. {reps || "10"} reps of this exercise, at {weight || "60"} lbs, for this one set.
          </div>

          <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 10 }}>WEIGHT TYPE</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 22 }}>
            {WEIGHT_TYPES.map((w) => (
              <button
                key={w}
                onClick={() => setWeightType(w)}
                className="fg-mono"
                style={{
                  padding: "12px 16px",
                  borderRadius: 20,
                  fontSize: 14,
                  border: `1px solid ${weightType === w ? C.blue : C.line}`,
                  background: weightType === w ? `${C.blue}22` : "transparent",
                  color: weightType === w ? C.accent : C.textLo,
                }}
              >
                {w}
              </button>
            ))}
          </div>

          <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 4 }}>RPE — RATE OF PERCEIVED EXERTION</div>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginBottom: 10 }}>How hard did this set feel? 1 = easy, 10 = max effort.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
            {Array.from({ length: 10 }).map((_, i) => {
              const v = i + 1;
              return (
                <button
                  key={v}
                  onClick={() => setRpe(v)}
                  className="fg-mono"
                  style={{
                    padding: "16px 0",
                    borderRadius: 10,
                    border: `1px solid ${rpe === v ? C.blue : C.line}`,
                    background: rpe === v ? `${C.blue}33` : "transparent",
                    color: rpe === v ? C.accent : C.textLo,
                    fontSize: 16,
                    fontWeight: 600,
                  }}
                >
                  {v}
                </button>
              );
            })}
          </div>
        </div>

        <button
          onClick={handleLog}
          className="fg-display"
          style={{
            width: "100%",
            background: logged ? "#16A34A" : C.blue,
            border: "none",
            borderRadius: 14,
            padding: "22px",
            color: "white",
            fontWeight: 700,
            fontSize: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            marginBottom: 12,
          }}
        >
          {logged ? <Check size={22} /> : "◈"} {logged ? "Set Logged" : "LOG SET"}
        </button>

        <button
          onClick={handleQueue}
          className="fg-display"
          style={{
            width: "100%",
            background: queued ? `${C.amber}33` : "transparent",
            border: `1px solid ${C.amber}`,
            borderRadius: 14,
            padding: "18px",
            color: C.amber,
            fontWeight: 600,
            fontSize: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            marginBottom: 20,
          }}
        >
          <Flame size={18} /> {queued ? "Queued to Burnout" : "Queue to Burnout"}
        </button>

        {pingTarget && (
          <>
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", textAlign: "center", marginBottom: 12 }}>
              PING {pingTarget.name.toUpperCase()}
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginBottom: 30 }}>
              {PARTNER_PINGS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => sendPing(emoji)}
                  style={{
                    width: 56, height: 56, borderRadius: "50%",
                    background: pingSent === emoji ? `${C.blue}33` : C.bgCard,
                    border: `1px solid ${pingSent === emoji ? C.blue : C.line}`,
                    fontSize: 24,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {emoji}
                </button>
              ))}
            </div>
            {pingSent && (
              <div className="fg-mono" style={{ color: C.accent, fontSize: 12, textAlign: "center", marginTop: -22, marginBottom: 20 }}>
                Sent {pingSent} to {pingTarget.name}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   FREESTYLE SESSION — no builder, add & log exercises live
   ============================================================ */
/* ============================================================
   REVIEW LOG — shown right after finishing a workout. Lets you
   adjust any set before it's saved for real, and rate the whole
   session's effort (separate from each set's own RPE).
   ============================================================ */
function ReviewLogScreen({ sets, durationSec, onBack, onConfirm }) {
  const [editableSets, setEditableSets] = useState(sets);
  const [overallRpe, setOverallRpe] = useState(null);
  const [editingIndex, setEditingIndex] = useState(null);

  const grouped = editableSets.reduce((acc, s, i) => {
    (acc[s.exerciseName] = acc[s.exerciseName] || []).push({ ...s, _index: i });
    return acc;
  }, {});

  const updateSet = (index, patch) => setEditableSets((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const deleteSet = (index) => setEditableSets((list) => list.filter((_, i) => i !== index));

  return (
    <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: 110 }}>
      <FontImport />
      <div style={{ padding: "22px 20px 6px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none" }}>
          <ArrowLeft size={20} color={C.textLo} />
        </button>
        <h1 className="fg-display" style={{ color: C.textHi, fontSize: 24, fontWeight: 700, margin: 0 }}>Review Log</h1>
      </div>

      <div style={{ padding: "10px 20px 0" }}>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, marginBottom: 20, lineHeight: 1.5 }}>
          {Object.keys(grouped).length} exercises · {editableSets.length} sets · {Math.floor(durationSec / 60)} min. Tap any set to adjust it before saving.
        </div>

        {Object.keys(grouped).length === 0 ? (
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, textAlign: "center", padding: 30, border: `1px dashed ${C.line}`, borderRadius: 12, marginBottom: 20 }}>
            Nothing was logged this session.
          </div>
        ) : (
          Object.entries(grouped).map(([name, setsForEx]) => (
            <div key={name} style={{ marginBottom: 18 }}>
              <div className="fg-display" style={{ color: C.textHi, fontSize: 17, fontWeight: 600, marginBottom: 8 }}>{name}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {setsForEx.map((s) => (
                  <div
                    key={s._index}
                    onClick={() => setEditingIndex(s._index)}
                    className="fg-tap"
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 10, padding: "11px 13px", cursor: "pointer" }}
                  >
                    <span className="fg-mono" style={{ color: C.textLo, fontSize: 12 }}>
                      Set {s.setNumber || "—"}: {s.reps || "—"} reps{s.weight ? ` · ${s.weight} lbs (${s.weightType || "Other"})` : ""}{s.rpe ? ` · RPE ${s.rpe}` : ""}
                    </span>
                    <MoreHorizontal size={14} color={C.textLo} />
                  </div>
                ))}
              </div>
            </div>
          ))
        )}

        <div style={{ background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, marginTop: 8, marginBottom: 24 }}>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.08em", marginBottom: 4 }}>OVERALL WORKOUT RPE</div>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginBottom: 12 }}>How did the whole session feel? 1 = easy, 10 = max effort.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
            {Array.from({ length: 10 }).map((_, i) => {
              const v = i + 1;
              return (
                <button
                  key={v}
                  onClick={() => setOverallRpe(v)}
                  className="fg-mono"
                  style={{ padding: "14px 0", borderRadius: 10, border: `1px solid ${overallRpe === v ? C.blue : C.line}`, background: overallRpe === v ? `${C.blue}33` : "transparent", color: overallRpe === v ? C.accent : C.textLo, fontSize: 15, fontWeight: 600 }}
                >
                  {v}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: 16, background: `linear-gradient(0deg, ${C.bg} 60%, transparent)` }}>
        <button
          onClick={() => onConfirm({ sets: editableSets, overallRpe })}
          className="fg-display"
          style={{ width: "100%", background: "#16A34A", border: "none", borderRadius: 14, padding: "16px", color: "white", fontWeight: 700, fontSize: 17 }}
        >
          Save Session
        </button>
      </div>

      {editingIndex !== null && (
        <SetEditSheet
          set={editableSets[editingIndex]}
          onClose={() => setEditingIndex(null)}
          onSave={(patch) => { updateSet(editingIndex, patch); setEditingIndex(null); }}
          onDelete={() => { deleteSet(editingIndex); setEditingIndex(null); }}
        />
      )}
    </div>
  );
}

function FreestyleSessionScreen({ onExit, onSaveSession }) {
  const [elapsed, setElapsed] = useState(0);
  const [log, setLog] = useState([]);
  const [picking, setPicking] = useState(false);
  const [logging, setLogging] = useState(null); // exercise being logged
  const [query, setQuery] = useState("");
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (finished) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [finished]);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  const filtered = EXERCISES.filter((ex) => ex.name.toLowerCase().includes(query.toLowerCase()));

  if (finished) {
    return (
      <ReviewLogScreen
        sets={log}
        durationSec={elapsed}
        onBack={onExit}
        onConfirm={({ sets, overallRpe }) => {
          onSaveSession({
            id: `s_${Date.now()}`,
            date: Date.now(),
            source: "freestyle",
            mode: "Freestyle",
            durationSec: elapsed,
            sets,
            overallRpe,
          });
          onExit();
        }}
      />
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: 100 }}>
      <FontImport />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 20px 6px" }}>
        <button onClick={onExit} style={{ background: "none", border: "none" }}>
          <X size={22} color={C.textLo} />
        </button>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Freestyle Log
        </div>
        <div style={{ width: 22 }} />
      </div>

      <div style={{ textAlign: "center", padding: "10px 20px 4px" }}>
        <div className="fg-display" style={{ fontSize: 44, fontWeight: 800, color: C.textHi }}>{mm}:{ss}</div>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Elapsed · {log.length} sets logged
        </div>
      </div>

      <div style={{ padding: "18px 20px 0" }}>
        <button
          onClick={() => setPicking(true)}
          className="fg-display"
          style={{
            width: "100%", background: `${C.blue}1A`, border: `1px solid ${C.blue}`, borderRadius: 12,
            padding: "15px", color: C.accent, fontWeight: 700, fontSize: 16,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}
        >
          <Plus size={18} /> Add Exercise
        </button>
      </div>

      {/* running log */}
      <div style={{ padding: "22px 20px 0" }}>
        {log.length === 0 ? (
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, textAlign: "center", padding: 30, border: `1px dashed ${C.line}`, borderRadius: 12 }}>
            Nothing logged yet. Add an exercise to get started.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...log].reverse().map((entry, i) => (
              <div
                key={i}
                style={{
                  background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px",
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                }}
              >
                <div>
                  <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 600 }}>{entry.exerciseName}</div>
                  <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 2 }}>
                    {entry.setNumber ? `Set ${entry.setNumber} · ` : ""}{entry.reps ? `${entry.reps} reps` : ""}{entry.weight ? ` · ${entry.weight} lbs` : ""}{entry.rpe ? ` · RPE ${entry.rpe}` : ""}
                    {!entry.reps && !entry.weight && !entry.rpe ? "Logged" : ""}
                  </div>
                </div>
                <Check size={16} color="#22C55E" />
              </div>
            ))}
          </div>
        )}
      </div>

      {log.length > 0 && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: 16, background: `linear-gradient(0deg, ${C.bg} 60%, transparent)` }}>
          <button
            onClick={() => setFinished(true)}
            className="fg-display"
            style={{ width: "100%", background: "#16A34A", border: "none", borderRadius: 14, padding: "16px", color: "white", fontWeight: 700, fontSize: 17 }}
          >
            Finish Session
          </button>
        </div>
      )}

      {/* exercise picker */}
      {picking && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 60, display: "flex", alignItems: "flex-end" }} onClick={() => setPicking(false)}>
          <div onClick={(e) => e.stopPropagation()} className="fg-sheet-in" style={{ width: "100%", maxHeight: "75vh", overflowY: "auto", background: C.bgRaised, borderTop: `1px solid ${C.line}`, borderRadius: "20px 20px 0 0", padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", marginBottom: 14 }}>
              <Search size={16} color={C.textLo} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search exercises"
                className="fg-mono"
                style={{ background: "none", border: "none", outline: "none", color: C.textHi, fontSize: 14, width: "100%" }}
                autoFocus
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filtered.map((ex) => (
                <div
                  key={ex.id}
                  onClick={() => { setPicking(false); setQuery(""); setLogging(ex); }}
                  style={{ background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 12, padding: "13px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <div>
                    <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 600 }}>{ex.name}</div>
                    <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 2 }}>{ex.category} · {ex.equipment}</div>
                  </div>
                  <Plus size={16} color={C.accent} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* quick log entry */}
      {logging && (
        <FreestyleLogEntry
          exercise={logging}
          setNumber={log.filter((l) => l.exerciseId === logging.id).length + 1}
          onClose={() => setLogging(null)}
          onLog={(entry) => { setLog((l) => [...l, entry]); setLogging(null); }}
        />
      )}
    </div>
  );
}

function FreestyleLogEntry({ exercise, setNumber, onClose, onLog }) {
  const [reps, setReps] = useState(0);
  const [weight, setWeight] = useState(0);
  const [weightType, setWeightType] = useState(defaultWeightType(exercise.equipment));
  const [rpe, setRpe] = useState(null);

  const submit = () => {
    onLog({ exerciseId: exercise.id, exerciseName: exercise.name, setNumber, reps: reps || null, weight: weight || null, weightType: weight ? weightType : null, rpe, loggedAt: Date.now() });
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 65, display: "flex", alignItems: "flex-end" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="fg-sheet-in" style={{ width: "100%", background: C.bgRaised, borderTop: `1px solid ${C.line}`, borderRadius: "20px 20px 0 0", padding: 22, maxHeight: "85vh", overflowY: "auto" }}>
        <div className="fg-display" style={{ color: C.textHi, fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{exercise.name}</div>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 16 }}>SET {setNumber}</div>

        <div style={{ marginBottom: 14 }}>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, letterSpacing: "0.08em", marginBottom: 6 }}>REPS THIS SET</div>
          <DialInput value={reps} onChange={setReps} min={0} max={100} step={1} unit="" />
        </div>
        <div style={{ marginBottom: 4 }}>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, letterSpacing: "0.08em", marginBottom: 6 }}>WEIGHT (LBS)</div>
          <DialInput value={weight} onChange={setWeight} min={0} max={999} step={5} unit=" lbs" />
        </div>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, marginBottom: 14 }}>
          This logs one set — e.g. {reps || "10"} reps at {weight || "60"} lbs. Add another set for the next round.
        </div>

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 10 }}>WEIGHT TYPE</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 22 }}>
          {WEIGHT_TYPES.map((w) => (
            <button
              key={w}
              onClick={() => setWeightType(w)}
              className="fg-mono"
              style={{
                padding: "12px 16px",
                borderRadius: 20,
                fontSize: 14,
                border: `1px solid ${weightType === w ? C.blue : C.line}`,
                background: weightType === w ? `${C.blue}22` : "transparent",
                color: weightType === w ? C.accent : C.textLo,
              }}
            >
              {w}
            </button>
          ))}
        </div>

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 4 }}>RPE — RATE OF PERCEIVED EXERTION</div>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginBottom: 10 }}>How hard did this set feel? 1 = easy, 10 = max effort.</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 22 }}>
          {Array.from({ length: 10 }).map((_, i) => {
            const v = i + 1;
            return (
              <button key={v} onClick={() => setRpe(v)} className="fg-mono"
                style={{ padding: "16px 0", borderRadius: 10, border: `1px solid ${rpe === v ? C.blue : C.line}`, background: rpe === v ? `${C.blue}33` : "transparent", color: rpe === v ? C.accent : C.textLo, fontSize: 16, fontWeight: 600 }}>
                {v}
              </button>
            );
          })}
        </div>

        <button onClick={submit} className="fg-display" style={{ width: "100%", background: C.blue, border: "none", borderRadius: 14, padding: "22px", color: "white", fontWeight: 700, fontSize: 20 }}>
          ◈ Log This Set
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   HISTORY — data model + seed data + aggregation helpers
   ============================================================ */
const daysAgo = (n, hour = 18) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

function makeSession(id, dayOffset, source, mode, sets, durationSec) {
  return {
    id,
    date: daysAgo(dayOffset),
    source,
    mode,
    durationSec,
    sets: sets.map((s, i) => ({ loggedAt: daysAgo(dayOffset, 18 + i * 0.1), ...s })),
  };
}

const SEED_HISTORY = [
  makeSession("seed1", 20, "builder", "Timer", [
    { exerciseId: "ex1", exerciseName: "Barbell Bench Press", setNumber: 1, totalSets: 3, reps: 8, weight: 135, rpe: 7 },
    { exerciseId: "ex1", exerciseName: "Barbell Bench Press", setNumber: 2, totalSets: 3, reps: 8, weight: 145, rpe: 8 },
    { exerciseId: "ex1", exerciseName: "Barbell Bench Press", setNumber: 3, totalSets: 3, reps: 7, weight: 145, rpe: 8 },
    { exerciseId: "ex3", exerciseName: "Overhead Press", setNumber: 1, totalSets: 3, reps: 8, weight: 75, rpe: 7 },
    { exerciseId: "ex3", exerciseName: "Overhead Press", setNumber: 2, totalSets: 3, reps: 8, weight: 75, rpe: 7 },
    { exerciseId: "ex3", exerciseName: "Overhead Press", setNumber: 3, totalSets: 3, reps: 6, weight: 75, rpe: 8 },
    { exerciseId: "ex4", exerciseName: "Barbell Curl", setNumber: 1, totalSets: 3, reps: 10, weight: 30, rpe: 6 },
    { exerciseId: "ex4", exerciseName: "Barbell Curl", setNumber: 2, totalSets: 3, reps: 10, weight: 30, rpe: 6 },
    { exerciseId: "ex4", exerciseName: "Barbell Curl", setNumber: 3, totalSets: 3, reps: 9, weight: 30, rpe: 7 },
  ], 2640),
  makeSession("seed2", 18, "builder", "Timer", [
    { exerciseId: "ex5", exerciseName: "Back Squat", setNumber: 1, totalSets: 4, reps: 6, weight: 185, rpe: 7 },
    { exerciseId: "ex5", exerciseName: "Back Squat", setNumber: 2, totalSets: 4, reps: 6, weight: 195, rpe: 8 },
    { exerciseId: "ex5", exerciseName: "Back Squat", setNumber: 3, totalSets: 4, reps: 5, weight: 205, rpe: 9 },
    { exerciseId: "ex5", exerciseName: "Back Squat", setNumber: 4, totalSets: 4, reps: 5, weight: 205, rpe: 9 },
    { exerciseId: "ex10", exerciseName: "Romanian Deadlift", setNumber: 1, totalSets: 3, reps: 8, weight: 155, rpe: 7 },
    { exerciseId: "ex10", exerciseName: "Romanian Deadlift", setNumber: 2, totalSets: 3, reps: 8, weight: 155, rpe: 7 },
    { exerciseId: "ex10", exerciseName: "Romanian Deadlift", setNumber: 3, totalSets: 3, reps: 7, weight: 155, rpe: 8 },
    { exerciseId: "ex6", exerciseName: "Plank", setNumber: 1, totalSets: 3, reps: 45, weight: null, rpe: 6 },
    { exerciseId: "ex6", exerciseName: "Plank", setNumber: 2, totalSets: 3, reps: 40, weight: null, rpe: 6 },
    { exerciseId: "ex6", exerciseName: "Plank", setNumber: 3, totalSets: 3, reps: 38, weight: null, rpe: 7 },
  ], 2280),
  makeSession("seed3", 15, "builder", "Reps", [
    { exerciseId: "ex2", exerciseName: "Pull-Up", setNumber: 1, totalSets: 4, reps: 6, weight: null, rpe: 8 },
    { exerciseId: "ex2", exerciseName: "Pull-Up", setNumber: 2, totalSets: 4, reps: 6, weight: null, rpe: 8 },
    { exerciseId: "ex2", exerciseName: "Pull-Up", setNumber: 3, totalSets: 4, reps: 5, weight: null, rpe: 9 },
    { exerciseId: "ex2", exerciseName: "Pull-Up", setNumber: 4, totalSets: 4, reps: 5, weight: null, rpe: 9 },
    { exerciseId: "ex9", exerciseName: "Kettlebell Swing", setNumber: 1, totalSets: 3, reps: 15, weight: 35, rpe: 7 },
    { exerciseId: "ex9", exerciseName: "Kettlebell Swing", setNumber: 2, totalSets: 3, reps: 15, weight: 35, rpe: 7 },
    { exerciseId: "ex9", exerciseName: "Kettlebell Swing", setNumber: 3, totalSets: 3, reps: 14, weight: 35, rpe: 8 },
  ], 1980),
  makeSession("seed4", 13, "freestyle", "Freestyle", [
    { exerciseId: "ex7", exerciseName: "Burpees", setNumber: 1, totalSets: 3, reps: 12, weight: null, rpe: 9 },
    { exerciseId: "ex7", exerciseName: "Burpees", setNumber: 2, totalSets: 3, reps: 10, weight: null, rpe: 9 },
    { exerciseId: "ex7", exerciseName: "Burpees", setNumber: 3, totalSets: 3, reps: 10, weight: null, rpe: 10 },
    { exerciseId: "ex6", exerciseName: "Plank", setNumber: 1, totalSets: 2, reps: 40, weight: null, rpe: 6 },
    { exerciseId: "ex6", exerciseName: "Plank", setNumber: 2, totalSets: 2, reps: 40, weight: null, rpe: 6 },
  ], 1140),
  makeSession("seed5", 9, "builder", "Timer", [
    { exerciseId: "ex1", exerciseName: "Barbell Bench Press", setNumber: 1, totalSets: 3, reps: 8, weight: 140, rpe: 7 },
    { exerciseId: "ex1", exerciseName: "Barbell Bench Press", setNumber: 2, totalSets: 3, reps: 8, weight: 150, rpe: 8 },
    { exerciseId: "ex1", exerciseName: "Barbell Bench Press", setNumber: 3, totalSets: 3, reps: 6, weight: 150, rpe: 9 },
    { exerciseId: "ex3", exerciseName: "Overhead Press", setNumber: 1, totalSets: 3, reps: 8, weight: 80, rpe: 8 },
    { exerciseId: "ex3", exerciseName: "Overhead Press", setNumber: 2, totalSets: 3, reps: 7, weight: 80, rpe: 8 },
    { exerciseId: "ex3", exerciseName: "Overhead Press", setNumber: 3, totalSets: 3, reps: 6, weight: 80, rpe: 9 },
    { exerciseId: "ex4", exerciseName: "Barbell Curl", setNumber: 1, totalSets: 3, reps: 10, weight: 32, rpe: 7 },
    { exerciseId: "ex4", exerciseName: "Barbell Curl", setNumber: 2, totalSets: 3, reps: 10, weight: 32, rpe: 7 },
    { exerciseId: "ex4", exerciseName: "Barbell Curl", setNumber: 3, totalSets: 3, reps: 8, weight: 32, rpe: 8 },
  ], 2520),
  makeSession("seed6", 6, "builder", "Timer", [
    { exerciseId: "ex5", exerciseName: "Back Squat", setNumber: 1, totalSets: 4, reps: 6, weight: 195, rpe: 7 },
    { exerciseId: "ex5", exerciseName: "Back Squat", setNumber: 2, totalSets: 4, reps: 6, weight: 205, rpe: 8 },
    { exerciseId: "ex5", exerciseName: "Back Squat", setNumber: 3, totalSets: 4, reps: 5, weight: 215, rpe: 9 },
    { exerciseId: "ex5", exerciseName: "Back Squat", setNumber: 4, totalSets: 4, reps: 4, weight: 215, rpe: 9 },
    { exerciseId: "ex10", exerciseName: "Romanian Deadlift", setNumber: 1, totalSets: 3, reps: 8, weight: 165, rpe: 7 },
    { exerciseId: "ex10", exerciseName: "Romanian Deadlift", setNumber: 2, totalSets: 3, reps: 8, weight: 165, rpe: 8 },
    { exerciseId: "ex10", exerciseName: "Romanian Deadlift", setNumber: 3, totalSets: 3, reps: 6, weight: 165, rpe: 8 },
  ], 2340),
  makeSession("seed7", 3, "builder", "Reps", [
    { exerciseId: "ex2", exerciseName: "Pull-Up", setNumber: 1, totalSets: 4, reps: 7, weight: null, rpe: 8 },
    { exerciseId: "ex2", exerciseName: "Pull-Up", setNumber: 2, totalSets: 4, reps: 6, weight: null, rpe: 8 },
    { exerciseId: "ex2", exerciseName: "Pull-Up", setNumber: 3, totalSets: 4, reps: 6, weight: null, rpe: 9 },
    { exerciseId: "ex2", exerciseName: "Pull-Up", setNumber: 4, totalSets: 4, reps: 5, weight: null, rpe: 9 },
    { exerciseId: "ex9", exerciseName: "Kettlebell Swing", setNumber: 1, totalSets: 3, reps: 15, weight: 40, rpe: 7 },
    { exerciseId: "ex9", exerciseName: "Kettlebell Swing", setNumber: 2, totalSets: 3, reps: 15, weight: 40, rpe: 7 },
    { exerciseId: "ex9", exerciseName: "Kettlebell Swing", setNumber: 3, totalSets: 3, reps: 13, weight: 40, rpe: 8 },
  ], 1860),
  makeSession("seed8", 1, "builder", "Timer", [
    { exerciseId: "ex1", exerciseName: "Barbell Bench Press", setNumber: 1, totalSets: 3, reps: 8, weight: 145, rpe: 7 },
    { exerciseId: "ex1", exerciseName: "Barbell Bench Press", setNumber: 2, totalSets: 3, reps: 8, weight: 155, rpe: 8 },
    { exerciseId: "ex1", exerciseName: "Barbell Bench Press", setNumber: 3, totalSets: 3, reps: 5, weight: 155, rpe: 9 },
    { exerciseId: "ex3", exerciseName: "Overhead Press", setNumber: 1, totalSets: 3, reps: 8, weight: 82, rpe: 8 },
    { exerciseId: "ex3", exerciseName: "Overhead Press", setNumber: 2, totalSets: 3, reps: 6, weight: 82, rpe: 9 },
    { exerciseId: "ex3", exerciseName: "Overhead Press", setNumber: 3, totalSets: 3, reps: 5, weight: 82, rpe: 9 },
  ], 1800),
];

const est1RM = (weight, reps) => (weight && reps ? weight * (1 + reps / 30) : weight || 0);

function useHistoryData(liveHistory) {
  return useMemo(() => {
    const sessions = [...liveHistory].sort((a, b) => b.date - a.date);
    const allSets = [];
    sessions.forEach((s) => s.sets.forEach((set) => allSets.push({ ...set, sessionId: s.id, sessionDate: s.date, sessionMode: s.mode })));

    const totalSessions = sessions.length;
    const totalSets = allSets.length;
    const totalVolume = allSets.reduce((sum, s) => sum + (s.reps && s.weight ? s.reps * s.weight : 0), 0);

    // streak: consecutive calendar days back from today with at least one session
    const dayKeys = new Set(sessions.map((s) => new Date(s.date).toDateString()));
    let streak = 0;
    for (let i = 0; i < 60; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      if (dayKeys.has(d.toDateString())) streak++;
      else if (i > 0) break;
      else continue;
    }

    // muscle set counts
    const muscleCounts = {};
    allSets.forEach((s) => {
      const ex = exById(s.exerciseId);
      if (!ex) return;
      ex.muscles.forEach((m) => { muscleCounts[m] = (muscleCounts[m] || 0) + 1; });
    });

    // per-exercise PRs (best est 1RM, or best reps if bodyweight)
    const exerciseNames = [...new Set(allSets.map((s) => s.exerciseName))];
    const prs = exerciseNames.map((name) => {
      const setsForEx = allSets.filter((s) => s.exerciseName === name);
      let best = null;
      setsForEx.forEach((s) => {
        const val = s.weight ? est1RM(s.weight, s.reps) : s.reps || 0;
        if (!best || val > best.val) best = { val, weight: s.weight, reps: s.reps, date: s.sessionDate, bodyweight: !s.weight };
      });
      return { name, ...best };
    }).sort((a, b) => b.val - a.val);

    return { sessions, allSets, totalSessions, totalSets, totalVolume, streak, muscleCounts, exerciseNames, prs };
  }, [liveHistory]);
}

/* ============================================================
   HISTORY SCREEN
   ============================================================ */
function HistoryScreen({ liveHistory, onBack, onSaveSession, onUpdateSet, onDeleteSet, onDeleteSession }) {
  const [tab, setTab] = useState("Log");
  const [expandedSession, setExpandedSession] = useState(null);
  const [progressExercise, setProgressExercise] = useState(null);
  const [progressMetric, setProgressMetric] = useState("Est 1RM");
  const [editingSet, setEditingSet] = useState(null); // { sessionId, set }
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const [backfilling, setBackfilling] = useState(false);

  const data = useHistoryData(liveHistory);
  const { sessions, allSets, totalSessions, totalSets, totalVolume, streak, muscleCounts, exerciseNames, prs } = data;

  if (backfilling) {
    return (
      <BackfillWorkoutScreen
        onCancel={() => setBackfilling(false)}
        onSave={(record) => { onSaveSession(record); setBackfilling(false); }}
      />
    );
  }

  const selectedExercise = progressExercise || exerciseNames[0];

  // 28-day calendar grid
  const calendarDays = Array.from({ length: 28 }).map((_, i) => {
    const offset = 27 - i;
    const d = new Date();
    d.setDate(d.getDate() - offset);
    const hasSession = sessions.some((s) => new Date(s.date).toDateString() === d.toDateString());
    return { date: d, hasSession };
  });

  // progress chart data for selected exercise
  const progressData = useMemo(() => {
    const bySession = {};
    allSets.filter((s) => s.exerciseName === selectedExercise).forEach((s) => {
      const key = s.sessionId;
      if (!bySession[key]) bySession[key] = { date: s.sessionDate, sets: [] };
      bySession[key].sets.push(s);
    });
    return Object.values(bySession)
      .sort((a, b) => a.date - b.date)
      .map((entry) => {
        const withWeight = entry.sets.filter((s) => s.weight);
        let value;
        if (progressMetric === "Volume") {
          value = entry.sets.reduce((sum, s) => sum + (s.reps && s.weight ? s.reps * s.weight : s.reps || 0), 0);
        } else if (progressMetric === "Max Weight") {
          value = withWeight.length ? Math.max(...withWeight.map((s) => s.weight)) : Math.max(...entry.sets.map((s) => s.reps || 0));
        } else {
          value = withWeight.length ? Math.max(...withWeight.map((s) => est1RM(s.weight, s.reps))) : Math.max(...entry.sets.map((s) => s.reps || 0));
        }
        return { label: new Date(entry.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }), value: Math.round(value) };
      });
  }, [allSets, selectedExercise, progressMetric]);

  const exerciseSetHistory = allSets.filter((s) => s.exerciseName === selectedExercise).sort((a, b) => b.loggedAt - a.loggedAt);

  // weekly volume trend (last 6 weeks)
  const weeklyVolume = useMemo(() => {
    const weeks = Array.from({ length: 6 }).map((_, i) => {
      const weeksAgo = 5 - i;
      const start = new Date();
      start.setDate(start.getDate() - weeksAgo * 7 - start.getDay());
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      const vol = allSets
        .filter((s) => s.sessionDate >= start.getTime() && s.sessionDate < end.getTime())
        .reduce((sum, s) => sum + (s.reps && s.weight ? s.reps * s.weight : 0), 0);
      return { label: start.toLocaleDateString("en-US", { month: "short", day: "numeric" }), value: Math.round(vol) };
    });
    return weeks;
  }, [allSets]);

  const muscleBarData = Object.entries(muscleCounts).sort((a, b) => b[1] - a[1]).map(([muscle, count]) => ({ muscle, count }));
  const maxMuscleCount = Math.max(1, ...Object.values(muscleCounts));

  // mock partner comparison
  const partnerStats = { sessions: Math.round(totalSessions * 0.85) + 2, volume: Math.round(totalVolume * 0.78), streak: Math.max(1, streak - 2), prs: Math.max(1, prs.length - 2) };

  const tabs = ["Log", "Progress", "Volume", "PRs", "Heatmap", "VS"];

  const axisStyle = { fontSize: 11, fontFamily: "DM Mono, monospace", fill: C.textLo };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: 40 }}>
      <FontImport />

      <div style={{ padding: "22px 20px 10px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none" }}>
          <ArrowLeft size={20} color={C.textLo} />
        </button>
        <h1 className="fg-display" style={{ color: C.textHi, fontSize: 26, fontWeight: 700, margin: 0 }}>
          History
        </h1>
      </div>

      <div style={{ display: "flex", gap: 6, padding: "10px 16px 0", overflowX: "auto" }}>
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="fg-display"
            style={{
              padding: "9px 16px",
              borderRadius: 20,
              border: `1px solid ${tab === t ? C.blue : C.line}`,
              background: tab === t ? `${C.blue}1A` : "transparent",
              color: tab === t ? C.accent : C.textLo,
              fontWeight: 600,
              fontSize: 14,
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ===== LOG TAB ===== */}
      {tab === "Log" && (
        <div style={{ padding: "18px 20px 0" }}>
          <div style={{ display: "flex", gap: 4, marginBottom: 18 }}>
            {calendarDays.map((day, i) => (
              <div
                key={i}
                title={day.date.toDateString()}
                style={{
                  flex: 1,
                  height: 26,
                  borderRadius: 4,
                  background: day.hasSession ? C.blue : C.bgCard,
                  border: `1px solid ${day.hasSession ? C.blue : C.line}`,
                }}
              />
            ))}
          </div>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, marginBottom: 20 }}>Last 28 days</div>

          <div style={{ display: "flex", gap: 10, marginBottom: 22 }}>
            {[
              ["Sessions", totalSessions],
              ["Sets", totalSets],
              ["Volume", `${Math.round(totalVolume / 1000)}k`],
              ["Streak", `${streak}d`],
            ].map(([label, val]) => (
              <div key={label} style={{ flex: 1, background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px 8px", textAlign: "center" }}>
                <div className="fg-display" style={{ color: C.textHi, fontSize: 22, fontWeight: 700 }}>{val}</div>
                <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>

          <button
            onClick={() => setBackfilling(true)}
            className="fg-display"
            style={{
              width: "100%", background: `${C.blue}1A`, border: `1px solid ${C.blue}`, borderRadius: 12,
              padding: "13px", color: C.accent, fontWeight: 700, fontSize: 14, marginBottom: 20,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            }}
          >
            <Plus size={16} /> Log a Past Workout
          </button>

          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
            Sessions
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {sessions.map((s) => {
              const exCount = new Set(s.sets.map((x) => x.exerciseId)).size;
              const expanded = expandedSession === s.id;
              const confirmingDelete = confirmingDeleteId === s.id;
              return (
                <div key={s.id} style={{ background: C.bgCard, border: `1px solid ${confirmingDelete ? "#EF4444" : C.line}`, borderRadius: 12, overflow: "hidden" }}>
                  {confirmingDelete ? (
                    <div style={{ padding: "13px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                      <span className="fg-mono" style={{ color: "#F87171", fontSize: 13 }}>Delete this whole session?</span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => setConfirmingDeleteId(null)} className="fg-display" style={{ background: "transparent", border: `1px solid ${C.line}`, borderRadius: 8, padding: "7px 12px", color: C.textLo, fontSize: 12, fontWeight: 600 }}>
                          Cancel
                        </button>
                        <button onClick={() => { onDeleteSession(s.id); setConfirmingDeleteId(null); }} className="fg-display" style={{ background: "#EF4444", border: "none", borderRadius: 8, padding: "7px 12px", color: "white", fontSize: 12, fontWeight: 700 }}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding: "13px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div onClick={() => setExpandedSession(expanded ? null : s.id)} className="fg-tap" style={{ cursor: "pointer", flex: 1 }}>
                        <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 600 }}>
                          {new Date(s.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                          <span className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginLeft: 8 }}>{s.mode}</span>
                        </div>
                        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 2 }}>
                          {exCount} exercises · {s.sets.length} sets · {s.durationSec ? `${Math.round(s.durationSec / 60)} min` : "duration unknown"}{s.overallRpe ? ` · Overall RPE ${s.overallRpe}` : ""}
                        </div>
                      </div>
                      <button onClick={() => setConfirmingDeleteId(s.id)} style={{ background: "none", border: "none", padding: 6 }}>
                        <X size={15} color={C.textLo} />
                      </button>
                      <div onClick={() => setExpandedSession(expanded ? null : s.id)} className="fg-tap" style={{ cursor: "pointer", padding: 4 }}>
                        <ChevronRight size={16} color={C.textLo} style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.2s" }} />
                      </div>
                    </div>
                  )}
                  {expanded && !confirmingDelete && (
                    <div style={{ padding: "0 14px 14px" }}>
                      {Object.entries(
                        s.sets.reduce((acc, set) => {
                          (acc[set.exerciseName] = acc[set.exerciseName] || []).push(set);
                          return acc;
                        }, {})
                      ).map(([name, sets]) => (
                        <div key={name} style={{ marginBottom: 10 }}>
                          <div className="fg-display" style={{ color: C.textHi, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{name}</div>
                          {sets.map((set, i) => (
                            <div
                              key={set.id ?? i}
                              onClick={() => set.id && setEditingSet({ sessionId: s.id, set })}
                              className="fg-mono"
                              style={{ color: C.textLo, fontSize: 11, marginBottom: 2, display: "flex", alignItems: "center", gap: 6, cursor: set.id ? "pointer" : "default" }}
                            >
                              <span>Set {set.setNumber || i + 1}: {set.reps || "—"} reps{set.weight ? ` · ${set.weight} lbs (${set.weightType || "Other"})` : ""}{set.rpe ? ` · RPE ${set.rpe}` : ""}</span>
                              {set.id && <MoreHorizontal size={12} color={C.textLo} />}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ===== PROGRESS TAB ===== */}
      {tab === "Progress" && (
        <div style={{ padding: "18px 20px 0" }}>
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 10 }}>
            {exerciseNames.map((name) => (
              <Chip key={name} label={name} active={selectedExercise === name} onClick={() => setProgressExercise(name)} />
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            {["Est 1RM", "Max Weight", "Volume"].map((m) => (
              <Chip key={m} label={m} active={progressMetric === m} onClick={() => setProgressMetric(m)} color={C.amber} />
            ))}
          </div>

          <div style={{ background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 14, padding: "16px 8px", height: 220, marginBottom: 20 }}>
            {progressData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={progressData}>
                  <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={axisStyle} axisLine={{ stroke: C.line }} tickLine={false} />
                  <YAxis tick={axisStyle} axisLine={false} tickLine={false} width={36} />
                  <Tooltip contentStyle={{ background: C.bgRaised, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: C.textHi }} />
                  <Line type="monotone" dataKey="value" stroke={C.accent} strokeWidth={2.5} dot={{ r: 3, fill: C.accent }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, textAlign: "center", paddingTop: 80 }}>No data yet for this exercise.</div>
            )}
          </div>

          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
            Set History
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {exerciseSetHistory.slice(0, 12).map((s, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px" }}>
                <div className="fg-mono" style={{ color: C.textLo, fontSize: 11 }}>
                  {new Date(s.loggedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · Set {s.setNumber || 1}
                </div>
                <div className="fg-mono" style={{ color: C.textHi, fontSize: 12 }}>
                  {s.reps || "—"} reps{s.weight ? ` · ${s.weight} lbs (${s.weightType || "Other"})` : ""}{s.rpe ? ` · RPE ${s.rpe}` : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== VOLUME TAB ===== */}
      {tab === "Volume" && (
        <div style={{ padding: "18px 20px 0" }}>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
            Sets by Muscle
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 22 }}>
            {muscleBarData.map(({ muscle, count }) => (
              <div key={muscle}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span className="fg-mono" style={{ color: C.textHi, fontSize: 12 }}>{muscle}</span>
                  <span className="fg-mono" style={{ color: C.textLo, fontSize: 11 }}>{count} sets</span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: C.bgCard, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(count / maxMuscleCount) * 100}%`, background: C.blue, borderRadius: 4 }} />
                </div>
              </div>
            ))}
          </div>

          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
            Weekly Volume Trend (lbs)
          </div>
          <div style={{ background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 14, padding: "16px 8px", height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weeklyVolume}>
                <CartesianGrid stroke={C.line} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={axisStyle} axisLine={{ stroke: C.line }} tickLine={false} />
                <YAxis tick={axisStyle} axisLine={false} tickLine={false} width={40} />
                <Tooltip contentStyle={{ background: C.bgRaised, border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: C.textHi }} />
                <Bar dataKey="value" fill={C.blue} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ===== PRs TAB ===== */}
      {tab === "PRs" && (
        <div style={{ padding: "18px 20px 0" }}>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>
            All-Time PRs
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {prs.map((pr, i) => (
              <div key={pr.name} style={{ display: "flex", alignItems: "center", gap: 12, background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 12, padding: "13px 14px" }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: i === 0 ? `${C.amber}22` : `${C.line}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Trophy size={14} color={i === 0 ? C.amber : C.textLo} />
                </div>
                <div style={{ flex: 1 }}>
                  <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 600 }}>{pr.name}</div>
                  <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 2 }}>
                    {new Date(pr.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </div>
                </div>
                <div className="fg-display" style={{ color: C.accent, fontSize: 18, fontWeight: 700 }}>
                  {pr.bodyweight ? `${pr.reps} reps` : `${Math.round(pr.val)} lbs`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== HEATMAP TAB ===== */}
      {tab === "Heatmap" && (
        <div style={{ padding: "18px 20px 0" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
            <MuscleFigurePlaceholder active pulse tint={C.blue} size={170} />
          </div>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>
            Training Frequency
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {muscleBarData.map(({ muscle, count }) => (
              <div key={muscle} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className="fg-mono" style={{ color: C.textHi, fontSize: 12, width: 90, flexShrink: 0 }}>{muscle}</div>
                <div style={{ flex: 1, height: 10, borderRadius: 5, background: C.bgCard, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(count / maxMuscleCount) * 100}%`, background: `linear-gradient(90deg, ${C.blue}, ${C.accent})`, borderRadius: 5 }} />
                </div>
                <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, width: 24, textAlign: "right" }}>{count}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== VS TAB ===== */}
      {tab === "VS" && (
        <div style={{ padding: "18px 20px 0" }}>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", textAlign: "center", marginBottom: 16 }}>
            You vs Jess
          </div>
          {[
            ["Sessions", totalSessions, partnerStats.sessions],
            ["Volume (lbs)", Math.round(totalVolume), partnerStats.volume],
            ["Streak (days)", streak, partnerStats.streak],
            ["PRs Set", prs.length, partnerStats.prs],
          ].map(([label, you, jess]) => {
            const youAhead = you >= jess;
            return (
              <div key={label} style={{ marginBottom: 16 }}>
                <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, textAlign: "center", marginBottom: 6 }}>{label}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div className="fg-display" style={{ width: 50, textAlign: "right", color: youAhead ? C.accent : C.textHi, fontWeight: 700, fontSize: 18 }}>{you}</div>
                  <div style={{ flex: 1, display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: C.bgCard }}>
                    <div style={{ width: `${(you / (you + jess || 1)) * 100}%`, background: C.blue }} />
                    <div style={{ width: `${(jess / (you + jess || 1)) * 100}%`, background: "#8B5CF6" }} />
                  </div>
                  <div className="fg-display" style={{ width: 50, color: !youAhead ? "#C4B5FD" : C.textHi, fontWeight: 700, fontSize: 18 }}>{jess}</div>
                </div>
              </div>
            );
          })}
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, textAlign: "center", marginTop: 20 }}>
            Blue = You · Purple = Jess
          </div>
        </div>
      )}

      {editingSet && (
        <SetEditSheet
          set={editingSet.set}
          onClose={() => setEditingSet(null)}
          onSave={(patch) => { onUpdateSet(editingSet.sessionId, editingSet.set.id, patch); setEditingSet(null); }}
          onDelete={() => { onDeleteSet(editingSet.sessionId, editingSet.set.id); setEditingSet(null); }}
        />
      )}
    </div>
  );
}

/* ============================================================
   SET EDIT SHEET — edit or delete a single already-logged set
   ============================================================ */
function SetEditSheet({ set, onClose, onSave, onDelete }) {
  const [reps, setReps] = useState(set.reps || 0);
  const [weight, setWeight] = useState(set.weight || 0);
  const [weightType, setWeightType] = useState(set.weightType || "Other");
  const [rpe, setRpe] = useState(set.rpe || null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 80, display: "flex", alignItems: "flex-end" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="fg-sheet-in" style={{ width: "100%", background: C.bgRaised, borderTop: `1px solid ${C.line}`, borderRadius: "20px 20px 0 0", padding: 22, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div className="fg-display" style={{ color: C.textHi, fontSize: 20, fontWeight: 700 }}>Edit Set</div>
          <button onClick={onClose} style={{ background: "none", border: "none" }}>
            <X size={20} color={C.textLo} />
          </button>
        </div>
        <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 600, marginBottom: 18 }}>{set.exerciseName}</div>

        <div style={{ marginBottom: 14 }}>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 8 }}>REPS</div>
          <DialInput value={reps} onChange={setReps} min={0} max={100} step={1} unit="" />
        </div>
        <div style={{ marginBottom: 16 }}>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 8 }}>WEIGHT (LBS)</div>
          <DialInput value={weight} onChange={setWeight} min={0} max={999} step={5} unit=" lbs" />
        </div>

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 10 }}>WEIGHT TYPE</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
          {WEIGHT_TYPES.map((w) => (
            <Chip key={w} label={w} active={weightType === w} onClick={() => setWeightType(w)} />
          ))}
        </div>

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 10 }}>RPE</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8, marginBottom: 22 }}>
          {Array.from({ length: 10 }).map((_, i) => {
            const v = i + 1;
            return (
              <button key={v} onClick={() => setRpe(v)} className="fg-mono"
                style={{ padding: "13px 0", borderRadius: 9, border: `1px solid ${rpe === v ? C.blue : C.line}`, background: rpe === v ? `${C.blue}33` : "transparent", color: rpe === v ? C.accent : C.textLo, fontSize: 14, fontWeight: 600 }}>
                {v}
              </button>
            );
          })}
        </div>

        <button
          onClick={() => onSave({ reps: reps || null, weight: weight || null, weightType: weight ? weightType : null, rpe })}
          className="fg-display"
          style={{ width: "100%", background: C.blue, border: "none", borderRadius: 12, padding: "16px", color: "white", fontWeight: 700, fontSize: 16, marginBottom: 10 }}
        >
          Save Changes
        </button>

        {confirmingDelete ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setConfirmingDelete(false)} className="fg-display" style={{ flex: 1, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 12, padding: "13px", color: C.textLo, fontWeight: 600, fontSize: 14 }}>
              Cancel
            </button>
            <button onClick={onDelete} className="fg-display" style={{ flex: 1, background: "#EF4444", border: "none", borderRadius: 12, padding: "13px", color: "white", fontWeight: 700, fontSize: 14 }}>
              Confirm Delete
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingDelete(true)}
            className="fg-display"
            style={{ width: "100%", background: "transparent", border: `1px solid #EF4444`, borderRadius: 12, padding: "13px", color: "#EF4444", fontWeight: 600, fontSize: 14 }}
          >
            Delete This Set
          </button>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   BACKFILL WORKOUT — log a full past workout that wasn't
   captured live, with a real editable date instead of a live timer
   ============================================================ */
function BackfillWorkoutScreen({ onCancel, onSave }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [log, setLog] = useState([]);
  const [picking, setPicking] = useState(false);
  const [logging, setLogging] = useState(null);
  const [query, setQuery] = useState("");

  const filtered = EXERCISES.filter((ex) => ex.name.toLowerCase().includes(query.toLowerCase()));

  const handleSave = () => {
    const [y, m, d] = date.split("-").map(Number);
    const chosenDate = new Date(y, m - 1, d, 12, 0, 0).getTime();
    onSave({
      id: `backfill_${Date.now()}`,
      date: chosenDate,
      source: "backfill",
      mode: "Backfill",
      durationSec: 0,
      sets: log,
    });
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: 100 }}>
      <FontImport />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 20px 6px" }}>
        <button onClick={onCancel} style={{ background: "none", border: "none" }}>
          <X size={22} color={C.textLo} />
        </button>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          Log a Past Workout
        </div>
        <div style={{ width: 22 }} />
      </div>

      <div style={{ padding: "14px 20px 0" }}>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", marginBottom: 8 }}>WHEN DID YOU DO THIS?</div>
        <input
          type="date"
          value={date}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => setDate(e.target.value)}
          className="fg-mono"
          style={{ width: "100%", background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 10, padding: "13px 14px", color: C.textHi, fontSize: 15, marginBottom: 18, colorScheme: "dark" }}
        />

        <button
          onClick={() => setPicking(true)}
          className="fg-display"
          style={{
            width: "100%", background: `${C.blue}1A`, border: `1px solid ${C.blue}`, borderRadius: 12,
            padding: "15px", color: C.accent, fontWeight: 700, fontSize: 16,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}
        >
          <Plus size={18} /> Add Exercise
        </button>
      </div>

      <div style={{ padding: "22px 20px 0" }}>
        {log.length === 0 ? (
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, textAlign: "center", padding: 30, border: `1px dashed ${C.line}`, borderRadius: 12 }}>
            Nothing logged yet. Add an exercise and record what you did.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...log].reverse().map((entry, i) => (
              <div key={i} style={{ background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 600 }}>{entry.exerciseName}</div>
                  <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 2 }}>
                    {entry.reps ? `${entry.reps} reps` : ""}{entry.weight ? ` · ${entry.weight} lbs` : ""}{entry.rpe ? ` · RPE ${entry.rpe}` : ""}
                  </div>
                </div>
                <Check size={16} color="#22C55E" />
              </div>
            ))}
          </div>
        )}
      </div>

      {log.length > 0 && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, padding: 16, background: `linear-gradient(0deg, ${C.bg} 60%, transparent)` }}>
          <button onClick={handleSave} className="fg-display" style={{ width: "100%", background: "#16A34A", border: "none", borderRadius: 14, padding: "16px", color: "white", fontWeight: 700, fontSize: 17 }}>
            Save This Workout
          </button>
        </div>
      )}

      {picking && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 60, display: "flex", alignItems: "flex-end" }} onClick={() => setPicking(false)}>
          <div onClick={(e) => e.stopPropagation()} className="fg-sheet-in" style={{ width: "100%", maxHeight: "70vh", overflowY: "auto", background: C.bgRaised, borderTop: `1px solid ${C.line}`, borderRadius: "20px 20px 0 0", padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", marginBottom: 14 }}>
              <Search size={16} color={C.textLo} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search exercises"
                className="fg-mono"
                style={{ background: "none", border: "none", outline: "none", color: C.textHi, fontSize: 14, width: "100%" }}
                autoFocus
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filtered.map((ex) => (
                <div
                  key={ex.id}
                  onClick={() => { setPicking(false); setQuery(""); setLogging(ex); }}
                  style={{ background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 12, padding: "13px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                >
                  <div>
                    <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 600 }}>{ex.name}</div>
                    <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 2 }}>{ex.category} · {ex.equipment}</div>
                  </div>
                  <Plus size={16} color={C.accent} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {logging && (
        <FreestyleLogEntry
          exercise={logging}
          setNumber={log.filter((l) => l.exerciseId === logging.id).length + 1}
          onClose={() => setLogging(null)}
          onLog={(entry) => { setLog((l) => [...l, entry]); setLogging(null); }}
        />
      )}
    </div>
  );
}

/* ============================================================
   SOCIAL — Friends / Requests / Profile
   Starts genuinely empty for a real account — friends only appear
   once someone actually connects via a real invite (Phase 2).
   ============================================================ */
function avatarColorFor(name) {
  const colors = [[C.blue, C.accent], ["#8B5CF6", "#C4B5FD"], [C.amber, "#FCD34D"], ["#16A34A", "#4ADE80"]];
  const idx = name.charCodeAt(0) % colors.length;
  return colors[idx];
}

function Avatar({ name, size = 44, url }) {
  const [c1, c2] = avatarColorFor(name);
  if (url) {
    return (
      <img
        src={url}
        alt={name}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
      />
    );
  }
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%",
        background: `linear-gradient(135deg, ${c1}, ${c2})`,
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      }}
    >
      <span className="fg-display" style={{ color: C.bg, fontWeight: 700, fontSize: size * 0.4 }}>
        {name[0]?.toUpperCase()}
      </span>
    </div>
  );
}

// For squad-member objects, which carry their own [c1, c2] gradient pair
// instead of deriving it from the name — same idea, real photo if present
// (only ever true for "you"; mock squad members don't have real photos).
function MemberAvatar({ member, size = 40 }) {
  if (member.avatarUrl) {
    return (
      <img
        src={member.avatarUrl}
        alt={member.name}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
      />
    );
  }
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%",
        background: `linear-gradient(135deg, ${member.color[0]}, ${member.color[1]})`,
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      }}
    >
      <span className="fg-display" style={{ color: C.bg, fontWeight: 700, fontSize: size * 0.4 }}>
        {member.name[0]?.toUpperCase()}
      </span>
    </div>
  );
}

function SocialScreen({ user, history, onBack, onSignOut, onStartSquad, onChangeAvatar }) {
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]);
  const [copied, setCopied] = useState(false);
  const [invitedToast, setInvitedToast] = useState(null);
  const [socialHydrated, setSocialHydrated] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const fileInputRef = useRef(null);
  const inviteCode = useMemo(() => `FORGE-${(user?.name || "YOU").slice(0, 3).toUpperCase()}${Math.floor(1000 + Math.random() * 9000)}`, [user]);
  const friendsKey = `social-friends:${user?.id || "anon"}`;
  const requestsKey = `social-requests:${user?.id || "anon"}`;

  const handleAvatarFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    setAvatarError("");
    if (!file.type.startsWith("image/")) {
      setAvatarError("Please choose an image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setAvatarError("That photo is a bit large — please choose one under 5MB.");
      return;
    }
    setUploadingAvatar(true);
    await onChangeAvatar(file);
    setUploadingAvatar(false);
  };

  useEffect(() => {
    (async () => {
      const [storedFriends, storedRequests] = await Promise.all([storageGet(friendsKey), storageGet(requestsKey)]);
      if (storedFriends) setFriends(storedFriends);
      if (storedRequests) setRequests(storedRequests);
      setSocialHydrated(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => { if (socialHydrated) storageSet(friendsKey, friends); }, [friends, socialHydrated, friendsKey]);
  useEffect(() => { if (socialHydrated) storageSet(requestsKey, requests); }, [requests, socialHydrated, requestsKey]);

  const handleCopy = () => {
    const link = `https://forge.app/join/${inviteCode}`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(link).catch(() => {});
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const acceptRequest = (req) => {
    setFriends((f) => [...f, { id: req.id, name: req.name, online: false, location: "Just connected", streak: 0 }]);
    setRequests((r) => r.filter((x) => x.id !== req.id));
  };

  const declineRequest = (req) => setRequests((r) => r.filter((x) => x.id !== req.id));

  const inviteToLift = (friend) => {
    setInvitedToast(friend.name);
    setTimeout(() => setInvitedToast(null), 1800);
  };

  // real stats, not placeholders — derived from actual History
  const sessionCount = (history || []).length;
  const dayKeys = new Set((history || []).map((s) => new Date(s.date).toDateString()));
  let streak = 0;
  for (let i = 0; i < 60; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    if (dayKeys.has(d.toDateString())) streak++;
    else if (i > 0) break;
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: 40 }}>
      <FontImport />

      <div style={{ padding: "22px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onBack} style={{ background: "none", border: "none" }}>
            <ArrowLeft size={20} color={C.textLo} />
          </button>
          <h1 className="fg-display" style={{ color: C.textHi, fontSize: 26, fontWeight: 700, margin: 0 }}>
            Social
          </h1>
        </div>
        <button onClick={() => setShowProfile(true)} style={{ background: "none", border: "none", padding: 0 }}>
          <Avatar name={user?.name || "You"} size={38} url={user?.avatarUrl} />
        </button>
      </div>

      <div style={{ padding: "18px 20px 0" }}>
        <div style={{ background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <UserPlus size={15} color={C.accent} />
            <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 700 }}>
              Invite a Training Partner
            </div>
          </div>
          <div
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
              background: C.bg, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", marginBottom: 8,
            }}
          >
            <span className="fg-mono" style={{ color: C.textHi, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              forge.app/join/{inviteCode}
            </span>
            <button
              onClick={handleCopy}
              style={{
                background: copied ? "#16A34A" : C.blue, border: "none", borderRadius: 8, padding: "7px 12px",
                color: "white", display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
              }}
              className="fg-mono"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, lineHeight: 1.4 }}>
            Invites aren't fully live yet — connections stay on this device until real accounts can link up directly.
          </div>
        </div>

        {requests.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div className="fg-mono" style={{ color: C.amber, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>
              Requests ({requests.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {requests.map((r) => (
                <div key={r.id} style={{ background: C.bgCard, border: `1px solid ${C.amber}44`, borderRadius: 12, padding: "12px 14px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <Avatar name={r.name} size={36} />
                    <div style={{ flex: 1 }}>
                      <div className="fg-display" style={{ color: C.textHi, fontSize: 15, fontWeight: 600 }}>{r.name}</div>
                      <div className="fg-mono" style={{ color: C.textLo, fontSize: 10 }}>
                        {r.mutual > 0 ? `${r.mutual} mutual connections` : "New to FORGE"}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => declineRequest(r)} className="fg-display" style={{ flex: 1, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px", color: C.textLo, fontWeight: 600, fontSize: 13 }}>
                      Decline
                    </button>
                    <button onClick={() => acceptRequest(r)} className="fg-display" style={{ flex: 1, background: C.blue, border: "none", borderRadius: 8, padding: "9px", color: "white", fontWeight: 700, fontSize: 13 }}>
                      Accept
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={onStartSquad}
          className="fg-display"
          style={{
            width: "100%", background: `linear-gradient(135deg, ${C.blue}, #1D4ED8)`, border: "none", borderRadius: 14,
            padding: "16px", color: "white", fontWeight: 700, fontSize: 16, marginBottom: 22,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            boxShadow: `0 8px 24px ${C.blue}33`,
          }}
        >
          <Users size={17} /> Start Squad Session
        </button>

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>
          Your Gym ({friends.length})
        </div>
        {friends.length === 0 ? (
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, textAlign: "center", padding: 30, border: `1px dashed ${C.line}`, borderRadius: 12 }}>
            No one here yet — send the invite link above to bring in your first training partner.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {friends.map((f) => (
              <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 12, background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px" }}>
                <div style={{ position: "relative" }}>
                  <Avatar name={f.name} />
                  <div
                    style={{
                      position: "absolute", bottom: -1, right: -1, width: 11, height: 11, borderRadius: "50%",
                      background: f.online ? "#22C55E" : C.textLo, border: `2px solid ${C.bgCard}`,
                    }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 600 }}>{f.name}</div>
                  <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 2 }}>
                    {f.location} {f.streak > 0 ? `· ${f.streak}d streak` : ""}
                  </div>
                </div>
                <button
                  onClick={() => inviteToLift(f)}
                  className="fg-display"
                  style={{
                    background: `${C.blue}1A`, border: `1px solid ${C.blue}`, borderRadius: 8,
                    padding: "8px 12px", color: C.accent, fontWeight: 600, fontSize: 12, flexShrink: 0,
                  }}
                >
                  Invite to Lift
                </button>
              </div>
            ))}
          </div>
        )}

        {invitedToast && (
          <div className="fg-mono" style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#16A34A", color: "white", padding: "10px 18px", borderRadius: 10, fontSize: 13, boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
            Invited {invitedToast} to lift 💪
          </div>
        )}
      </div>

      {showProfile && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 60, display: "flex", alignItems: "flex-end" }} onClick={() => setShowProfile(false)}>
          <div onClick={(e) => e.stopPropagation()} className="fg-sheet-in" style={{ width: "100%", background: C.bgRaised, borderTop: `1px solid ${C.line}`, borderRadius: "20px 20px 0 0", padding: 22, maxHeight: "80vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
              <button onClick={() => setShowProfile(false)} style={{ background: "none", border: "none" }}>
                <X size={20} color={C.textLo} />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 26 }}>
              <div
                onClick={() => fileInputRef.current?.click()}
                style={{ position: "relative", cursor: "pointer" }}
                title="Tap to change your photo"
              >
                <Avatar name={user?.name || "Casey"} size={72} url={user?.avatarUrl} />
                <div
                  style={{
                    position: "absolute", bottom: -2, right: -2, width: 26, height: 26, borderRadius: "50%",
                    background: C.blue, border: `2px solid ${C.bgRaised}`, display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  {uploadingAvatar ? (
                    <div className="fg-mono" style={{ color: "white", fontSize: 8 }}>···</div>
                  ) : (
                    <Camera size={12} color="white" />
                  )}
                </div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={handleAvatarFileChange}
              />
              <div className="fg-display" style={{ color: C.textHi, fontSize: 24, fontWeight: 700, marginTop: 12 }}>
                {user?.name || "Casey"}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <Mail size={12} color={C.textLo} />
                <span className="fg-mono" style={{ color: C.textLo, fontSize: 12 }}>{user?.email || "you@forge.app"}</span>
              </div>
              {avatarError && (
                <div className="fg-mono" style={{ color: "#F87171", fontSize: 11, marginTop: 8, textAlign: "center" }}>{avatarError}</div>
              )}
            </div>

            <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
              {[
                ["Friends", friends.length],
                ["Streak", `${streak}d`],
                ["Sessions", sessionCount],
              ].map(([label, val]) => (
                <div key={label} style={{ flex: 1, background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 12, padding: "14px 8px", textAlign: "center" }}>
                  <div className="fg-display" style={{ color: C.textHi, fontSize: 20, fontWeight: 700 }}>{val}</div>
                  <div className="fg-mono" style={{ color: C.textLo, fontSize: 10, marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>

            <button
              onClick={onSignOut}
              className="fg-display"
              style={{
                width: "100%", background: "transparent", border: `1px solid #EF4444`, borderRadius: 12,
                padding: "14px", color: "#EF4444", fontWeight: 700, fontSize: 15,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              <LogOut size={16} /> Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   SQUAD SESSION — proof of concept for multi-person training
   No real syncing (no backend), but the full interaction model:
   roster, collaborative building, rotation, chat, leaderboard, audio.

   Rotation model (CrossFit-style station sharing): the squad builds
   one shared, ordered station list. Each member gets a starting
   index into it. Completing a station advances currentIndex by 1,
   wrapping back to 0 at the end — so members starting mid-list loop
   around until they've hit every station once (one "round").
   ============================================================ */
const SQUAD_MEMBERS_SEED = [
  { id: "me", name: "You", isMe: true, color: [C.blue, C.accent], online: true, startIndex: 0, currentIndex: 0, completedCount: 0, streak: 5 },
  { id: "f1", name: "Jess", isMe: false, color: ["#8B5CF6", "#C4B5FD"], online: true, startIndex: 1, currentIndex: 1, completedCount: 3, streak: 5 },
  { id: "f2", name: "Marcus", isMe: false, color: [C.amber, "#FCD34D"], online: true, startIndex: 2, currentIndex: 3, completedCount: 5, streak: 2 },
  { id: "f3", name: "Priya", isMe: false, color: ["#16A34A", "#4ADE80"], online: false, startIndex: 3, currentIndex: 3, completedCount: 1, streak: 3 },
];

const squadStationName = (sequence, index) => (sequence.length ? sequence[((index % sequence.length) + sequence.length) % sequence.length]?.name : "—");

const chatRelativeTime = (ts) => {
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
};

const SQUAD_CHAT_SEED = [
  { id: "c1", from: "Jess", text: "Squats today are brutal 😤", mine: false, at: Date.now() - 1000 * 60 * 12 },
  { id: "c2", from: "Marcus", text: "Same, on my last set of pull-ups", mine: false, at: Date.now() - 1000 * 60 * 8 },
  { id: "c3", from: "You", text: "Let's go! 💪", mine: true, at: Date.now() - 1000 * 60 * 6 },
];

const QUICK_REPLIES = ["💪 Nice set!", "🔥 Let's go!", "Almost there", "Need a minute", "One more round"];

function useMetronomeClick(bpm, playing) {
  const ctxRef = useRef(null);
  const intervalRef = useRef(null);

  const click = () => {
    try {
      const ctx = ctxRef.current;
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.16, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.09);
    } catch {
      // Web Audio unavailable in this context — click silently no-ops
    }
  };

  useEffect(() => {
    if (playing) {
      if (!ctxRef.current) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) ctxRef.current = new AudioCtx();
      }
      click();
      intervalRef.current = setInterval(click, 60000 / bpm);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, bpm]);
}

function SquadAudioBar({ bpm, onBpmChange, playing, onTogglePlay }) {
  useMetronomeClick(bpm, playing);
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
        background: `${C.blue}14`, borderBottom: `1px solid ${C.line}`,
      }}
    >
      <div style={{ width: 32, height: 32, borderRadius: 8, background: `${C.blue}33`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Music size={14} color={C.accent} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="fg-display" style={{ color: C.textHi, fontSize: 13, fontWeight: 600 }}>
          Squad Pace Click · {bpm} BPM
        </div>
        <div className="fg-mono" style={{ color: C.textLo, fontSize: 10 }}>
          Real audio, plays locally — ready to sync once there's a backend
        </div>
      </div>
      <button onClick={() => onBpmChange(Math.max(60, bpm - 4))} style={{ background: "none", border: "none", padding: 4, color: C.textLo }} className="fg-mono">
        −
      </button>
      <button onClick={onTogglePlay} style={{ background: "none", border: "none", padding: 4 }}>
        {playing ? <Pause size={16} color={C.textHi} /> : <Play size={16} color={C.textHi} />}
      </button>
      <button onClick={() => onBpmChange(Math.min(200, bpm + 4))} style={{ background: "none", border: "none", padding: 4, color: C.textLo }} className="fg-mono">
        +
      </button>
    </div>
  );
}

function SquadSessionScreen({
  onBack,
  squadSequence, setSquadSequence,
  squadBurnout, setSquadBurnout,
  squadConfig, setSquadConfig,
  squadMembers,
  onAddToBuild, onAddToBurnout,
  onAutoAssignStarts, onAssignStart, onAdvanceMe, onResetRotation,
  onStartSquadWorkout, onSaveTemplate,
}) {
  const [buildSubTab, setBuildSubTab] = useState("Library");
  const [chat, setChat] = useState(SQUAD_CHAT_SEED);
  const [chatText, setChatText] = useState("");
  const chatScrollRef = useRef(null);
  const [showBuildTogether, setShowBuildTogether] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [lastSeenChatCount, setLastSeenChatCount] = useState(SQUAD_CHAT_SEED.length);

  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat, showChat]);
  const [bpm, setBpm] = useState(128);
  const [playing, setPlaying] = useState(false);
  const [assigningMember, setAssigningMember] = useState(null);
  const [doneFlash, setDoneFlash] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const roomCode = useMemo(() => `SQD-${Math.floor(1000 + Math.random() * 9000)}`, []);

  const sendChat = (text) => {
    if (!text.trim()) return;
    setChat((c) => [...c, { id: `c_${Date.now()}`, from: "You", text, mine: true, at: Date.now() }]);
    setChatText("");
  };

  const openChat = () => {
    setShowChat(true);
    setLastSeenChatCount(chat.length);
  };

  const unreadChat = chat.length - lastSeenChatCount;

  const n = squadSequence.length;
  const me = squadMembers.find((m) => m.isMe);
  const leaderboard = [...squadMembers]
    .map((m) => ({ ...m, points: m.completedCount * 10 + m.streak * 5 }))
    .sort((a, b) => b.points - a.points);

  if (previewing) {
    const startAt = me ? me.currentIndex % Math.max(1, n) : 0;
    const rotated = n > 0 ? [...squadSequence.slice(startAt), ...squadSequence.slice(0, startAt)] : [];
    return (
      <WorkoutPreviewScreen
        buildList={rotated}
        burnoutList={squadBurnout}
        config={squadConfig}
        onBack={() => setPreviewing(false)}
        onConfirm={onStartSquadWorkout}
      />
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column" }}>
      <FontImport />

      <div style={{ padding: "22px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={onBack} style={{ background: "none", border: "none" }}>
            <ArrowLeft size={20} color={C.textLo} />
          </button>
          <div>
            <h1 className="fg-display" style={{ color: C.textHi, fontSize: 24, fontWeight: 700, margin: 0 }}>Squad Session</h1>
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 11 }}>Room {roomCode} · {squadMembers.filter((m) => m.online).length} online</div>
          </div>
        </div>
      </div>

      <SquadAudioBar
        bpm={bpm}
        onBpmChange={setBpm}
        playing={playing}
        onTogglePlay={() => setPlaying((p) => !p)}
      />

      {/* two clear secondary actions, not co-equal tabs — Roster is the one primary view */}
      <div style={{ display: "flex", gap: 8, padding: "12px 20px 0" }}>
        <button
          onClick={() => setShowBuildTogether(true)}
          className="fg-display"
          style={{
            flex: 1, padding: "12px 0", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bgCard,
            color: C.textHi, fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}
        >
          <LayoutList size={15} /> Build Together
        </button>
        <button
          onClick={openChat}
          className="fg-display"
          style={{
            flex: 1, padding: "12px 0", borderRadius: 10, border: `1px solid ${C.line}`, background: C.bgCard,
            color: C.textHi, fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, position: "relative",
          }}
        >
          <MessageCircle size={15} /> Chat
          {unreadChat > 0 && (
            <span style={{ position: "absolute", top: 6, right: "28%", width: 8, height: 8, borderRadius: "50%", background: C.amber }} />
          )}
        </button>
      </div>

      {/* ===== ROSTER (the one primary view) ===== */}
      <div style={{ padding: "18px 20px 20px", flex: 1 }}>
        {leaderboard.some((m) => m.points > 0) && (
          <div style={{ display: "flex", gap: 8, marginBottom: 18, overflowX: "auto" }}>
            {leaderboard.slice(0, 3).map((m, i) => (
              <div key={m.id} style={{ flex: 1, minWidth: 100, background: C.bgCard, border: `1px solid ${i === 0 ? C.amber : C.line}`, borderRadius: 12, padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 }}>
                {i === 0 ? <Crown size={13} color={C.amber} /> : <span className="fg-mono" style={{ color: C.textLo, fontSize: 11 }}>{i + 1}</span>}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="fg-display" style={{ color: C.textHi, fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</div>
                  <div className="fg-mono" style={{ color: C.accent, fontSize: 10, display: "flex", alignItems: "center", gap: 3 }}><Zap size={9} /> {m.points}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {n === 0 ? (
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, textAlign: "center", padding: 30, border: `1px dashed ${C.line}`, borderRadius: 12, marginBottom: 20 }}>
            Tap "Build Together" above to add exercises, then come back here to set starting positions.
          </div>
        ) : (
          <>
            {/* station rotation assignment */}
            <div style={{ background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 700 }}>Station Rotation</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={onResetRotation}
                    className="fg-mono"
                    style={{ background: "transparent", border: `1px solid ${C.line}`, borderRadius: 8, padding: "6px 10px", color: C.textLo, fontSize: 11 }}
                  >
                    Reset
                  </button>
                  <button
                    onClick={onAutoAssignStarts}
                    className="fg-mono"
                    style={{ background: `${C.blue}1A`, border: `1px solid ${C.blue}`, borderRadius: 8, padding: "6px 10px", color: C.accent, fontSize: 11 }}
                  >
                    Auto-Assign Starts
                  </button>
                </div>
              </div>
              <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginBottom: 12, lineHeight: 1.5 }}>
                {assigningMember ? `Tap a station to start ${assigningMember} there.` : "Tap a member below, then tap a station to set their starting point."}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {squadSequence.map((st, i) => {
                  const here = squadMembers.filter((m) => m.currentIndex % n === i);
                  return (
                    <div
                      key={st.uid}
                      onClick={() => { if (assigningMember) { onAssignStart(assigningMember, i); setAssigningMember(null); } }}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 8,
                        background: assigningMember ? `${C.blue}0F` : "transparent",
                        border: `1px solid ${assigningMember ? C.blue + "55" : "transparent"}`,
                        cursor: assigningMember ? "pointer" : "default",
                      }}
                    >
                      <span className="fg-mono" style={{ color: C.textLo, fontSize: 11, width: 16 }}>{i + 1}</span>
                      <span className="fg-display" style={{ color: C.textHi, fontSize: 14, fontWeight: 600, flex: 1 }}>{st.name}</span>
                      <div style={{ display: "flex", gap: 3 }}>
                        {here.map((m) => (
                          <div key={m.id} title={m.name}>
                            <MemberAvatar member={m} size={18} />
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* your turn */}
            {me && (
              <div style={{ background: `${C.blue}14`, border: `1px solid ${C.blue}`, borderRadius: 14, padding: 16, marginBottom: 18 }}>
                <div className="fg-mono" style={{ color: C.accent, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Your Station</div>
                <div className="fg-display" style={{ color: C.textHi, fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{squadStationName(squadSequence, me.currentIndex)}</div>
                <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, marginBottom: 14 }}>
                  Round {Math.floor(me.completedCount / n) + 1} · {me.completedCount % n} of {n} stations this round
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    onClick={() => { onAdvanceMe(); setDoneFlash(true); setTimeout(() => setDoneFlash(false), 1000); }}
                    className="fg-display"
                    style={{ flex: 1, background: doneFlash ? "#16A34A" : C.blue, border: "none", borderRadius: 10, padding: "13px", color: "white", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, transition: "background 0.2s" }}
                  >
                    {doneFlash ? <Check size={15} /> : null} {doneFlash ? "Nice work!" : "Done"} {!doneFlash && <ArrowRight size={15} />}
                  </button>
                  <button
                    onClick={() => setPreviewing(true)}
                    className="fg-display"
                    style={{ flex: 1, background: "#16A34A", border: "none", borderRadius: 10, padding: "13px", color: "white", fontWeight: 700, fontSize: 14 }}
                  >
                    Start Workout
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Squad</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {squadMembers.map((m) => (
            <div key={m.id} style={{ background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 14, padding: 14, display: "flex", alignItems: "center", gap: 12 }}>
              <div
                onClick={() => !m.isMe && n > 0 && setAssigningMember(assigningMember === m.id ? null : m.id)}
                style={{ position: "relative", cursor: !m.isMe && n > 0 ? "pointer" : "default" }}
              >
                <div
                  style={{
                    borderRadius: "50%",
                    boxShadow: assigningMember === m.id ? `0 0 0 3px ${C.blue}` : "none",
                  }}
                >
                  <MemberAvatar member={m} size={42} />
                </div>
                <div style={{ position: "absolute", bottom: -1, right: -1, width: 11, height: 11, borderRadius: "50%", background: m.online ? "#22C55E" : C.textLo, border: `2px solid ${C.bgCard}` }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="fg-display" style={{ color: C.textHi, fontSize: 16, fontWeight: 600 }}>
                  {m.name} {m.isMe && <span className="fg-mono" style={{ color: C.textLo, fontSize: 10 }}>(you)</span>}
                </div>
                <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, marginTop: 2 }}>
                  {n === 0 ? "No stations yet" : m.online ? `On: ${squadStationName(squadSequence, m.currentIndex)}` : "Resting / offline"} · {m.completedCount} done
                </div>
                {n > 0 && (
                  <div style={{ height: 4, borderRadius: 2, background: C.line, marginTop: 6, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, ((m.completedCount % n) / n) * 100)}%`, background: `linear-gradient(90deg, ${m.color[0]}, ${m.color[1]})` }} />
                  </div>
                )}
              </div>
              {m.streak > 0 && (
                <div className="fg-mono" style={{ color: C.amber, fontSize: 11, display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
                  <Flame size={12} /> {m.streak}d
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ===== BUILD TOGETHER (overlay) ===== */}
      {showBuildTogether && (
        <div style={{ position: "fixed", inset: 0, background: C.bg, zIndex: 70, display: "flex", flexDirection: "column" }}>
          <FontImport />
          <div style={{ padding: "20px 20px 0", display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => setShowBuildTogether(false)} style={{ background: "none", border: "none" }}>
              <ArrowLeft size={20} color={C.textLo} />
            </button>
            <h2 className="fg-display" style={{ color: C.textHi, fontSize: 22, fontWeight: 700, margin: 0 }}>Build Together</h2>
          </div>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, padding: "10px 20px 0", lineHeight: 1.5 }}>
            The same Library and Builder you use for personal workouts — anything added here is shared with the whole squad.
          </div>
          <div style={{ display: "flex", gap: 8, padding: "12px 20px 0" }}>
            {["Library", "Builder"].map((t) => (
              <button
                key={t}
                onClick={() => setBuildSubTab(t)}
                className="fg-display"
                style={{
                  flex: 1, padding: "10px 0", borderRadius: 10,
                  border: `1px solid ${buildSubTab === t ? C.blue : C.line}`,
                  background: buildSubTab === t ? `${C.blue}1A` : "transparent",
                  color: buildSubTab === t ? C.accent : C.textLo, fontWeight: 600, fontSize: 14,
                }}
              >
                {t}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {buildSubTab === "Library" && (
              <LibraryTab
                onAddToBuild={onAddToBuild}
                onAddToBurnout={onAddToBurnout}
                addedIds={new Set(squadSequence.map((b) => b.id))}
                burnoutIds={new Set(squadBurnout.map((b) => b.id))}
              />
            )}

            {buildSubTab === "Builder" && (
              <BuilderTab
                buildList={squadSequence}
                setBuildList={setSquadSequence}
                burnoutList={squadBurnout}
                setBurnoutList={setSquadBurnout}
                config={squadConfig}
                setConfig={setSquadConfig}
                onSaveTemplate={onSaveTemplate}
              />
            )}
          </div>
        </div>
      )}

      {/* ===== CHAT (overlay) ===== */}
      {showChat && (
        <div style={{ position: "fixed", inset: 0, background: C.bg, zIndex: 70, display: "flex", flexDirection: "column" }}>
          <FontImport />
          <div style={{ padding: "20px 20px 0", display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => setShowChat(false)} style={{ background: "none", border: "none" }}>
              <ArrowLeft size={20} color={C.textLo} />
            </button>
            <h2 className="fg-display" style={{ color: C.textHi, fontSize: 22, fontWeight: 700, margin: 0 }}>Squad Chat</h2>
          </div>
          <div ref={chatScrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
            {chat.map((m) => (
              <div key={m.id} style={{ display: "flex", justifyContent: m.mine ? "flex-end" : "flex-start", marginBottom: 10 }}>
                <div
                  style={{
                    maxWidth: "75%", padding: "10px 13px", borderRadius: 14,
                    background: m.mine ? C.blue : C.bgCard, border: m.mine ? "none" : `1px solid ${C.line}`,
                  }}
                >
                  {!m.mine && <div className="fg-mono" style={{ color: C.accent, fontSize: 10, marginBottom: 3 }}>{m.from}</div>}
                  <div className="fg-display" style={{ color: "white", fontSize: 14 }}>{m.text}</div>
                  <div className="fg-mono" style={{ color: m.mine ? "#DBEAFE" : C.textLo, fontSize: 9, marginTop: 4, textAlign: "right" }}>
                    {chatRelativeTime(m.at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: "10px 20px", display: "flex", gap: 6, overflowX: "auto" }}>
            {QUICK_REPLIES.map((q) => (
              <button
                key={q}
                onClick={() => sendChat(q)}
                className="fg-mono"
                style={{ flexShrink: 0, padding: "8px 12px", borderRadius: 16, border: `1px solid ${C.line}`, background: C.bgCard, color: C.textHi, fontSize: 12 }}
              >
                {q}
              </button>
            ))}
          </div>
          <div style={{ padding: "10px 20px 20px", display: "flex", gap: 10 }}>
            <input
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") sendChat(chatText); }}
              placeholder="Message the squad..."
              className="fg-mono"
              style={{ flex: 1, background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 20, padding: "12px 16px", color: C.textHi, fontSize: 14 }}
            />
            <button onClick={() => sendChat(chatText)} style={{ width: 44, height: 44, borderRadius: "50%", background: C.blue, border: "none", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Send size={17} color="white" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   APP SHELL
   ============================================================ */
/* ============================================================
   ONBOARDING TUTORIAL — shown exactly once per real account,
   right after their first successful login. Status is stored on
   the profile itself (not locally), so it correctly follows the
   account across devices instead of reappearing on a new browser.
   ============================================================ */
const ONBOARDING_STEPS = [
  {
    icon: Dumbbell,
    title: "Welcome to FORGE",
    body: "A synchronized training app built for you and the people you train with — solo or together, in the same room or apart.",
  },
  {
    icon: HomeIcon,
    title: "Home is your launchpad",
    body: "Quick-start a workout, jump into a saved Template, log something freeform, or pick up right where a template or Squad session left off.",
  },
  {
    icon: LayoutList,
    title: "Build it your way",
    body: "Pick exercises from the Library, drag to reorder, link supersets, and choose how it runs — Timer, Reps, or self-paced Sequence. Circuit or Exercise-First, your call.",
  },
  {
    icon: Play,
    title: "Train with a real timer",
    body: "Work and rest auto-advance for you. Tap Log Set anytime — even mid-set — to record reps, weight, and effort without breaking stride.",
  },
  {
    icon: TrendingUp,
    title: "Watch it add up",
    body: "Every set you log builds real History — PRs, volume trends, and progress charts, all from what you actually did.",
  },
  {
    icon: Users,
    title: "Train together",
    body: "Invite people, build a Squad Session together, and share a station rotation — everyone moving through the same stations, together.",
  },
];

function OnboardingTutorialScreen({ onDone }) {
  const [step, setStep] = useState(0);
  const isLast = step === ONBOARDING_STEPS.length - 1;
  const current = ONBOARDING_STEPS[step];
  const Icon = current.icon;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", padding: 24 }}>
      <FontImport />

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={onDone} className="fg-mono" style={{ background: "none", border: "none", color: C.textLo, fontSize: 13, padding: 8 }}>
          Skip
        </button>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        <div
          style={{
            width: 84, height: 84, borderRadius: 22, marginBottom: 30,
            background: `linear-gradient(135deg, ${C.blue}, ${C.accent})`,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 0 40px ${C.blue}44`,
          }}
        >
          <Icon size={38} color={C.bg} strokeWidth={2} />
        </div>
        <h1 className="fg-display" style={{ color: C.textHi, fontSize: 30, fontWeight: 700, margin: "0 0 14px", maxWidth: 320 }}>
          {current.title}
        </h1>
        <p style={{ color: C.textLo, fontSize: 15, lineHeight: 1.6, maxWidth: 320, margin: 0 }}>
          {current.body}
        </p>
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 26 }}>
        {ONBOARDING_STEPS.map((_, i) => (
          <div key={i} style={{ width: i === step ? 20 : 6, height: 6, borderRadius: 3, background: i === step ? C.blue : C.line, transition: "width 0.2s" }} />
        ))}
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        {step > 0 && (
          <button
            onClick={() => setStep((s) => s - 1)}
            className="fg-display"
            style={{ flex: 1, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 12, padding: "16px", color: C.textLo, fontWeight: 600, fontSize: 16 }}
          >
            Back
          </button>
        )}
        <button
          onClick={() => (isLast ? onDone() : setStep((s) => s + 1))}
          className="fg-display"
          style={{
            flex: 2, background: `linear-gradient(135deg, ${C.blue}, #1D4ED8)`, border: "none", borderRadius: 12,
            padding: "16px", color: "white", fontWeight: 700, fontSize: 16,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}
        >
          {isLast ? "Get Started" : "Next"} <ArrowRight size={17} />
        </button>
      </div>
    </div>
  );
}


/* ============================================================
   PROGRAMS SCREEN — browse guided multi-week plans, start one,
   or check in on the one you're already running
   ============================================================ */
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ProgramsScreen({ activeProgramRow, onBack, onStartProgram, onCancelProgram, onStartTodayWorkout }) {
  const [viewing, setViewing] = useState(null); // a program being previewed
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const activeProgram = activeProgramRow ? PROGRAMS.find((p) => p.id === activeProgramRow.program_id) : null;
  const todayInfo = activeProgramRow ? getTodayProgramDay(activeProgramRow) : null;

  if (viewing) {
    const p = viewing;
    return (
      <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: 30 }}>
        <FontImport />
        <div style={{ padding: "22px 20px 6px", display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setViewing(null)} style={{ background: "none", border: "none" }}>
            <ArrowLeft size={20} color={C.textLo} />
          </button>
          <h1 className="fg-display" style={{ color: C.textHi, fontSize: 22, fontWeight: 700, margin: 0 }}>{p.name}</h1>
        </div>
        <div style={{ padding: "12px 20px 0" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <Chip label={p.goal} active color={p.color} />
            <Chip label={`${p.durationWeeks} weeks`} active color={C.textLo} />
          </div>
          <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>{p.description}</div>

          <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Weekly Schedule</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
            {[1, 2, 3, 4, 5, 6, 0].map((dayNum) => {
              const d = p.days.find((x) => x.day === dayNum);
              const isRest = !d || d.type === "rest";
              return (
                <div key={dayNum} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", borderRadius: 10, background: isRest ? "transparent" : C.bgCard, border: `1px solid ${isRest ? C.line : p.color + "44"}` }}>
                  <span className="fg-mono" style={{ color: C.textLo, fontSize: 11, width: 34 }}>{DAY_NAMES[dayNum]}</span>
                  <span className="fg-display" style={{ color: isRest ? C.textLo : C.textHi, fontSize: 15, fontWeight: 600 }}>{isRest ? "Rest" : d.label}</span>
                </div>
              );
            })}
          </div>

          <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, lineHeight: 1.6, marginBottom: 22, padding: "12px 14px", background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 10 }}>
            <span style={{ color: C.accent }}>Progression: </span>{p.progressionNote}
          </div>

          <button
            onClick={() => { onStartProgram(p.id); setViewing(null); }}
            className="fg-display"
            style={{ width: "100%", background: p.color, border: "none", borderRadius: 14, padding: "16px", color: "white", fontWeight: 700, fontSize: 16 }}
          >
            Start This Program
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, paddingBottom: 30 }}>
      <FontImport />
      <div style={{ padding: "22px 20px 10px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none" }}>
          <ArrowLeft size={20} color={C.textLo} />
        </button>
        <h1 className="fg-display" style={{ color: C.textHi, fontSize: 26, fontWeight: 700, margin: 0 }}>Programs</h1>
      </div>

      <div style={{ padding: "10px 20px 0" }}>
        {activeProgram && todayInfo && (
          <div style={{ background: `${activeProgram.color}14`, border: `1px solid ${activeProgram.color}`, borderRadius: 14, padding: 16, marginBottom: 22 }}>
            <div className="fg-mono" style={{ color: C.textLo, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Currently Running</div>
            <div className="fg-display" style={{ color: C.textHi, fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{activeProgram.name}</div>
            {todayInfo.complete ? (
              <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, marginBottom: 14 }}>
                You've completed all {activeProgram.durationWeeks} weeks — nice work. Start it again or pick a new program.
              </div>
            ) : (
              <div className="fg-mono" style={{ color: C.textLo, fontSize: 13, marginBottom: 14 }}>
                Week {todayInfo.week} of {activeProgram.durationWeeks} · Today: {todayInfo.dayDef?.type === "rest" || !todayInfo.dayDef ? "Rest Day" : todayInfo.dayDef.label}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              {!todayInfo.complete && todayInfo.dayDef && todayInfo.dayDef.type === "workout" && (
                <button
                  onClick={() => onStartTodayWorkout(todayInfo.dayDef)}
                  className="fg-display"
                  style={{ flex: 1, background: activeProgram.color, border: "none", borderRadius: 10, padding: "12px", color: "white", fontWeight: 700, fontSize: 14 }}
                >
                  Start Today's Workout
                </button>
              )}
              {confirmingCancel ? (
                <>
                  <button onClick={() => setConfirmingCancel(false)} className="fg-display" style={{ flex: 1, background: "transparent", border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px", color: C.textLo, fontWeight: 600, fontSize: 13 }}>Cancel</button>
                  <button onClick={() => { onCancelProgram(); setConfirmingCancel(false); }} className="fg-display" style={{ flex: 1, background: "#EF4444", border: "none", borderRadius: 10, padding: "12px", color: "white", fontWeight: 700, fontSize: 13 }}>Confirm End</button>
                </>
              ) : (
                <button onClick={() => setConfirmingCancel(true)} className="fg-display" style={{ background: "transparent", border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px", color: C.textLo, fontWeight: 600, fontSize: 13 }}>
                  End Program
                </button>
              )}
            </div>
          </div>
        )}

        <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 12 }}>
          {activeProgram ? "Other Programs" : "Choose a Program"}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {PROGRAMS.filter((p) => p.id !== activeProgram?.id).map((p) => (
            <div
              key={p.id}
              onClick={() => setViewing(p)}
              style={{ background: C.bgCard, border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, cursor: "pointer" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                <div className="fg-display" style={{ color: C.textHi, fontSize: 18, fontWeight: 700 }}>{p.name}</div>
                <ChevronRight size={16} color={C.textLo} />
              </div>
              <div className="fg-mono" style={{ color: C.textLo, fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>{p.description}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <Chip label={p.goal} active color={p.color} />
                <Chip label={`${p.durationWeeks} weeks`} active color={C.textLo} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


function AppLoadingScreen() {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <FontImport />
      <div className="fg-display" style={{ color: C.textHi, fontSize: 32, fontWeight: 800, letterSpacing: "0.02em" }}>FORGE</div>
    </div>
  );
}

export default function App() {
  const [authSession, setAuthSession] = useState(null); // {access_token, refresh_token, expires_at, user:{id,email,name}}
  const [view, setView] = useState("home"); // home | builder | active | freestyle | history | social | squad
  const [session, setSession] = useState({ buildList: [], burnoutList: [], config: { mode: "Timer", work: 40, rest: 20, rounds: 3, targetReps: 12, rotationMode: "Exercise-First", circuitTransition: 10 }, squadInfo: null });
  const [history, setHistory] = useState([]);
  const [templates, setTemplates] = useState(PRESET_TEMPLATES);
  const [pendingTemplate, setPendingTemplate] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [cloudError, setCloudError] = useState("");
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [activeProgramRow, setActiveProgramRow] = useState(null);
  const [avatarUrl, setAvatarUrl] = useState(null);

  const user = authSession ? { id: authSession.user.id, name: authSession.user.name || authSession.user.email.split("@")[0], email: authSession.user.email, avatarUrl } : null;

  // squad rotation state — lifted to App so it keeps ticking even while
  // you're inside your own Active Workout screen (see squadInfo below).
  // Starts genuinely empty for a fresh account — no pre-filled fake
  // friends or exercises; "You" is the only real member until people
  // are actually invited in.
  const [squadSequence, setSquadSequence] = useState([]);
  const [squadBurnout, setSquadBurnout] = useState([]);
  const [squadConfig, setSquadConfig] = useState({ mode: "Timer", work: 40, rest: 20, rounds: 1, targetReps: 10, rotationMode: "Exercise-First", circuitTransition: 10 });
  const [squadMembers, setSquadMembers] = useState([
    { id: "me", name: "You", isMe: true, color: [C.blue, C.accent], online: true, startIndex: 0, currentIndex: 0, completedCount: 0, streak: 0 },
  ]);

  // background tick: other squad members quietly progress through their rotation
  useEffect(() => {
    const t = setInterval(() => {
      const n = squadSequence.length;
      if (n === 0) return;
      setSquadMembers((ms) =>
        ms.map((m) =>
          !m.isMe && m.online && Math.random() < 0.2
            ? { ...m, currentIndex: (m.currentIndex + 1) % n, completedCount: m.completedCount + 1 }
            : m
        )
      );
    }, 5000);
    return () => clearInterval(t);
  }, [squadSequence.length]);

  // keep the squad roster's "you" entry showing your real photo, once it loads
  useEffect(() => {
    setSquadMembers((ms) => ms.map((m) => (m.isMe ? { ...m, avatarUrl } : m)));
  }, [avatarUrl]);

  // On mount: try to restore a real Supabase session (refreshing the token if
  // it's stale). If that succeeds, pull real History + Templates from the cloud.
  useEffect(() => {
    (async () => {
      const stored = await storageGet("auth-session");
      if (stored) {
        const token = await getValidToken(stored, setAuthSession);
        if (token) {
          setAuthSession((s) => s || stored);
          try {
            const [cloudHistory, cloudTemplates, profileExtras, program] = await Promise.all([
              fetchCloudHistory(token),
              fetchCloudTemplates(token),
              fetchProfileExtras(token, stored.user.id),
              fetchActiveProgram(token),
            ]);
            setHistory(cloudHistory);
            setTemplates([...PRESET_TEMPLATES, ...cloudTemplates]);
            setNeedsOnboarding(!profileExtras.has_onboarded);
            setAvatarUrl(profileExtras.avatar_url || null);
            setActiveProgramRow(program);
          } catch (e) {
            setCloudError("Couldn't reach the server — showing what's cached locally.");
          }
        }
      }
      setHydrated(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist the session itself locally so a refresh doesn't force re-login
  useEffect(() => { if (hydrated) storageSet("auth-session", authSession); }, [authSession, hydrated]);

  // whenever someone signs in fresh (not from the mount-restore path), pull their cloud data
  const handleAuthed = async (newSession) => {
    setAuthSession(newSession);
    try {
      const [cloudHistory, cloudTemplates, profileExtras, program] = await Promise.all([
        fetchCloudHistory(newSession.access_token),
        fetchCloudTemplates(newSession.access_token),
        fetchProfileExtras(newSession.access_token, newSession.user.id),
        fetchActiveProgram(newSession.access_token),
      ]);
      setHistory(cloudHistory);
      setTemplates([...PRESET_TEMPLATES, ...cloudTemplates]);
      setNeedsOnboarding(!profileExtras.has_onboarded);
      setAvatarUrl(profileExtras.avatar_url || null);
      setActiveProgramRow(program);
    } catch (e) {
      setCloudError("Signed in, but couldn't load your data from the server yet.");
    }
  };

  const signOut = () => {
    setAuthSession(null);
    setHistory([]);
    setTemplates(PRESET_TEMPLATES);
    setNeedsOnboarding(false);
    setActiveProgramRow(null);
    setAvatarUrl(null);
    setView("home");
  };

  const changeAvatar = async (file) => {
    try {
      const token = await getValidToken(authSession, setAuthSession);
      if (!token) throw new Error("Not signed in");
      const url = await uploadAvatar(token, authSession.user.id, file);
      await updateProfileAvatar(token, authSession.user.id, url);
      setAvatarUrl(url);
    } catch (e) {
      setCloudError("Couldn't upload that photo — try a smaller image or check your connection.");
    }
  };

  const finishOnboarding = () => {
    setNeedsOnboarding(false);
    if (authSession) markOnboarded(authSession.access_token, authSession.user.id).catch(() => {});
  };

  const saveSession = async (record) => {
    setHistory((h) => [record, ...h]); // optimistic — show it immediately
    try {
      const token = await getValidToken(authSession, setAuthSession);
      if (!token) throw new Error("Not signed in");
      const saved = await insertCloudSession(token, authSession.user.id, record);
      setHistory((h) => [saved, ...h.filter((r) => r !== record)]);
    } catch (e) {
      setCloudError("Saved locally, but couldn't sync to the server.");
    }
  };

  const updateSet = async (sessionId, setId, patch) => {
    setHistory((h) => h.map((s) => (s.id === sessionId ? { ...s, sets: s.sets.map((st) => (st.id === setId ? { ...st, ...patch } : st)) } : s)));
    try {
      const token = await getValidToken(authSession, setAuthSession);
      if (!token) throw new Error("Not signed in");
      await updateCloudSet(token, setId, patch);
    } catch (e) {
      setCloudError("Updated locally, but couldn't sync to the server.");
    }
  };

  const deleteSet = async (sessionId, setId) => {
    setHistory((h) => h.map((s) => (s.id === sessionId ? { ...s, sets: s.sets.filter((st) => st.id !== setId) } : s)));
    try {
      const token = await getValidToken(authSession, setAuthSession);
      if (!token) throw new Error("Not signed in");
      await deleteCloudSet(token, setId);
    } catch (e) {
      setCloudError("Deleted locally, but couldn't sync to the server.");
    }
  };

  const deleteSession = async (sessionId) => {
    setHistory((h) => h.filter((s) => s.id !== sessionId));
    try {
      const token = await getValidToken(authSession, setAuthSession);
      if (!token) throw new Error("Not signed in");
      await deleteCloudSession(token, sessionId);
    } catch (e) {
      setCloudError("Deleted locally, but couldn't sync to the server.");
    }
  };

  const saveTemplate = async (tpl) => {
    setTemplates((t) => [...t, tpl]); // optimistic
    try {
      const token = await getValidToken(authSession, setAuthSession);
      if (!token) throw new Error("Not signed in");
      const saved = await insertCloudTemplate(token, authSession.user.id, tpl);
      setTemplates((t) => [...t.filter((x) => x !== tpl), saved]);
    } catch (e) {
      setCloudError("Saved locally, but couldn't sync to the server.");
    }
  };

  const loadTemplate = (tpl) => {
    setPendingTemplate(instantiateTemplate(tpl));
    setView("builder");
  };

  const startProgram = async (programId) => {
    const optimisticRow = { program_id: programId, started_at: new Date().toISOString() };
    setActiveProgramRow(optimisticRow); // optimistic
    try {
      const token = await getValidToken(authSession, setAuthSession);
      if (!token) throw new Error("Not signed in");
      const saved = await startCloudProgram(token, authSession.user.id, programId);
      setActiveProgramRow(saved);
    } catch (e) {
      setCloudError("Started locally, but couldn't sync to the server.");
    }
  };

  const cancelProgram = async () => {
    setActiveProgramRow(null); // optimistic
    try {
      const token = await getValidToken(authSession, setAuthSession);
      if (!token) throw new Error("Not signed in");
      await cancelCloudProgram(token, authSession.user.id);
    } catch (e) {
      setCloudError("Ended locally, but couldn't sync to the server.");
    }
  };

  const startTodayWorkout = (dayDef) => {
    setPendingTemplate(instantiateTemplate({ config: dayDef.config, buildItems: dayDef.buildItems, burnoutItems: dayDef.burnoutItems || [] }));
    setView("builder");
  };

  const startBuilderEmpty = () => {
    setPendingTemplate(null);
    setView("builder");
  };

  const squadAddToBuild = (ex) =>
    setSquadSequence((l) => {
      const idx = l.findIndex((b) => b.id === ex.id);
      if (idx >= 0) return normalizeSupersetGroups(l.filter((_, i) => i !== idx));
      return [...l, { ...ex, uid: nextUid(), modeOverride: "Session Default", addedBy: "You" }];
    });
  const squadAddToBurnout = (ex) =>
    setSquadBurnout((l) => {
      const idx = l.findIndex((b) => b.id === ex.id);
      if (idx >= 0) return l.filter((_, i) => i !== idx);
      return [...l, { ...ex, uid: nextUid(), addedBy: "You" }];
    });

  const squadAutoAssignStarts = () => {
    const n = squadSequence.length;
    if (n === 0) return;
    setSquadMembers((ms) =>
      ms.map((m, i) => {
        const start = Math.floor((i * n) / ms.length);
        return { ...m, startIndex: start, currentIndex: start, completedCount: 0 };
      })
    );
  };

  const squadAssignStart = (memberId, stationIndex) =>
    setSquadMembers((ms) => ms.map((m) => (m.id === memberId ? { ...m, startIndex: stationIndex, currentIndex: stationIndex, completedCount: 0 } : m)));

  const squadAdvanceMe = () => {
    const n = squadSequence.length;
    if (n === 0) return;
    setSquadMembers((ms) => ms.map((m) => (m.isMe ? { ...m, currentIndex: (m.currentIndex + 1) % n, completedCount: m.completedCount + 1 } : m)));
  };

  const squadResetRotation = () => {
    setSquadMembers((ms) => ms.map((m) => ({ ...m, currentIndex: m.startIndex, completedCount: 0 })));
  };

  const startSquadWorkout = () => {
    const n = squadSequence.length;
    if (n === 0) return;
    const me = squadMembers.find((m) => m.isMe);
    const startAt = me ? me.currentIndex : 0;
    const rotated = [...squadSequence.slice(startAt), ...squadSequence.slice(0, startAt)].map((item) => ({ ...item, uid: nextUid() }));
    const burnout = squadBurnout.map((item) => ({ ...item, uid: nextUid() }));
    setSession({
      buildList: rotated,
      burnoutList: burnout,
      config: squadConfig,
      squadInfo: { sequence: squadSequence, members: squadMembers },
    });
    setView("active");
  };

  if (!hydrated) return <AppLoadingScreen />;

  if (!user) return <AuthScreen onAuthed={handleAuthed} />;

  if (needsOnboarding) return <OnboardingTutorialScreen onDone={finishOnboarding} />;

  let screen;

  if (view === "squad") {
    screen = (
      <SquadSessionScreen
        onBack={() => setView("social")}
        squadSequence={squadSequence}
        squadBurnout={squadBurnout}
        setSquadBurnout={setSquadBurnout}
        setSquadSequence={setSquadSequence}
        squadConfig={squadConfig}
        setSquadConfig={setSquadConfig}
        squadMembers={squadMembers}
        onAddToBuild={squadAddToBuild}
        onAddToBurnout={squadAddToBurnout}
        onAutoAssignStarts={squadAutoAssignStarts}
        onAssignStart={squadAssignStart}
        onAdvanceMe={squadAdvanceMe}
        onResetRotation={squadResetRotation}
        onStartSquadWorkout={startSquadWorkout}
        onSaveTemplate={saveTemplate}
      />
    );
  } else if (view === "programs") {
    screen = (
      <ProgramsScreen
        activeProgramRow={activeProgramRow}
        onBack={() => setView("home")}
        onStartProgram={startProgram}
        onCancelProgram={cancelProgram}
        onStartTodayWorkout={startTodayWorkout}
      />
    );
  } else if (view === "social") {
    screen = (
      <SocialScreen
        user={user}
        history={history}
        onBack={() => setView("home")}
        onSignOut={signOut}
        onStartSquad={() => setView("squad")}
        onChangeAvatar={changeAvatar}
      />
    );
  } else if (view === "history") {
    screen = (
      <HistoryScreen
        liveHistory={history}
        onBack={() => setView("home")}
        onSaveSession={saveSession}
        onUpdateSet={updateSet}
        onDeleteSet={deleteSet}
        onDeleteSession={deleteSession}
      />
    );
  } else if (view === "freestyle") {
    screen = <FreestyleSessionScreen onExit={() => setView("home")} onSaveSession={saveSession} />;
  } else if (view === "active") {
    screen = (
      <ActiveWorkoutScreen
        buildList={session.buildList}
        burnoutList={session.burnoutList}
        config={session.config}
        squadInfo={session.squadInfo}
        onExit={() => setView("home")}
        onSaveSession={saveSession}
      />
    );
  } else if (view === "builder") {
    screen = (
      <LibraryBuilderScreen
        onBack={() => setView("home")}
        initialSession={pendingTemplate}
        onSaveTemplate={saveTemplate}
        onStartWorkout={(s) => {
          setSession(s);
          setView("active");
        }}
      />
    );
  } else {
    screen = (
      <HomeScreen
        user={user}
        history={history}
        templates={templates}
        squadMembers={squadMembers}
        activeProgramRow={activeProgramRow}
        onStartBuild={startBuilderEmpty}
        onLoadTemplate={loadTemplate}
        onStartFreestyle={() => setView("freestyle")}
        onOpenHistory={() => setView("history")}
        onOpenSocial={() => setView("social")}
        onOpenPrograms={() => setView("programs")}
        onStartTodayWorkout={startTodayWorkout}
      />
    );
  }

  return (
    <>
      <div key={view} className="fg-screen-in">
        {screen}
      </div>
      {cloudError && (
        <div
          style={{
            position: "fixed", bottom: 16, left: 16, right: 16, zIndex: 200,
            background: "#7C2D12", border: "1px solid #F97316", borderRadius: 10,
            padding: "12px 14px", display: "flex", alignItems: "center", gap: 10,
            fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#FED7AA",
          }}
        >
          <span style={{ flex: 1 }}>{cloudError}</span>
          <button onClick={() => setCloudError("")} style={{ background: "none", border: "none", color: "#FED7AA" }}>✕</button>
        </div>
      )}
    </>
  );
}
