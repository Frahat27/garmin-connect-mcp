import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export type PlanSession = {
  deporte: string;
  emoji: string;
  titulo: string;
  duracion: string;
  intensidad: string;
  rpe: number;
  detalle: string;
};

export type PlanDay = {
  dia: string;
  fecha: string;
  descanso: boolean;
  sesiones: PlanSession[];
};

export type PlanWeek = {
  inicio: string;
  dias: PlanDay[];
};

export type StoredPlan = {
  savedAt: string;
  semana1: PlanWeek;
  semana2: PlanWeek;
};

export type PlanMode = 'planning' | 'review' | 'planning_with_review';

export type PlanStatus = {
  mode: PlanMode;
  daysRemaining: number | null;
  planEndDate: string | null;
  plan: StoredPlan | null;
};

function planFilePath(profileDir: string, email: string): string {
  const safe = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return join(profileDir, `${safe}-plan.json`);
}

export function loadPlan(profileDir: string, email: string): StoredPlan | null {
  try {
    const path = planFilePath(profileDir, email);
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf-8')) as StoredPlan;
  } catch {}
  return null;
}

export function savePlan(profileDir: string, email: string, plan: Record<string, unknown>): void {
  const data = { savedAt: new Date().toISOString(), ...plan };
  writeFileSync(planFilePath(profileDir, email), JSON.stringify(data, null, 2), 'utf-8');
}

export function deletePlan(profileDir: string, email: string): void {
  try {
    const { unlinkSync } = require('fs') as typeof import('fs');
    const path = planFilePath(profileDir, email);
    if (existsSync(path)) unlinkSync(path);
  } catch {}
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function diffDays(from: string, to: string): number {
  const a = new Date(from + 'T12:00:00Z');
  const b = new Date(to + 'T12:00:00Z');
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function getPlanStatus(plan: StoredPlan | null, today: string): PlanStatus {
  if (!plan?.semana2?.inicio) {
    return { mode: 'planning', daysRemaining: null, planEndDate: null, plan: null };
  }
  const planEndDate = addDays(plan.semana2.inicio, 6);
  const daysRemaining = diffDays(today, planEndDate) + 1;
  if (daysRemaining <= 0) {
    return { mode: 'planning', daysRemaining: 0, planEndDate, plan };
  }
  if (daysRemaining <= 3) {
    return { mode: 'planning_with_review', daysRemaining, planEndDate, plan };
  }
  return { mode: 'review', daysRemaining, planEndDate, plan };
}

export function planToContext(plan: StoredPlan): string {
  const lines: string[] = [];
  for (const key of ['semana1', 'semana2'] as const) {
    const week = plan[key];
    if (!week?.dias) continue;
    const wNum = key === 'semana1' ? 1 : 2;
    lines.push(`\n## Semana ${wNum} (inicio: ${week.inicio})`);
    for (const day of week.dias) {
      if (day.descanso || !day.sesiones?.length) {
        lines.push(`- ${day.dia} ${day.fecha}: Descanso`);
      } else {
        lines.push(`- ${day.dia} ${day.fecha}:`);
        for (const s of day.sesiones) {
          lines.push(`  * ${s.emoji} ${s.titulo} | ${s.duracion} | ${s.intensidad} | RPE ${s.rpe}`);
          lines.push(`    ${s.detalle}`);
        }
      }
    }
  }
  return lines.join('\n');
}
