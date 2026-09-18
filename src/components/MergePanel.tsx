import { useMemo, useState } from 'react';
import type { Cue } from '../lib/types';
import { parseVTT } from '../lib/vtt';
import { applyMergeBilingual, planMergeBilingual } from '../lib/merge';
import { formatTimecode } from '../lib/time';

interface Props {
  /** 主轨：当前全部片段（顺序无所谓，内部按时间排序） */
  cues: Cue[];
  /** 点击主轨预览行时选中并滚动到对应片段 */
  onJump: (id: string) => void;
  /** 确认合并：仅配对副轨文本追加到主轨后一次性写入 */
  onApply: (next: Cue[], paired: number, unmatched: number) => void;
}

/**
 * 合并双语轨面板：
 * 当前字幕作为主轨，粘贴或选择另一份 WebVTT 作为副轨；
 * 解析后预览每条主轨的配对文本，并单列未配对副轨；
 * 取消不改任何数据，确认后才把配对副轨文本追加为新行。
 */
export default function MergePanel({ cues, onJump, onApply }: Props) {
  const [raw, setRaw] = useState('');
  const [secondary, setSecondary] = useState<Cue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(true);

  function parse(rawText: string) {
    const res = parseVTT(rawText);
    if (res.error) {
      setError(res.error);
      return;
    }
    setError(null);
    setSecondary(res.cues);
    setEditing(false);
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      setRaw(text);
      parse(text);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // 主轨或副轨变化时实时重算（预览即结果，确认时同样计算，避免快照过期）
  const plan = useMemo(
    () => (secondary ? planMergeBilingual(cues, secondary) : null),
    [cues, secondary],
  );

  function startOver() {
    setRaw('');
    setSecondary(null);
    setError(null);
    setEditing(true);
  }

  function cancel() {
    // 取消不改任何数据：仅清面板状态
    startOver();
  }

  function confirm() {
    if (!plan || plan.pairs.length === 0) return;
    onApply(applyMergeBilingual(cues, plan), plan.pairs.length, plan.unmatchedSecondary.length);
    startOver();
  }

  return (
    <section className="panel merge-panel">
      <h2>
        合并双语轨
        <span className="muted small ml">副轨文本追加为新行</span>
      </h2>

      <p className="muted small">
        以当前字幕为<strong>主轨</strong>，粘贴或选择另一份 WebVTT 作为副轨。仅当两片时间交集不短于较短片段的
        <strong> 50%</strong> 时才列为候选；在保持双方顺序、每条最多使用一次的前提下求总交集时长最大的配对，
        总分并列时取副轨索引序列字典序更小者。
      </p>

      {editing && (
        <>
          <div className="modal-actions">
            <label className="btn primary merge-file-btn">
              选择副轨文件…
              <input type="file" accept=".vtt,text/vtt,text/plain" hidden onChange={onFile} />
            </label>
            <button className="btn" onClick={() => setRaw('')}>清空</button>
          </div>
          <textarea
            className="paste-area mono merge-paste"
            rows={6}
            placeholder="粘贴副轨 WebVTT：&#10;WEBVTT&#10;&#10;00:00.000 --> 00:02.000&#10;Second language line…"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setError(null);
            }}
          />
          {error && <div className="import-error">副轨解析失败：{error}</div>}
          <div className="sync-actions">
            <button
              className="btn primary"
              disabled={!raw.trim()}
              onClick={() => parse(raw)}
            >
              解析并预览配对
            </button>
          </div>
        </>
      )}

      {!editing && plan && (
        <>
          <div className="sync-status ok">
            ✅ 已解析副轨 {plan.secondary.length} 条：配对 {plan.pairs.length} 条主轨，
            总交集 {plan.totalOverlap.toFixed(2)}s；{plan.unmatchedSecondary.length} 条副轨未配对（不会写入）。
            此为预览，确认前不改动任何数据。
          </div>

          <div className="merge-preview">
            {plan.primary.length === 0 && (
              <p className="muted small">当前主轨没有片段，请先导入字幕。</p>
            )}
            {plan.primary.map((p, pi) => {
              const pair = plan.pairs.find((x) => x.primaryId === p.id);
              const sec = pair ? plan.secondary[pair.secondaryIndex] : null;
              return (
                <div
                  key={p.id}
                  className={`merge-row ${sec ? 'paired' : 'skipped'}`}
                  onClick={() => onJump(p.id)}
                  title="点击定位到主轨片段"
                >
                  <div className="merge-row-head mono">
                    <span className="merge-idx">#{pi + 1}</span>
                    {formatTimecode(p.start)} → {formatTimecode(p.end)}
                    {p.locked && <span title="锁定状态保留"> 🔒</span>}
                  </div>
                  <div className="merge-text primary-line">{p.text}</div>
                  {sec && (
                    <div className="merge-text secondary-line">
                      <span className="merge-badge mono">
                        副#{pair!.secondaryIndex + 1} · {pair!.overlap.toFixed(2)}s ·{' '}
                        {Math.round(pair!.ratio * 100)}%
                      </span>
                      {' '}
                      {sec.text}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {plan.unmatchedSecondary.length > 0 && (
            <>
              <div className="field-label merge-unmatched-title">
                未配对副轨（{plan.unmatchedSecondary.length} 条 · 不写入）
              </div>
              <div className="merge-preview merge-unmatched">
                {plan.unmatchedSecondary.map((si) => {
                  const s = plan.secondary[si];
                  return (
                    <div key={si} className="merge-row unmatched-sec">
                      <div className="merge-row-head mono">
                        <span className="merge-idx">#{si + 1}</span>
                        {formatTimecode(s.start)} → {formatTimecode(s.end)}
                      </div>
                      <div className="merge-text secondary-line">{s.text}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div className="sync-actions">
            <button
              className="btn primary"
              disabled={plan.pairs.length === 0}
              onClick={confirm}
            >
              确认合并（{plan.pairs.length} 条）
            </button>
            <button className="btn" onClick={cancel}>取消（不改动数据）</button>
          </div>
        </>
      )}
    </section>
  );
}
