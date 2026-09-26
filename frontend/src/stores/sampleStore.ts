import { create } from 'zustand';
import { db, makeId, seedIfEmpty } from '../db';
import type { AnalysisRecord } from '../types/analysis';
import type { FindRecord } from '../types/find';
import type { MeteoriteSample } from '../types/sample';
import type { ThinSection } from '../types/section';
import { consumedWeightOf, WEIGHT_EPS } from '../utils/weight';

/** 领用重量超过样本可用余量：事务回滚、切片不写入、已有记录不变 */
export class InsufficientWeightError extends Error {
  remaining: number;
  requested: number;
  constructor(remaining: number, requested: number) {
    super(`领用重量 ${requested} g 超过可用余量 ${remaining} g`);
    this.name = 'InsufficientWeightError';
    this.remaining = remaining;
    this.requested = requested;
  }
}

export interface SampleState {
  samples: MeteoriteSample[];
  finds: FindRecord[];
  sections: ThinSection[];
  analysis: AnalysisRecord[];
  loading: boolean;
  loaded: boolean;
  loadAll: () => Promise<void>;
  addSample: (input: Omit<MeteoriteSample, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updateSample: (id: string, patch: Partial<MeteoriteSample>) => Promise<void>;
  removeSample: (id: string) => Promise<void>;
  addFind: (input: Omit<FindRecord, 'id' | 'createdAt'>) => Promise<string>;
  addSection: (
    input: Omit<ThinSection, 'id' | 'createdAt' | 'cancelled' | 'cancelReason' | 'cancelledAt'>,
  ) => Promise<string>;
  cancelSection: (id: string, reason: string) => Promise<void>;
  updateSection: (id: string, patch: Partial<ThinSection>) => Promise<void>;
  addAnalysis: (input: Omit<AnalysisRecord, 'id' | 'createdAt'>) => Promise<string>;
  nextSampleSeq: () => number;
}

export const useSampleStore = create<SampleState>((set, get) => ({
  samples: [],
  finds: [],
  sections: [],
  analysis: [],
  loading: false,
  loaded: false,

  loadAll: async () => {
    set({ loading: true });
    await seedIfEmpty();
    const [samples, finds, sections, analysis] = await Promise.all([
      db.samples.toArray(),
      db.finds.toArray(),
      db.sections.toArray(),
      db.analysis.toArray(),
    ]);
    samples.sort((a, b) => b.createdAt - a.createdAt);
    finds.sort((a, b) => b.createdAt - a.createdAt);
    sections.sort((a, b) => b.createdAt - a.createdAt);
    analysis.sort((a, b) => b.createdAt - a.createdAt);
    set({ samples, finds, sections, analysis, loading: false, loaded: true });
  },

  addSample: async (input) => {
    const now = Date.now();
    const record: MeteoriteSample = { ...input, id: makeId('sample'), createdAt: now, updatedAt: now };
    await db.samples.add(record);
    set({ samples: [record, ...get().samples] });
    return record.id;
  },

  updateSample: async (id, patch) => {
    const updatedAt = Date.now();
    await db.samples.update(id, { ...patch, updatedAt });
    set({
      samples: get().samples.map((s) => (s.id === id ? { ...s, ...patch, updatedAt } : s)),
    });
  },

  removeSample: async (id) => {
    await db.transaction('rw', db.samples, db.finds, db.sections, db.analysis, async () => {
      await db.samples.delete(id);
      await db.finds.where('sampleId').equals(id).delete();
      await db.sections.where('sampleId').equals(id).delete();
      await db.analysis.where('sampleId').equals(id).delete();
    });
    set({
      samples: get().samples.filter((s) => s.id !== id),
      finds: get().finds.filter((f) => f.sampleId !== id),
      sections: get().sections.filter((s) => s.sampleId !== id),
      analysis: get().analysis.filter((a) => a.sampleId !== id),
    });
  },

  addFind: async (input) => {
    const record: FindRecord = { ...input, id: makeId('find'), createdAt: Date.now() };
    await db.finds.add(record);
    set({ finds: [record, ...get().finds] });
    return record.id;
  },

  addSection: async (input) => {
    const weight = Number(input.consumedWeight);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error('领用重量必须为大于 0 的数值');
    }

    const record: ThinSection = {
      ...input,
      consumedWeight: weight,
      cancelled: false,
      id: makeId('section'),
      createdAt: Date.now(),
    };

    // 重量台账原子操作：在同一个读写事务内读余量、校验、写切片。
    // IndexedDB 事务串行执行，两个页面/标签页同时提交时，
    // 后执行的事务会看到前一事务已扣减后的余量，合计超出余量的那笔抛错回滚。
    await db.transaction('rw', db.samples, db.sections, async () => {
      const sample = await db.samples.get(input.sampleId);
      if (!sample) throw new Error('关联样本不存在');
      const existing = await db.sections.where('sampleId').equals(input.sampleId).toArray();
      const remaining = sample.totalWeight - consumedWeightOf(existing);
      if (weight > remaining + WEIGHT_EPS) {
        throw new InsufficientWeightError(remaining, weight);
      }
      await db.sections.add(record);
    });

    set({ sections: [record, ...get().sections] });
    return record.id;
  },

  cancelSection: async (id, reason) => {
    const trimmed = reason.trim();
    if (!trimmed) throw new Error('撤回切片必须填写原因');

    // 撤回动作本身不扣减余量，只把切片标记为撤回；余量由 consumedWeightOf 实时汇总恢复。
    // 放在读写事务内，保证与新增切片的扣减互不覆盖。
    const patch: Partial<ThinSection> = {
      cancelled: true,
      cancelReason: trimmed,
      cancelledAt: Date.now(),
    };
    await db.transaction('rw', db.sections, async () => {
      const current = await db.sections.get(id);
      if (!current) throw new Error('切片不存在');
      if (current.cancelled) return; // 幂等：重复撤回不重复处理
      await db.sections.update(id, patch);
    });

    set({
      sections: get()
        .sections
        // 已撤回（幂等返回）时不重复改写本地状态
        .map((s) => (s.id === id && !s.cancelled ? { ...s, ...patch } : s)),
    });
  },

  updateSection: async (id, patch) => {
    await db.sections.update(id, patch);
    set({ sections: get().sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  },

  addAnalysis: async (input) => {
    const record: AnalysisRecord = { ...input, id: makeId('analysis'), createdAt: Date.now() };
    await db.analysis.add(record);
    set({ analysis: [record, ...get().analysis] });
    return record.id;
  },

  nextSampleSeq: () => {
    const year = new Date().getFullYear();
    const prefix = `MET-${year}-`;
    const used = get()
      .samples.map((s) => s.sampleNo)
      .filter((no) => no.startsWith(prefix))
      .map((no) => Number(no.slice(prefix.length)))
      .filter((n) => Number.isFinite(n));
    const max = used.length ? Math.max(...used) : 0;
    return max + 1;
  },
}));
