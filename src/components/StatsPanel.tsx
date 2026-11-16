import { useMemo } from 'react';
import { useApp } from '../store/app';
import { computeWritingStats, formatWords } from '../lib/stats';
import { cn, dateKey } from '../lib/utils';
import { useT } from '../lib/i18n';

export function StatsPanel() {
  const notes = useApp((s) => s.notes);
  const tr = useT();
  const stats = useMemo(() => computeWritingStats(notes), [notes]);
  const todayKey = dateKey();
  const max = Math.max(1, ...stats.daily.map((d) => d.words));

  const cards = [
    { num: String(stats.weekDays), unit: tr('天'), label: tr('本周写作') },
    { num: formatWords(stats.weekWords), unit: tr('字'), label: tr('本周写过') },
    { num: String(stats.streak), unit: tr('天'), label: tr('连续记录') },
    { num: formatWords(stats.totalWords), unit: tr('字'), label: tr('累计字数') },
  ];

  return (
    <div className="stats-panel">
      <div className="stats-summary">
        {tr('已经写下')} <strong>{stats.totalNotes}</strong> {tr('篇笔记，共')} <strong>{formatWords(stats.totalWords)}</strong> {tr('字。')}
        {stats.streak > 1 ? tr(' 最近连续记录了 {n} 天，保持住。', { n: stats.streak }) : ''}
      </div>

      <div className="stats-grid">
        {cards.map((c) => (
          <div className="stat-card" key={c.label}>
            <span className="stat-label">{c.label}</span>
            <span className="stat-num">
              {c.num}
              <em>{c.unit}</em>
            </span>
          </div>
        ))}
      </div>

      <div className="stats-title">{tr('最近 7 天')}</div>
      <div className="stat-bars">
        {stats.daily.map((d) => (
          <div className="stat-col" key={d.key} title={tr('{label} · {notes} 篇 · {words} 字', { label: d.label, notes: d.notes, words: d.words })}>
            <div className="stat-bar-wrap">
              <div
                className={cn('stat-bar', d.words === 0 && 'empty', d.key === todayKey && 'today')}
                style={{ height: `${d.words === 0 ? 3 : Math.max(8, Math.round((d.words / max) * 100))}%` }}
              />
            </div>
            <span className={cn('stat-day', d.key === todayKey && 'today')}>{d.label}</span>
          </div>
        ))}
      </div>

      <div className="stats-foot">
        {tr('统计按笔记的最后修改日期归属；同一篇笔记在不同天修改会分别计入。所有计算只在本机完成，不会上传。')}
      </div>
    </div>
  );
}
