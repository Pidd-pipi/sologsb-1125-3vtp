import { create } from 'zustand';
import { db, makeId, seedIfEmpty } from '../db';
import type { AnalysisRecord } from '../types/analysis';
import type { FindRecord } from '../types/find';
import type { MeteoriteSample } from '../types/sample';
import type { ThinSection } from '../types/section';

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
  /**
   * 新增切片并扣减样本可用余量。
   * 在单个 Dexie 事务内完成「读余量 → 校验 → 写入」，并发提交时超余量的那笔会抛错，
   * 不写入切片、不改变已有记录。
   */
  addSection: (input: Omit<ThinSection, 'id' | 'createdAt'>) => Promise<string>;
  updateSection: (id: string, patch: Partial<ThinSection>) => Promise<void>;
  /** 制样取消：撤回切片并归还领用重量到可用余量，需填写原因 */
  withdrawSection: (id: string, reason: string) => Promise<void>;
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
    const weight = Number(input.weightUsed);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error('领用重量需为大于 0 的数值');
    }
    const record: ThinSection = {
      ...input,
      weightUsed: weight,
      id: makeId('section'),
      createdAt: Date.now(),
    };
    // 余量校验与写入放在同一事务：IndexedDB 会串行化重叠的 rw 事务，
    // 两人同时提交时，合计超出余量的那笔在校验阶段失败，另一笔照常入账。
    await db.transaction('rw', db.samples, db.sections, async () => {
      const sample = await db.samples.get(record.sampleId);
      if (!sample) throw new Error('关联样本不存在');
      const siblings = await db.sections
        .where('sampleId')
        .equals(record.sampleId)
        .toArray();
      const used = siblings
        .filter((s) => !s.withdrawnAt)
        .reduce((sum, s) => sum + (Number(s.weightUsed) || 0), 0);
      const remaining = sample.totalWeight - used;
      if (record.weightUsed > remaining + 1e-9) {
        throw new Error(
          `领用 ${record.weightUsed} g 超出可用余量 ${remaining.toFixed(3)} g，未写入切片`,
        );
      }
      await db.sections.add(record);
    });
    set({ sections: [record, ...get().sections] });
    return record.id;
  },

  updateSection: async (id, patch) => {
    await db.sections.update(id, patch);
    set({ sections: get().sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  },

  withdrawSection: async (id, reason) => {
    const trimmed = reason.trim();
    if (!trimmed) throw new Error('撤回需填写原因');
    const target = get().sections.find((s) => s.id === id);
    if (!target) throw new Error('切片不存在');
    if (target.withdrawnAt) throw new Error('该切片已撤回');
    const patch = { withdrawnAt: Date.now(), withdrawReason: trimmed };
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
