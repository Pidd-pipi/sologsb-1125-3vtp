import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import UndoIcon from '@mui/icons-material/Undo';
import { Link as RouterLink, useParams } from 'react-router-dom';
import SampleCard from '../components/common/SampleCard';
import FieldGroup from '../components/common/FieldGroup';
import ClassificationBadge from '../components/common/Badge';
import EmptyState from '../components/common/EmptyState';
import { useSampleStore, InsufficientWeightError } from '../stores/sampleStore';
import { useToastStore } from '../stores/uiStore';
import {
  ANALYSIS_METHODS,
  ANALYSIS_METHOD_LABELS,
  ANALYSIS_THRESHOLDS,
  type AnalysisMethod,
} from '../types/analysis';
import {
  MINERAL_KEYS,
  MINERAL_LABELS,
  PREPARATIONS,
  PREPARATION_LABELS,
  SECTION_QUALITIES,
  SECTION_QUALITY_LABELS,
  mineralTotal,
  type MineralRatios,
  type PreparationMethod,
  type SectionQuality,
  type ThinSection,
} from '../types/section';
import {
  FALL_OR_FIND_LABELS,
  STORAGE_LABELS,
  WEATHERING_LABELS,
} from '../types/sample';
import { FIND_ENVIRONMENT_LABELS, COORDINATE_SOURCE_LABELS } from '../types/find';
import { classifyByAnalysis, evaluateThresholds } from '../utils/classify';
import { formatDate, formatNumber, formatWeight } from '../utils/format';
import { formatCoordinate } from '../utils/geo';
import { canConsume, weightLedger } from '../utils/weight';

