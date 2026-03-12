import { createServer, IncomingMessage } from 'http';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { GarminClient } from './client';
import {
  fetchGarminData, buildUserMessage, buildReviewMessage, buildChatSystemPrompt,
  COACH_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT,
  HISTORY_ANALYSIS_SYSTEM_PROMPT, MACRO_PLAN_SYSTEM_PROMPT,
  buildHistoryAnalysisMessage, buildMacroPlanMessage,
  generateHistoryContext, getPlanStatus,
} from './coach/index';
import type { AthleteProfile, DailyCheckin } from './coach/index';
import {
  initDb, loadAllSessions, upsertSession, touchSession, clearSession,
  dbGetProfile, dbSaveProfile,
  dbGetPlan, dbSavePlan, dbDeletePlan,
  dbGetChatHistory, dbSaveChatHistory, dbDeleteChatHistory,
  dbHistoryExists, dbGetHistoryCache, dbSaveHistoryCache,
  dbGetAnalysis, dbSaveAnalysis,
  populateTokenDir, saveTokensFromDir,
} from './db';
import type { DbSession } from './db';

const PORT = parseInt(process.env.PORT ?? '3005');
const __dir = dirname(fileURLToPath(import.meta.url));

const sessions = new Map<string, DbSession>();

function getTokenDir(userId: string): string {
  return join(tmpdir(), `garmin-tokens-${userId}`);
}

function getSession(req: IncomingMessage): DbSession | null {
  const token = req.headers['x-session-token'] as string | undefined;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  touchSession(session.userId).catch(() => {});
  return session;
}

