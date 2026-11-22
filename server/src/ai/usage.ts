import type { Pool } from '../db.js';
import type { AiServices } from './index.js';

/** Limitation de débit de l'IA par utilisateur, partagée par toutes les routes (en mémoire : une seule instance du serveur). */
export const aiCalls = new Map<string, number[]>();

export const resolveToday = (d?: string) => {
  const serverToday = new Date().toISOString().slice(0, 10);
  return d && Math.abs(new Date(d).getTime() - new Date(serverToday).getTime()) <= 2 * 86_400_000 ? d : serverToday;
};

/** Limite de débit, plafond mensuel et journal d'usage de l'IA (mêmes règles pour le mobile et le back). */
export function aiUsage(pool: Pool, ai?: AiServices) {
  return {
    rateOk(userId: string): boolean {
      const now = Date.now(); const recent = (aiCalls.get(userId) ?? []).filter(t => now - t < 60_000);
      if (recent.length >= Number(process.env.AI_RATE_PER_MIN ?? 10)) return false;
      aiCalls.set(userId, [...recent, now]); return true;
    },
    async budgetOk(userId: string): Promise<boolean> {
      if (!ai?.prices) return true;     // plafond appliqué seulement si les tarifs sont connus
      const q = (await pool.query(
        `SELECT COALESCE((SELECT sum(cost_cents) FROM ai_usage WHERE user_id = $1 AND created_at >= date_trunc('month', now())), 0) AS used,
                COALESCE((SELECT ai_budget_cents FROM app_user WHERE id = $1), (SELECT (value #>> '{}')::int FROM app_setting WHERE key = 'ai_monthly_budget_cents')) AS budget`, [userId])).rows[0];
      return Number(q.used) < Number(q.budget);
    },
    logUsage: (userId: string, rs: { provider: string; model: string; usage: { tokensIn: number | null; tokensOut: number | null }; costCents: number }) =>
      pool.query(`INSERT INTO ai_usage(user_id, kind, provider, model, tokens_in, tokens_out, cost_cents) VALUES ($1,'llm',$2,$3,$4,$5,$6)`, [userId, rs.provider, rs.model, rs.usage.tokensIn, rs.usage.tokensOut, rs.costCents]),
  };
}
