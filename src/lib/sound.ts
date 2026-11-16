/**
 * 提醒音用 WebAudio 现场合成，不打包音频文件：
 * 离线可用、体积极小，两个音的一小段清音也不会像系统警报那样刺耳。
 * 主进程开启了 autoplay-policy，窗口没有用户手势时也能响。
 */

let context: AudioContext | null = null;

function ensureContext() {
  if (context) return context;
  const Ctor =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  return context;
}

/** 两声柔和的上行提示音；音量刻意压得低，办公室里不突兀 */
export function playReminderChime() {
  try {
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const base = ctx.currentTime + 0.02;
    const notes = [
      { freq: 784.0, at: 0 }, // G5
      { freq: 1046.5, at: 0.18 }, // C6
    ];
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = note.freq;
      const start = base + note.at;
      const end = start + 0.55;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  } catch {
    /* 没有音频设备就安静地只弹提醒 */
  }
}
