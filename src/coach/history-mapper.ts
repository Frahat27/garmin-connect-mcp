import type { GarminClient } from '../client';

type SportStats = { count: number; totalKm: number; totalMin: number };
type YearData = {
  year: number;
  sports: Record<string, SportStats>;
  months: Record<string, Record<string, { km: number; min: number }>>;
};

function normType(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('running') || s === 'run') return 'running';
  if (s.includes('cycl') || s.includes('bike') || s.includes('biking')) return 'cycling';
  if (s.includes('swim')) return 'swimming';
  if (s.includes('strength') || s.includes('gym') || s.includes('weight_training') || s.includes('fitness_equipment')) return 'strength';
  if (s.includes('triathlon')) return 'triathlon';
  return 'other';
}

function toWeekStart(dateStr: string): string {
  const date = new Date(dateStr);
  const dow = date.getDay();
  const monday = new Date(date);
  monday.setDate(date.getDate() - (dow === 0 ? 6 : dow - 1));
  return monday.toISOString().split('T')[0];
}

export async function generateHistoryContext(
  client: GarminClient,
  onProgress: (msg: string) => void = () => {},
): Promise<string> {

  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setFullYear(now.getFullYear() - 4);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const allActivities: Record<string, unknown>[] = [];
  const pageSize = 100;
  let start = 0;
  let page = 1;

  onProgress(`Descargando historial de actividades (últimos 4 años)...`);

  while (true) {
    onProgress(`Página ${page} — ${allActivities.length} actividades procesadas...`);
    try {
      const batch = await (client.getActivities(start, pageSize) as Promise<Record<string, unknown>[]>);
      if (!Array.isArray(batch) || batch.length === 0) break;

      let hitCutoff = false;
      for (const a of batch) {
        const dr = String(a.startTimeLocal ?? a.beginTimestamp ?? '').split('T')[0];
        if (dr < cutoffStr) { hitCutoff = true; break; }
        allActivities.push(a);
      }
      if (hitCutoff || batch.length < pageSize) break;
      start += pageSize;
      page++;
      await new Promise(r => setTimeout(r, 300));
    } catch { break; }
  }

  onProgress(`Analizando ${allActivities.length} actividades...`);

  const byYear = new Map<number, YearData>();
  const weeklyBySport = new Map<string, Map<string, { km: number; min: number }>>();

  for (const raw of allActivities) {
    const dr = String(raw.startTimeLocal ?? '').split('T')[0];
    if (!dr || dr < cutoffStr) continue;

    const year = parseInt(dr.slice(0, 4));
    const month = dr.slice(0, 7);
    const typeObj = raw.activityType as Record<string, unknown> | undefined;
    const sport = normType(String(typeObj?.typeKey ?? 'other'));
    const km = typeof raw.distance === 'number' ? raw.distance / 1000 : 0;
    const min = typeof raw.duration === 'number' ? raw.duration / 60 : 0;

    if (!byYear.has(year)) byYear.set(year, { year, sports: {}, months: {} });
    const yd = byYear.get(year)!;
    if (!yd.sports[sport]) yd.sports[sport] = { count: 0, totalKm: 0, totalMin: 0 };
    yd.sports[sport].count++;
    yd.sports[sport].totalKm += km;
    yd.sports[sport].totalMin += min;
    if (!yd.months[month]) yd.months[month] = {};
    if (!yd.months[month][sport]) yd.months[month][sport] = { km: 0, min: 0 };
    yd.months[month][sport].km += km;
    yd.months[month][sport].min += min;

    const wk = toWeekStart(dr);
    if (!weeklyBySport.has(sport)) weeklyBySport.set(sport, new Map());
    const sw = weeklyBySport.get(sport)!;
    if (!sw.has(wk)) sw.set(wk, { km: 0, min: 0 });
    const w = sw.get(wk)!;
    w.km += km;
    w.min += min;
  }

  const peaks: Record<string, { weekStart: string; km: number; min: number }> = {};
  for (const [sport, weeks] of weeklyBySport.entries()) {
    let best = { weekStart: '', km: 0, min: 0 };
    for (const [wk, s] of weeks.entries()) {
      if (s.km > best.km || (s.km === 0 && s.min > best.min)) best = { weekStart: wk, ...s };
    }
    peaks[sport] = best;
  }

  const today = now.toISOString().split('T')[0];
  const sortedYears = Array.from(byYear.values()).sort((a, b) => a.year - b.year);
  const lines: string[] = [
    `# Historial de Entrenamiento — ${email}`,
    `\n*Generado: ${today} | Período: ${cutoffStr} → ${today} | Total actividades: ${allActivities.length}*\n`,
    '## Resumen anual por deporte\n',
    '| Año | Deporte | Sesiones | Km totales | Horas totales |',
    '|-----|---------|----------|------------|---------------|',
  ];

  for (const yd of sortedYears) {
    for (const [sport, stats] of Object.entries(yd.sports).sort((a, b) => b[1].totalMin - a[1].totalMin)) {
      lines.push(`| ${yd.year} | ${sport} | ${stats.count} | ${Math.round(stats.totalKm)} km | ${Math.round(stats.totalMin / 60)} h |`);
    }
  }

  lines.push('\n## Picos máximos — Mejor semana por deporte\n');
  for (const [sport, peak] of Object.entries(peaks)) {
    if (!peak.weekStart) continue;
    const vol = peak.km > 0
      ? `${Math.round(peak.km)} km (${Math.round(peak.min / 60)} h)`
      : `${Math.round(peak.min / 60)} h`;
    lines.push(`- **${sport}**: semana del ${peak.weekStart} → ${vol}`);
  }

  lines.push('\n## Tendencia interanual\n');
  for (const sport of ['running', 'cycling', 'swimming', 'strength']) {
    const trend = sortedYears
      .filter(yd => yd.sports[sport])
      .map(yd => `${yd.year}: ${Math.round(yd.sports[sport].totalKm)}km/${yd.sports[sport].count}ses`);
    if (trend.length > 1) lines.push(`- **${sport}**: ${trend.join(' → ')}`);
  }

  lines.push('\n## Volumen mensual detallado\n');
  const allMonths = new Set<string>();
  for (const yd of sortedYears) Object.keys(yd.months).forEach(m => allMonths.add(m));
  for (const month of Array.from(allMonths).sort()) {
    const parts: string[] = [];
    for (const yd of sortedYears) {
      const data = yd.months[month];
      if (!data) continue;
      if (data.running?.km) parts.push(`run ${Math.round(data.running.km)}km`);
      if (data.cycling?.km) parts.push(`bike ${Math.round(data.cycling.km)}km`);
      if (data.swimming?.km) parts.push(`swim ${Math.round(data.swimming.km * 1000)}m`);
      if (data.strength?.min) parts.push(`gym ${Math.round(data.strength.min / 60)}h`);
    }
    if (parts.length > 0) lines.push(`- ${month}: ${parts.join(' | ')}`);
  }

  const allWeeks = new Set(allActivities.map(r => toWeekStart(String(r.startTimeLocal ?? '').split('T')[0])).filter(Boolean));
  lines.push(`\n## Consistencia\n- Semanas activas: ${allWeeks.size} de ~${Math.round(allActivities.length > 0 ? allWeeks.size : 0)} posibles`);
  lines.push(`- Promedio de sesiones por semana activa: ${allWeeks.size > 0 ? (allActivities.length / allWeeks.size).toFixed(1) : 'N/A'}`);

  return lines.join('\n');
}
