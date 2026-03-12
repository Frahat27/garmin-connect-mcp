import { createServer, IncomingMessage } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { GarminClient } from './client';
import {
  fetchGarminData, buildUserMessage, buildReviewMessage, buildChatSystemPrompt,
  COACH_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT,
  HISTORY_ANALYSIS_SYSTEM_PROMPT, MACRO_PLAN_SYSTEM_PROMPT,
  buildHistoryAnalysisMessage, buildMacroPlanMessage,
  generateHistoryContext, historyExists, historyFilePath,
  loadPlan, savePlan, deletePlan, getPlanStatus,
} from './coach/index';
import type { AthleteProfile, DailyCheckin } from './coach/index';

const PORT = parseInt(process.env.PORT ?? '3005');
const DATA_DIR = process.env.PROFILE_DIR ?? join(homedir(), '.garmin-mcp');
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
const __dir = dirname(fileURLToPath(import.meta.url));

type Session = {
  token: string;
  email: string;
  password: string;
  anthropicKey: string;
  lastSeen: number;
};

const sessions = new Map<string, Session>();

function loadSessions(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as Session[];
      const now = Date.now();
      const thirtyDays = 30 * 24 * 3600 * 1000;
      for (const s of data) {
        if (now - s.lastSeen < thirtyDays) sessions.set(s.token, s);
      }
    }
  } catch {}
}

function saveSessions(): void {
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.values()], null, 2));
  } catch {}
}