async function withGarmin<T>(
  session: DbSession,
  fn: (client: GarminClient) => Promise<T>,
): Promise<T> {
  const tDir = getTokenDir(session.userId);
  await populateTokenDir(session.userId, tDir);
  const client = new GarminClient(session.email, session.password, undefined, tDir);
  try {
    return await fn(client);
  } finally {
    await saveTokensFromDir(session.userId, tDir).catch(() => {});
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

await initDb();
for (const s of await loadAllSessions()) {
  sessions.set(s.token, s);
}
console.error(`[server] ${sessions.size} sesiones activas cargadas desde DB`);

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
      const tDir = join(tmpdir(), `garmin-login-${Date.now()}`);
      const testClient = new GarminClient(email, password, undefined, tDir);
      await testClient.getLastActivity();
      const session = await upsertSession(email, password, anthropicKey);
      sessions.set(session.token, session);
      await saveTokensFromDir(session.userId, tDir).catch(() => {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: session.token, email }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isAuth = /401|unauthorized|credentials|password|login|invalid/i.test(msg);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: isAuth ? 'Usuario o contraseña incorrectos.' : `Error al conectar con Garmin: ${msg}` }));
    }
    return;
  }

  if (method === 'POST' && url === '/api/auth/logout') {
    const session = getSession(req);
    if (session) {
      sessions.delete(session.token);
      await clearSession(session.userId).catch(() => {});
    }
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
    const exists = await dbHistoryExists(session.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ exists }));
    return;
  }

  if (method === 'GET' && url === '/api/plan-status') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const today = new Date().toISOString().split('T')[0];
    const plan = await dbGetPlan(session.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPlanStatus(plan, today)));
    return;
  }

  if (method === 'DELETE' && url === '/api/plan') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    await dbDeletePlan(session.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'POST' && url === '/api/save-plan') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const planData = JSON.parse(await readBody(req)) as Record<string, unknown>;
    await dbSavePlan(session.userId, planData);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'GET' && url === '/api/saved-plan') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const plan = await dbGetPlan(session.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(plan));
    return;
  }

  if (method === 'GET' && url === '/api/profile') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await dbGetProfile(session.userId)));
    return;
  }

  if (method === 'POST' && url === '/api/profile') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const profile = JSON.parse(await readBody(req)) as AthleteProfile;
    await dbSaveProfile(session.userId, { ...profile, savedAt: new Date().toISOString() } as AthleteProfile);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (method === 'GET' && url === '/api/chat-history') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await dbGetChatHistory(session.userId)));
    return;
  }

  if (method === 'DELETE' && url === '/api/chat-history') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    await dbDeleteChatHistory(session.userId);
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
      if (await dbHistoryExists(session.userId)) { send('done', { existed: true }); res.end(); return; }
      const context = await withGarmin(session, (client) =>
        generateHistoryContext(client, (msg) => send('status', { message: msg })),
      );
      await dbSaveHistoryCache(session.userId, context);
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
    const text = await dbGetAnalysis(session.userId, 'historical');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text }));
    return;
  }

  if (method === 'GET' && url === '/api/macro-plan-text') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const text = await dbGetAnalysis(session.userId, 'macro');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text }));
    return;
  }

  if (method === 'GET' && url === '/api/plan-vs-real-text') {
    const session = getSession(req);
    if (!session) { res.writeHead(401); res.end(); return; }
    const text = await dbGetAnalysis(session.userId, 'plan_vs_real');
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

      const { profile, checkin } = JSON.parse(await readBody(req)) as { profile: AthleteProfile; checkin: DailyCheckin };
      await dbSaveProfile(session.userId, { ...profile, savedAt: new Date().toISOString() } as AthleteProfile);

      send('status', { message: 'Conectando a Garmin Connect...' });
      const garminData = await withGarmin(session, (client) => fetchGarminData(client));
      send('status', { message: `✅ ${garminData.activities.length} actividades cargadas. Generando plan...` });

      const historyContext = await dbGetHistoryCache(session.userId) ?? undefined;
      const stream = new Anthropic({ apiKey: session.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        system: COACH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(profile, checkin, garminData, historyContext) }],
      });

      let fullText = '';
      stream.on('text', (text: string) => { fullText += text; send('text', { content: text }); });
      const finalMsg = await stream.finalMessage();

      const pm = fullText.match(/\[PLAN_JSON\]([\s\S]*?)\[\/PLAN_JSON\]/);
      if (pm) {
        let raw = pm[1].trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        const s = raw.indexOf('{'); if (s > 0) raw = raw.slice(s);
        try {
          const pj = JSON.parse(raw) as Record<string, unknown>;
          await dbSavePlan(session.userId, pj);
          send('plan_update', { plan: pj });
        } catch {}
      }

      console.error(`[analyze] input=${finalMsg.usage.input_tokens}tok output=${finalMsg.usage.output_tokens}tok`);
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
      const currentPlan = await dbGetPlan(session.userId);
      if (!currentPlan) {
        send('error', { message: 'No hay plan activo. Generá uno con Analizar primero.' });
        res.end(); return;
      }

      const { profile, checkin } = JSON.parse(await readBody(req)) as { profile: AthleteProfile; checkin: DailyCheckin };

      send('status', { message: 'Conectando a Garmin Connect...' });
      const garminData = await withGarmin(session, (client) => fetchGarminData(client));
      send('status', { message: `✅ ${garminData.activities.length} actividades cargadas. Cruzando plan vs real...` });

      const historyContext = await dbGetHistoryCache(session.userId) ?? undefined;
      const stream = new Anthropic({ apiKey: session.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        system: REVIEW_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildReviewMessage(profile, checkin, garminData, currentPlan, historyContext) }],
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
          await dbSavePlan(session.userId, rj);
          await dbSaveAnalysis(session.userId, 'plan_vs_real', fullText);
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
      const { profile } = JSON.parse(await readBody(req)) as { profile: AthleteProfile };

      send('status', { message: 'Conectando a Garmin Connect...' });
      const garminData = await withGarmin(session, (client) => fetchGarminData(client));
      send('status', { message: `✅ ${garminData.activities.length} actividades cargadas. Analizando historial...` });

      const historyContext = await dbGetHistoryCache(session.userId) ?? undefined;
      const stream = new Anthropic({ apiKey: session.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        system: HISTORY_ANALYSIS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildHistoryAnalysisMessage(profile, garminData, historyContext) }],
      });

      let fullText = '';
      stream.on('text', (text: string) => { fullText += text; send('text', { content: text }); });
      await stream.finalMessage();
      await dbSaveAnalysis(session.userId, 'historical', fullText);
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
      const { profile } = JSON.parse(await readBody(req)) as { profile: AthleteProfile };

      send('status', { message: 'Conectando a Garmin Connect...' });
      const garminData = await withGarmin(session, (client) => fetchGarminData(client));
      send('status', { message: `✅ ${garminData.activities.length} actividades cargadas. Generando Plan Macro...` });

      const historyContext = await dbGetHistoryCache(session.userId) ?? undefined;
      const stream = new Anthropic({ apiKey: session.anthropicKey }).messages.stream({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        system: MACRO_PLAN_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildMacroPlanMessage(profile, garminData, historyContext) }],
      });

      let fullText = '';
      stream.on('text', (text: string) => { fullText += text; send('text', { content: text }); });
      await stream.finalMessage();
      await dbSaveAnalysis(session.userId, 'macro', fullText);
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

      const { messages, profile, checkin } = JSON.parse(await readBody(req)) as {
        messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }>;
        profile: AthleteProfile;
        checkin: DailyCheckin;
      };

      const today = new Date().toISOString().split('T')[0];
      const currentPlan = await dbGetPlan(session.userId);
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
          await dbSavePlan(session.userId, pj);
          send('plan_update', { plan: pj });
        } catch {}
      }

      const historyToSave = [...messages, { role: 'assistant', content: fullText }].map(m => ({
        role: m.role,
        content: Array.isArray(m.content)
          ? (m.content as Array<{ type: string; text?: string }>)
              .filter(b => b.type !== 'image')
              .map(b => b.text ?? '').join(' ').trim() || '[imagen adjunta]'
          : String(m.content),
      }));
      await dbSaveChatHistory(session.userId, historyToSave);
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
