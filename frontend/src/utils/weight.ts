import type { MeteoriteSample } from '../types/sample';
import type { ThinSection } from '../types/section';

/** 浮点比较容差：重量相减在该范围内视为相等，避免 0.1+0.2 类误差 */
export const WEIGHT_EPS = 1e-6;

/**
 * 已领用重量：仅统计未撤回的切片。
 * 撤回的切片已把领用重量退回余量，不参与扣减。
 */
export function consumedWeightOf(sections: Array<Pick<ThinSection, 'consumedWeight' | 'cancelled'>>): number {
  return sections.reduce((sum, s) => sum + (s.cancelled ? 0 : Number(s.consumedWeight) || 0), 0);
}

/** 剩余可用余量 = 总重量 − 已领用 */
export function remainingWeight(totalWeight: number, sections: Array<Pick<ThinSection, 'consumedWeight' | 'cancelled'>>): number {
  return (Number(totalWeight) || 0) - consumedWeightOf(sections);
}

export interface WeightLedger {
  total: number;
  consumed: number;
  remaining: number;
}

/** 汇总某份样本的重量台账：总重量 / 已领用 / 剩余 */
export function weightLedger(sample: Pick<MeteoriteSample, 'totalWeight'>, sections: ThinSection[]): WeightLedger {
  const total = Number(sample.totalWeight) || 0;
  const consumed = consumedWeightOf(sections);
  return { total, consumed, remaining: total - consumed };
}

/** 领用重量是否在余量之内（含恰好等于余量的边界） */
export function canConsume(remaining: number, weight: number): boolean {
  return Number.isFinite(weight) && weight > 0 && weight <= remaining + WEIGHT_EPS;
}