function getUserDir(email: string): string {
  const safe = email.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = join(DATA_DIR, 'users', safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getSession(req: IncomingMessage): Session | null {
  const token = req.headers['x-session-token'] as string | undefined;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  session.lastSeen = Date.now();
  return session;
}

function loadProfile(uDir: string): AthleteProfile | null {
  try {
    const path = join(uDir, 'athlete-profile.json');
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as AthleteProfile;
  } catch {}
  return null;
}

function saveProfile(uDir: string, profile: AthleteProfile): void {
  writeFileSync(join(uDir, 'athlete-profile.json'), JSON.stringify(profile, null, 2), 'utf-8');
}

function saveChatHistory(uDir: string, messages: Array<{ role: string; content: string }>): void {
  try {
    writeFileSync(join(uDir, 'chat-history.json'), JSON.stringify(messages, null, 2), 'utf-8');
  } catch {}
}

function loadChatHistory(uDir: string): Array<{ role: string; content: string }> {
  try {
    const path = join(uDir, 'chat-history.json');
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {}
  return [];
}

function saveTextData(uDir: string, filename: string, text: string): void {
  try { writeFileSync(join(uDir, filename), text, 'utf-8'); } catch {}
}

function loadTextData(uDir: string, filename: string): string | null {
  try {
    const path = join(uDir, filename);
    if (existsSync(path)) return readFileSync(path, 'utf-8');
  } catch {}
  return null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function getHistoryContext(uDir: string, email: string): Promise<string | undefined> {
  try {
    if (historyExists(uDir, email)) {
      return readFileSync(historyFilePath(uDir, email), 'utf-8');
    }
  } catch {}
  return undefined;
}

loadSessions();

const HTML = readFileSync(join(__dir, 'public/index.html'), 'utf-8');

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(HTML);
    return;
  }

  if (method === 'POST' && url === '/api/auth/login') {
    const { email, password, anthropicKey } = JSON.parse(await readBody(req)) as {
      email: string; password: string; anthropicKey: string;
    };
    if (!email || !password || !anthropicKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Completá los tres campos.' }));
      return;
    }
    try {
      const uDir = getUserDir(email);
      const { unlinkSync: unlink } = await import('fs');
      for (const f of ['oauth1_token.json', 'oauth2_token.json', 'profile.json']) {
        try { unlink(join(uDir, f)); } catch {}
      }
      try { unlink(historyFilePath(uDir, email)); } catch {}
      const testClient = new GarminClient(email, password, undefined, uDir);
      await testClient.getLastActivity();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAuth = /401|unauthorized|credentials|password|login|invalid/i.test(msg);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: isAuth ? 'Usuario o contraseña incorrectos.' : `Error al conectar con Garmin: ${msg}` }));
      return;
    }
    const existing = [...sessions.values()].find(s => s.email === email);
    const token = existing?.token ?? randomUUID();
    const session: Session = { token, email, password, anthropicKey, lastSeen: Date.now() };
    sessions.set(token, session);
    saveSessions();
    getUserDir(email);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token, email }));
    return;
  }

  if (method === 'POST' && url === '/api/auth/logout') {
    const session = getSession(req);
    if (session) { sessions.delete(session.token); saveSessions(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'GET' && url === '/api/session') {
    const session = getSession(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ valid: !!session, email: session?.email ?? null }));
    return;
  }

  if (method === 'GET' && url === '/api/history-status') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const uDir = getUserDir(session.email);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ exists: historyExists(uDir, session.email) }));
    return;
  }

  if (method === 'GET' && url === '/api/plan-status') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const uDir = getUserDir(session.email);
    const today = new Date().toISOString().split('T')[0];
    const plan = loadPlan(uDir, session.email);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPlanStatus(plan, today)));
    return;
  }

  if (method === 'DELETE' && url === '/api/plan') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    deletePlan(getUserDir(session.email), session.email);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'POST' && url === '/api/save-plan') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const planData = JSON.parse(await readBody(req)) as Record<string, unknown>;
    savePlan(getUserDir(session.email), session.email, planData);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'GET' && url === '/api/saved-plan') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const plan = loadPlan(getUserDir(session.email), session.email);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(plan));
    return;
  }

  if (method === 'GET' && url === '/api/profile') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadProfile(getUserDir(session.email))));
    return;
  }

  if (method === 'GET' && url === '/api/chat-history') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadChatHistory(getUserDir(session.email))));
    return;
  }

  if (method === 'DELETE' && url === '/api/chat-history') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    try {
      const { unlinkSync } = await import('fs');
      const path = join(getUserDir(session.email), 'chat-history.json');
      if (existsSync(path)) unlinkSync(path);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'POST' && url === '/api/map-history') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const send = (type: string, data: Record<string, unknown> = {}): void => {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };
    try {
      const session = getSession(req);
      if (!session) { send('error', { message: 'Sin sesión activa.' }); res.end(); return; }
      const uDir = getUserDir(session.email);
      if (historyExists(uDir, session.email)) { send('done', { existed: true }); res.end(); return; }
      await generateHistoryContext(
        new GarminClient(session.email, session.password, undefined, getUserDir(session.email)),
        uDir,
        session.email,
        (msg) => send('status', { message: msg }),
      );
      send('done', { existed: false });
    } catch (e) {
      send('error', { message: e instanceof Error ? e.message : String(e) });
    }
    res.end();
    return;
  }

  if (method === 'GET' && url === '/api/historical-analysis') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const text = loadTextData(getUserDir(session.email), 'historical-analysis.txt');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text }));
    return;
  }

  if (method === 'GET' && url === '/api/macro-plan-text') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const text = loadTextData(getUserDir(session.email), 'macro-plan.txt');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text }));
    return;
  }

  if (method === 'GET' && url === '/api/plan-vs-real-text') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const text = loadTextData(getUserDir(session.email), 'plan-vs-real.txt');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text }));
    return;
  }

  const makeSSE = (): (type: string, data?: Record<string, unknown>) => void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    return (type, data = {}) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  if (method === 'POST' && url === '/api/analyze') {
    const send = makeSSE();
    try {
      const session = getSession(req);
      if (!session) { send('error', { message: 'Sin sesión activa.' }); res.end(); return; }
      const uDir = getUserDir(session.email);

      const { profile, checkin } = JSON.parse(await readBody(req)) as { profile: AthleteProfile; checkin: DailyCheckin };
      saveProfile(uDir, { ...profile, savedAt: new Date().toISOString() });

      send('status', { message: 'Conectando a Garmin Connect...' });
      const garminData = await fetchGarminData(new GarminClient(session.email, session.password, undefined, getUserDir(session.email)));
      send('status', { message: `✅ ${garminData.activities.length} actividades cargadas. Generando plan...` });

      const stream = new Anthropic({ apiKey: session.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        system: COACH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(profile, checkin, garminData, await getHistoryContext(uDir, session.email)) }],
      });

      stream.on('text', (text: string) => send('text', { content: text }));
      await stream.finalMessage();
      send('done');
    } catch (e) {
      send('error', { message: e instanceof Error ? e.message : String(e) });
    }
    res.end();
    return;
  }

  if (method === 'POST' && url === '/api/review') {
    const send = makeSSE();
    try {
      const session = getSession(req);
      if (!session) { send('error', { message: 'Sin sesión activa.' }); res.end(); return; }
      const uDir = getUserDir(session.email);
      const currentPlan = loadPlan(uDir, session.email);
      if (!currentPlan) {
        send('error', { message: 'No hay plan activo. Generá uno con Analizar primero.' });
        res.end(); return;
      }

      const { profile, checkin } = JSON.parse(await readBody(req)) as { profile: AthleteProfile; checkin: DailyCheckin };

      send('status', { message: 'Conectando a Garmin Connect...' });
      const garminData = await fetchGarminData(new GarminClient(session.email, session.password, undefined, getUserDir(session.email)));
      send('status', { message: `✅ ${garminData.activities.length} actividades cargadas. Cruzando plan vs real...` });

      const stream = new Anthropic({ apiKey: session.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        system: REVIEW_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildReviewMessage(profile, checkin, garminData, currentPlan, await getHistoryContext(uDir, session.email)) }],
      });

      let fullText = '';
      stream.on('text', (text: string) => { fullText += text; send('text', { content: text }); });
      await stream.finalMessage();

      const rm = fullText.match(/\[REVIEW_JSON\]([\s\S]*?)\[\/REVIEW_JSON\]/);
      if (rm) {
        let raw = rm[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        const s = raw.indexOf('{'); if (s > 0) raw = raw.slice(s);
        try {
          const rj = JSON.parse(raw) as Record<string, unknown>;
          savePlan(uDir, session.email, rj);
          saveTextData(uDir, 'plan-vs-real.txt', fullText);
          send('plan_update', { plan: rj });
        } catch {}
      }
      send('done');
    } catch (e) {
      send('error', { message: e instanceof Error ? e.message : String(e) });
    }
    res.end();
    return;
  }

  if (method === 'POST' && url === '/api/analyze-history') {
    const send = makeSSE();
    try {
      const session = getSession(req);
      if (!session) { send('error', { message: 'Sin sesión activa.' }); res.end(); return; }
      const uDir = getUserDir(session.email);
      const { profile } = JSON.parse(await readBody(req)) as { profile: AthleteProfile };

      send('status', { message: 'Conectando a Garmin Connect...' });
      const garminData = await fetchGarminData(new GarminClient(session.email, session.password, undefined, getUserDir(session.email)));
      send('status', { message: `✅ ${garminData.activities.length} actividades cargadas. Analizando historial...` });

      const stream = new Anthropic({ apiKey: session.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        system: HISTORY_ANALYSIS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildHistoryAnalysisMessage(profile, garminData, await getHistoryContext(uDir, session.email)) }],
      });

      let fullText = '';
      stream.on('text', (text: string) => { fullText += text; send('text', { content: text }); });
      await stream.finalMessage();
      saveTextData(uDir, 'historical-analysis.txt', fullText);
      send('done');
    } catch (e) {
      send('error', { message: e instanceof Error ? e.message : String(e) });
    }
    res.end();
    return;
  }

  if (method === 'POST' && url === '/api/generate-macro-plan') {
    const send = makeSSE();
    try {
      const session = getSession(req);
      if (!session) { send('error', { message: 'Sin sesión activa.' }); res.end(); return; }
      const uDir = getUserDir(session.email);
      const { profile } = JSON.parse(await readBody(req)) as { profile: AthleteProfile };

      send('status', { message: 'Conectando a Garmin Connect...' });
      const garminData = await fetchGarminData(new GarminClient(session.email, session.password, undefined, getUserDir(session.email)));
      send('status', { message: `✅ ${garminData.activities.length} actividades cargadas. Generando Plan Macro...` });

      const stream = new Anthropic({ apiKey: session.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        system: MACRO_PLAN_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildMacroPlanMessage(profile, garminData, await getHistoryContext(uDir, session.email)) }],
      });

      let fullText = '';
      stream.on('text', (text: string) => { fullText += text; send('text', { content: text }); });
      await stream.finalMessage();
      saveTextData(uDir, 'macro-plan.txt', fullText);
      send('done');
    } catch (e) {
      send('error', { message: e instanceof Error ? e.message : String(e) });
    }
    res.end();
    return;
  }

  if (method === 'POST' && url === '/api/chat') {
    const send = makeSSE();
    try {
      const session = getSession(req);
      if (!session) { send('error', { message: 'Sin sesión activa.' }); res.end(); return; }
      const uDir = getUserDir(session.email);

      const { messages, profile, checkin } = JSON.parse(await readBody(req)) as {
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        profile: AthleteProfile;
        checkin: DailyCheckin;
      };

      const today = new Date().toISOString().split('T')[0];
      const currentPlan = loadPlan(uDir, session.email);
      const systemPrompt = buildChatSystemPrompt(profile, checkin, currentPlan, today);

      const stream = new Anthropic({ apiKey: session.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 8192,
        system: systemPrompt,
        messages,
      });

      let fullText = '';
      stream.on('text', (text: string) => { fullText += text; send('text', { content: text }); });
      await stream.finalMessage();

      const pm = fullText.match(/\[PLAN_JSON\]([\s\S]*?)\[\/PLAN_JSON\]/);
      if (pm) {
        let raw = pm[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        const s = raw.indexOf('{'); if (s > 0) raw = raw.slice(s);
        try {
          const pj = JSON.parse(raw) as Record<string, unknown>;
          savePlan(uDir, session.email, pj);
          send('plan_update', { plan: pj });
        } catch {}
      }

      saveChatHistory(uDir, [...messages, { role: 'assistant', content: fullText }]);
      send('done');
    } catch (e) {
      send('error', { message: e instanceof Error ? e.message : String(e) });
    }
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.error(`\n  🏃 Garmin Coach corriendo en http://localhost:${PORT}\n`);
});