/** `/samples/:id` 样本详情 */
export default function Detail() {
  const { id = '' } = useParams();
  const samples = useSampleStore((s) => s.samples);
  const finds = useSampleStore((s) => s.finds);
  const sections = useSampleStore((s) => s.sections);
  const analysis = useSampleStore((s) => s.analysis);
  const addSection = useSampleStore((s) => s.addSection);
  const cancelSection = useSampleStore((s) => s.cancelSection);
  const addAnalysis = useSampleStore((s) => s.addAnalysis);
  const updateSample = useSampleStore((s) => s.updateSample);
  const notify = useToastStore((s) => s.notify);

  const sample = useMemo(() => samples.find((s) => s.id === id), [samples, id]);
  const find = useMemo(() => finds.find((f) => f.sampleId === id), [finds, id]);
  const mySections = useMemo(() => sections.filter((s) => s.sampleId === id), [sections, id]);
  const activeSections = useMemo(() => mySections.filter((s) => !s.cancelled), [mySections]);
  const cancelledSections = useMemo(() => mySections.filter((s) => s.cancelled), [mySections]);
  const myAnalysis = useMemo(() => analysis.filter((a) => a.sampleId === id), [analysis, id]);

  const [sectionDraft, setSectionDraft] = useState({
    sectionNo: '',
    thickness: 30,
    consumedWeight: '' as number | '',
    preparation: 'resin' as PreparationMethod,
    quality: 'unrated' as SectionQuality,
    micrograph: '',
    minerals: { olivine: 40, pyroxene: 25, feldspar: 15, metal: 20 } as MineralRatios,
  });
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [sectionSaving, setSectionSaving] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<ThinSection | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [analysisDraft, setAnalysisDraft] = useState({
    method: 'microprobe' as AnalysisMethod,
    fa: 18,
    fs: 16,
    ni: 0.8,
    kamaciteBandwidth: 0.05,
    testedAt: new Date().toISOString().slice(0, 10),
  });

  if (!sample) {
    return (
      <Stack spacing={2}>
        <EmptyState
          title="未找到该样本档案"
          description={`样本 id「${id}」不在本地库中，可能已被删除或链接失效。`}
          actionLabel="返回样本总览"
          actionTo="/"
        />
      </Stack>
    );
  }

  const ledger = weightLedger(sample, mySections);
  const requestedWeight = Number(sectionDraft.consumedWeight);
  const weightTouched = sectionDraft.consumedWeight !== '';
  const weightInvalid =
    !weightTouched || !Number.isFinite(requestedWeight) || requestedWeight <= 0;
  const overRemaining = !weightInvalid && !canConsume(ledger.remaining, requestedWeight);
  const mineralSum = mineralTotal(sectionDraft.minerals);
  const advice = classifyByAnalysis(analysisDraft);
  const hits = evaluateThresholds(analysisDraft);

  const submitSection = async () => {
    const no =
      sectionDraft.sectionNo.trim() ||
      `TS-${new Date().getFullYear()}-${activeSections.length + 1}`.padEnd(3, '0');
    if (weightInvalid) {
      setSectionError('请填写大于 0 的领用重量（g）');
      return;
    }
    setSectionSaving(true);
    setSectionError(null);
    try {
      await addSection({
        sectionNo: no,
        sampleId: sample.id,
        thickness: Number(sectionDraft.thickness),
        consumedWeight: requestedWeight,
        preparation: sectionDraft.preparation,
        minerals: sectionDraft.minerals,
        micrographs: sectionDraft.micrograph.trim() ? [sectionDraft.micrograph.trim()] : [],
        quality: sectionDraft.quality,
      });
    } catch (err) {
      // 余量不足：切片未写入、已有记录不变，仅在表单处提示
      if (err instanceof InsufficientWeightError) {
        setSectionError(
          `领用 ${err.requested} g 超过可用余量 ${formatWeight(err.remaining)}，该切片未保存，已有记录未改动。`,
        );
      } else {
        setSectionError(err instanceof Error ? err.message : '切片保存失败');
      }
      setSectionSaving(false);
      return;
    }
    setSectionSaving(false);
    notify(`已为 ${sample.sampleNo} 新增切片 ${no}，扣减领用 ${formatWeight(requestedWeight)}`);
    setSectionDraft((d) => ({
      ...d,
      sectionNo: '',
      consumedWeight: '',
      micrograph: '',
    }));
  };

  const openCancel = (section: ThinSection) => {
    setCancelTarget(section);
    setCancelReason('');
    setCancelError(null);
  };

  const submitCancel = async () => {
    if (!cancelTarget) return;
    if (!cancelReason.trim()) {
      setCancelError('请填写撤回原因');
      return;
    }
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelSection(cancelTarget.id, cancelReason);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : '撤回失败');
      setCancelling(false);
      return;
    }
    notify(`切片 ${cancelTarget.sectionNo} 已撤回，领用 ${formatWeight(cancelTarget.consumedWeight)} 已退回余量`);
    setCancelling(false);
    setCancelTarget(null);
  };

  const submitAnalysis = async () => {
    await addAnalysis({
      sampleId: sample.id,
      target: 'sample',
      method: analysisDraft.method,
      fa: Number(analysisDraft.fa),
      fs: Number(analysisDraft.fs),
      ni: Number(analysisDraft.ni),
      kamaciteBandwidth: Number(analysisDraft.kamaciteBandwidth),
      testedAt: analysisDraft.testedAt,
    });
    notify(`已为 ${sample.sampleNo} 写入一条检测记录`);
  };

  return (
    <Stack spacing={2.5}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Button component={RouterLink} to="/" startIcon={<ArrowBackIcon />} variant="text">
          返回总览
        </Button>
        <Typography variant="h4">样本详情</Typography>
      </Stack>

      <Grid container spacing={2.5}>
        <Grid item xs={12} md={4}>
          <SampleCard
            sample={sample}
            find={find}
            sectionCount={activeSections.length}
            analysisCount={myAnalysis.length}
          />
        </Grid>

        <Grid item xs={12} md={8}>
          <Paper variant="outlined" sx={{ p: 2.5, height: '100%' }}>
            <Stack spacing={1.5}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="h6">基本信息</Typography>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => {
                    void updateSample(sample.id, { storage: sample.storage === 'loan-out' ? 'cabinet-a' : 'loan-out' });
                    notify('已切换存放状态');
                  }}
                >
                  切换存放状态
                </Button>
              </Stack>
              <ClassificationBadge
                category={sample.category}
                group={sample.chemicalGroup}
                size="medium"
              />
              <Grid container spacing={1.5}>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    编号
                  </Typography>
                  <Typography variant="body1">{sample.sampleNo}</Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    总重量
                  </Typography>
                  <Typography variant="body1">{formatWeight(ledger.total)}</Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    已领用（切片制样）
                  </Typography>
                  <Typography variant="body1" color="warning.dark">
                    {formatWeight(ledger.consumed)}
                  </Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    可用剩余
                  </Typography>
                  <Typography
                    variant="body1"
                    fontWeight={700}
                    color={ledger.remaining <= 0 ? 'error.main' : 'success.dark'}
                  >
                    {formatWeight(ledger.remaining)}
                  </Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    风化等级
                  </Typography>
                  <Typography variant="body1">{WEATHERING_LABELS[sample.weathering]}</Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    发现 / 坠落
                  </Typography>
                  <Typography variant="body1">{FALL_OR_FIND_LABELS[sample.fallOrFind]}</Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    存放位置
                  </Typography>
                  <Typography variant="body1">{STORAGE_LABELS[sample.storage]}</Typography>
                </Grid>
                <Grid item xs={6} sm={4}>
                  <Typography variant="caption" color="text.secondary">
                    登记 / 更新
                  </Typography>
                  <Typography variant="body1">
                    {formatDate(sample.createdAt)} / {formatDate(sample.updatedAt)}
                  </Typography>
                </Grid>
              </Grid>
              {sample.note ? (
                <Typography variant="body2" color="text.secondary">
                  备注：{sample.note}
                </Typography>
              ) : null}
              <Divider />
              <Typography variant="h6">发现地摘要</Typography>
              {find ? (
                <Grid container spacing={1.5}>
                  <Grid item xs={6} sm={4}>
                    <Typography variant="caption" color="text.secondary">
                      地名
                    </Typography>
                    <Typography variant="body2">{find.placeName}</Typography>
                  </Grid>
                  <Grid item xs={6} sm={4}>
                    <Typography variant="caption" color="text.secondary">
                      国家 / 地区
                    </Typography>
                    <Typography variant="body2">{find.region}</Typography>
                  </Grid>
                  <Grid item xs={6} sm={4}>
                    <Typography variant="caption" color="text.secondary">
                      坐标
                    </Typography>
                    <Typography variant="body2">
                      {formatCoordinate(find.longitude, find.latitude)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={4}>
                    <Typography variant="caption" color="text.secondary">
                      坐标来源
                    </Typography>
                    <Typography variant="body2">
                      {COORDINATE_SOURCE_LABELS[find.coordinateSource]}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={4}>
                    <Typography variant="caption" color="text.secondary">
                      发现环境
                    </Typography>
                    <Typography variant="body2">
                      {FIND_ENVIRONMENT_LABELS[find.environment]}
                    </Typography>
                  </Grid>
                  <Grid item xs={6} sm={4}>
                    <Typography variant="caption" color="text.secondary">
                      发现者
                    </Typography>
                    <Typography variant="body2">{find.finder}</Typography>
                  </Grid>
                </Grid>
              ) : (
                <Alert severity="warning">
                  该样本尚未登记发现地坐标，可返回 <RouterLink to="/samples/new">样本登记</RouterLink> 补录。
                </Alert>
              )}
            </Stack>
          </Paper>
        </Grid>
      </Grid>

      <Grid container spacing={2.5}>
        <Grid item xs={12} md={7}>
          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Typography variant="h6" sx={{ mb: 1.5 }}>
              切片与制样（{activeSections.length}）
            </Typography>

            <Paper variant="outlined" sx={{ p: 1.5, mb: 2, bgcolor: 'grey.50' }}>
              <Stack
                direction="row"
                spacing={3}
                flexWrap="wrap"
                useFlexGap
                divider={<Divider orientation="vertical" flexItem />}
              >
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    总重量
                  </Typography>
                  <Typography variant="subtitle1" fontWeight={700}>
                    {formatWeight(ledger.total)}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    已领用
                  </Typography>
                  <Typography variant="subtitle1" fontWeight={700} color="warning.dark">
                    {formatWeight(ledger.consumed)}
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    剩余可用
                  </Typography>
                  <Typography
                    variant="subtitle1"
                    fontWeight={700}
                    color={ledger.remaining <= 0 ? 'error.main' : 'success.dark'}
                  >
                    {formatWeight(ledger.remaining)}
                  </Typography>
                </Box>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                新增切片时在此余量内扣减领用重量；撤回切片后余量自动恢复。
              </Typography>
            </Paper>

            {activeSections.length === 0 && cancelledSections.length === 0 ? (
              <Alert severity="info">暂无切片记录，可在下方就地新增。</Alert>
            ) : (
              <Stack spacing={1.25}>
                {activeSections.map((s) => (
                  <Box
                    key={s.id}
                    sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.5 }}
                  >
                    <Stack direction="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
                      <Typography variant="subtitle1" fontWeight={700}>
                        {s.sectionNo}
                      </Typography>
                      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                        <Chip size="small" color="primary" label={`领用 ${formatWeight(s.consumedWeight)}`} />
                        <Chip size="small" label={`厚度 ${s.thickness} μm`} />
                        <Chip size="small" variant="outlined" label={PREPARATION_LABELS[s.preparation]} />
                        <Chip size="small" color="secondary" label={SECTION_QUALITY_LABELS[s.quality]} />
                        <Button
                          size="small"
                          color="warning"
                          startIcon={<UndoIcon />}
                          onClick={() => openCancel(s)}
                          id={`cancel-section-${s.id}`}
                        >
                          撤回
                        </Button>
                      </Stack>
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      矿物占比：{MINERAL_KEYS.map((k) => `${MINERAL_LABELS[k]} ${s.minerals[k]}%`).join(' · ')}
                      （合计 {mineralTotal(s.minerals)}%）
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      显微照片：{s.micrographs.length ? s.micrographs.join('、') : '未上传'}
                    </Typography>
                  </Box>
                ))}
                {cancelledSections.map((s) => (
                  <Box
                    key={s.id}
                    sx={{
                      border: '1px dashed',
                      borderColor: 'divider',
                      borderRadius: 2,
                      p: 1.5,
                      opacity: 0.75,
                      bgcolor: 'grey.50',
                    }}
                  >
                    <Stack direction="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
                      <Typography variant="subtitle1" fontWeight={700} sx={{ textDecoration: 'line-through' }}>
                        {s.sectionNo}
                      </Typography>
                      <Chip size="small" color="default" variant="outlined" label="已撤回（余量已恢复）" />
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      原领用 {formatWeight(s.consumedWeight)} · 厚度 {s.thickness} μm · 撤回时间{' '}
                      {formatDate(s.cancelledAt ?? s.createdAt)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      撤回原因：{s.cancelReason ?? '—'}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            )}

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
              就地新增切片
            </Typography>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                <TextField
                  id="section-no"
                  size="small"
                  label="切片编号"
                  value={sectionDraft.sectionNo}
                  onChange={(e) => setSectionDraft((d) => ({ ...d, sectionNo: e.target.value }))}
                  sx={{ width: 180 }}
                />
                <TextField
                  id="section-thickness"
                  size="small"
                  type="number"
                  label="厚度 μm"
                  value={sectionDraft.thickness}
                  onChange={(e) => setSectionDraft((d) => ({ ...d, thickness: Number(e.target.value) }))}
                  sx={{ width: 140 }}
                />
                <TextField
                  id="section-consumed-weight"
                  required
                  size="small"
                  type="number"
                  label="领用重量 g"
                  value={sectionDraft.consumedWeight}
                  error={weightTouched && (weightInvalid || overRemaining)}
                  helperText={
                    weightTouched && (weightInvalid || overRemaining)
                      ? weightInvalid
                        ? '须为大于 0 的数值'
                        : `超出可用剩余 ${formatWeight(ledger.remaining)}`
                      : `可用剩余 ${formatWeight(ledger.remaining)}`
                  }
                  inputProps={{ min: 0, step: 'any' }}
                  onChange={(e) =>
                    setSectionDraft((d) => ({
                      ...d,
                      consumedWeight: e.target.value === '' ? '' : Number(e.target.value),
                    }))
                  }
                  sx={{ width: 200 }}
                />
                <FormControl size="small" sx={{ minWidth: 150 }}>
                  <InputLabel id="prep-label">制样方式</InputLabel>
                  <Select
                    labelId="prep-label"
                    label="制样方式"
                    value={sectionDraft.preparation}
                    onChange={(e) =>
                      setSectionDraft((d) => ({ ...d, preparation: e.target.value as PreparationMethod }))
                    }
                  >
                    {PREPARATIONS.map((p) => (
                      <MenuItem key={p} value={p}>
                        {PREPARATION_LABELS[p]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ minWidth: 170 }}>
                  <InputLabel id="quality-label">质量标注</InputLabel>
                  <Select
                    labelId="quality-label"
                    label="质量标注"
                    value={sectionDraft.quality}
                    onChange={(e) =>
                      setSectionDraft((d) => ({ ...d, quality: e.target.value as SectionQuality }))
                    }
                  >
                    {SECTION_QUALITIES.map((q) => (
                      <MenuItem key={q} value={q}>
                        {SECTION_QUALITY_LABELS[q]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <TextField
                  id="section-micrograph"
                  size="small"
                  label="显微照片文件名"
                  value={sectionDraft.micrograph}
                  onChange={(e) => setSectionDraft((d) => ({ ...d, micrograph: e.target.value }))}
                  sx={{ width: 220 }}
                />
              </Stack>

              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                {MINERAL_KEYS.map((k) => (
                  <FieldGroup
                    key={k}
                    title={`${MINERAL_LABELS[k]}占比`}
                    unit="%"
                    min={0}
                    max={100}
                    value={sectionDraft.minerals[k]}
                    onChange={(v) =>
                      setSectionDraft((d) => ({ ...d, minerals: { ...d.minerals, [k]: v } }))
                    }
                    inputId={`mineral-${k}`}
                    label={MINERAL_LABELS[k]}
                  />
                ))}
              </Stack>
              <Typography variant="caption" color={mineralSum === 100 ? 'success.main' : 'warning.main'}>
                矿物占比合计 {mineralSum}%（建议合计 100%）
              </Typography>
              {sectionError ? <Alert severity="error" id="section-save-error">{sectionError}</Alert> : null}
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={submitSection}
                id="add-section"
                disabled={sectionSaving || weightInvalid || overRemaining}
                sx={{ alignSelf: 'flex-start' }}
              >
                {sectionSaving ? '保存中…' : '新增切片并扣减余量'}
              </Button>
              <Typography variant="caption" color="text.secondary">
                领用重量保存时从可用余量扣减；超出余量的提交不会写入切片，也不改动已有记录。
              </Typography>
            </Stack>
          </Paper>
        </Grid>

        <Grid item xs={12} md={5}>
          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Typography variant="h6" sx={{ mb: 1.5 }}>
              分析检测记录（{myAnalysis.length}）
            </Typography>
            {myAnalysis.length === 0 ? (
              <Alert severity="info">暂无检测记录。</Alert>
            ) : (
              <Stack spacing={1.25} sx={{ mb: 2 }}>
                {myAnalysis.map((a) => {
                  const a2 = classifyByAnalysis(a);
                  return (
                    <Box
                      key={a.id}
                      sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.5 }}
                    >
                      <Stack direction="row" justifyContent="space-between" flexWrap="wrap" gap={1}>
                        <Typography variant="subtitle2">
                          {ANALYSIS_METHOD_LABELS[a.method]} · {a.testedAt}
                        </Typography>
                        <ClassificationBadge category={a2.category} showGroup={false} />
                      </Stack>
                      <Typography variant="body2" color="text.secondary">
                        Fa {formatNumber(a.fa, 2, ' mol%')} · Fs {formatNumber(a.fs, 2, ' mol%')} · Ni{' '}
                        {formatNumber(a.ni, 2, ' wt%')} · 带宽 {formatNumber(a.kamaciteBandwidth, 3, ' mm')}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {a2.summary}
                      </Typography>
                    </Box>
                  );
                })}
              </Stack>
            )}

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
              就地录入检测数值
            </Typography>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                <FormControl size="small" sx={{ minWidth: 150 }}>
                  <InputLabel id="method-label">检测方法</InputLabel>
                  <Select
                    labelId="method-label"
                    label="检测方法"
                    value={analysisDraft.method}
                    onChange={(e) =>
                      setAnalysisDraft((d) => ({ ...d, method: e.target.value as AnalysisMethod }))
                    }
                  >
                    {ANALYSIS_METHODS.map((m) => (
                      <MenuItem key={m} value={m}>
                        {ANALYSIS_METHOD_LABELS[m]}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <TextField
                  id="detail-tested-at"
                  size="small"
                  type="date"
                  label="检测日期"
                  InputLabelProps={{ shrink: true }}
                  value={analysisDraft.testedAt}
                  onChange={(e) => setAnalysisDraft((d) => ({ ...d, testedAt: e.target.value }))}
                  sx={{ width: 180 }}
                />
              </Stack>
              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                <FieldGroup
                  title="橄榄石 Fa"
                  unit="mol%"
                  min={0}
                  max={30}
                  value={analysisDraft.fa}
                  onChange={(v) => setAnalysisDraft((d) => ({ ...d, fa: v }))}
                  inputId="detail-fa"
                  label="Fa"
                />
                <FieldGroup
                  title="辉石 Fs"
                  unit="mol%"
                  min={0}
                  max={30}
                  value={analysisDraft.fs}
                  onChange={(v) => setAnalysisDraft((d) => ({ ...d, fs: v }))}
                  inputId="detail-fs"
                  label="Fs"
                />
                <FieldGroup
                  title="Ni 含量"
                  unit="wt%"
                  min={0}
                  max={20}
                  value={analysisDraft.ni}
                  onChange={(v) => setAnalysisDraft((d) => ({ ...d, ni: v }))}
                  inputId="detail-ni"
                  label="Ni"
                />
                <FieldGroup
                  title="铁纹石带宽"
                  unit="mm"
                  min={0}
                  max={2}
                  value={analysisDraft.kamaciteBandwidth}
                  onChange={(v) => setAnalysisDraft((d) => ({ ...d, kamaciteBandwidth: v }))}
                  inputId="detail-band"
                  label="带宽"
                />
              </Stack>
              <Alert severity={hits.every((h) => h.inRange) ? 'success' : 'warning'}>
                分类建议：{advice.summary}
                <br />
                阈值命中：{hits.filter((h) => h.inRange).length}/{hits.length} 项落在常规区间
                <br />
                命中说明：{advice.hits.join('；')}
              </Alert>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={submitAnalysis}
                id="add-analysis"
                sx={{ alignSelf: 'flex-start' }}
              >
                写入检测记录
              </Button>
              <Typography variant="caption" color="text.secondary">
                阈值参考：
                {ANALYSIS_THRESHOLDS.map((t) => `${t.label} ${t.min}~${t.max}${t.unit}`).join(' · ')}
              </Typography>
            </Stack>
          </Paper>
        </Grid>
      </Grid>

      <Dialog open={cancelTarget !== null} onClose={cancelling ? undefined : () => setCancelTarget(null)}>
        <DialogTitle>撤回切片制样</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {cancelTarget
              ? `撤回「${cancelTarget.sectionNo}」后，其领用的 ${formatWeight(
                  cancelTarget.consumedWeight,
                )} 将退回样本可用余量，切片记录保留并标注撤回原因。`
              : ''}
          </DialogContentText>
          <TextField
            id="cancel-reason"
            autoFocus
            fullWidth
            required
            multiline
            minRows={2}
            margin="dense"
            label="撤回原因"
            value={cancelReason}
            error={cancelError !== null}
            helperText={cancelError ?? '制样取消、切片损坏等，请写明原因'}
            onChange={(e) => setCancelReason(e.target.value)}
            sx={{ mt: 1.5 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelTarget(null)} disabled={cancelling}>
            再想想
          </Button>
          <Button
            onClick={submitCancel}
            color="warning"
            variant="contained"
            disabled={cancelling || !cancelReason.trim()}
            id="confirm-cancel-section"
          >
            {cancelling ? '撤回中…' : '确认撤回并恢复余量'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
