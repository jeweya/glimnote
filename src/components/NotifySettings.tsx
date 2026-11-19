import { useEffect, useState } from 'react';
import { AlertTriangle, Bell, Check, Cloud, KeyRound, Loader2, Send, X } from 'lucide-react';
import { useApp } from '../store/app';
import { NOTIFY_CHANNELS, loadNotifyWebhooks, saveNotifyWebhook, testNotifyChannel } from '../lib/taskNotify';
import type { TaskNotifyChannel } from '../lib/tasks';
import {
  CLOUD_PUSH_WINDOW_MAX,
  CLOUD_PUSH_WINDOW_MIN,
  cachedCloudPushConfig,
  readCloudPushConfig,
  saveCloudPushConfig,
  testCloudPush,
  type CloudPushConfig,
} from '../lib/cloudPush';
import { loadTasks } from '../lib/repo';
import { checkGitHubWorkflowPermission } from '../lib/git';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18n';

/** 待办详情的「修改配置」要求直接落在「云端推送」标签页；下次挂载时消费一次 */
let pendingCloudTab = false;
export function requestNotifyCloudTab() {
  pendingCloudTab = true;
}

/**
 * 设置 → 通知：统一放三个群机器人的 Webhook。
 * 这里只负责「怎么发」，具体哪条待办发到哪些渠道，在待办里勾选。
 * 内容分两个标签页：「本地通知」走本机到点提醒，「云端推送」由仓库的定时流水线发汇总。
 */
export function NotifySettings() {
  const toast = useApp((s) => s.toast);
  const gitCfg = useApp((s) => s.cfg);
  const token = useApp((s) => s.token);
  const setSettings = useApp((s) => s.setSettings);
  const tr = useT();
  const [tab, setTab] = useState<'local' | 'cloud'>(() => {
    if (!pendingCloudTab) return 'local';
    pendingCloudTab = false;
    return 'cloud';
  });
  const [hooks, setHooks] = useState<Record<TaskNotifyChannel, string>>(() => loadNotifyWebhooks());
  const [testing, setTesting] = useState<TaskNotifyChannel | null>(null);
  const [status, setStatus] = useState<Partial<Record<TaskNotifyChannel, { ok: boolean; text: string }>>>({});

  const [cloud, setCloud] = useState<CloudPushConfig>(() => cachedCloudPushConfig());
  const [cloudSaving, setCloudSaving] = useState(false);
  const [cloudChecking, setCloudChecking] = useState(false);
  const [cloudTesting, setCloudTesting] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<{ ok: boolean; text: string } | null>(null);
  // 预检发现令牌缺权限时，给一个直接跳到「同步 → 更新授权令牌」的入口
  const [cloudNeedsToken, setCloudNeedsToken] = useState(false);

  // 云端推送只支持 GitHub；GitCode 的定时任务会悄悄丢注册，普通平台不再显示入口。
  // 历史上开过的旧配置仍保留入口，方便关闭并删除遗留工作流。
  const supportedPlatform = gitCfg?.provider === 'github';
  const cloudSupported = supportedPlatform || cloud.enabled;
  const activeTab = cloudSupported ? tab : 'local';

  useEffect(() => {
    if (!cloudSupported && tab === 'cloud') setTab('local');
  }, [cloudSupported, tab]);

  // 待办详情的「修改配置」要直接落在「云端推送」：模块级标记负责首次挂载，
  // 这里再监听一次事件，覆盖设置页已经开着、或热更新换了一份模块实例的情况
  useEffect(() => {
    const onJump = (e: Event) => {
      const want = (e as CustomEvent).detail;
      if (want === 'cloud' || want === 'local') setTab(want);
    };
    window.addEventListener('glimnote:notify-tab', onJump);
    return () => window.removeEventListener('glimnote:notify-tab', onJump);
  }, []);

  useEffect(() => {
    void readCloudPushConfig();
    const onCfg = () => setCloud(cachedCloudPushConfig());
    window.addEventListener('glimnote:cloud-push-changed', onCfg);
    return () => window.removeEventListener('glimnote:cloud-push-changed', onCfg);
  }, []);

  /** 结果交给设置页脚，显示在「保存」按钮旁边；toast 在主窗右下角太容易被忽略 */
  const hintFooter = (text: string, ok = true) => {
    window.dispatchEvent(new CustomEvent('glimnote:notify-save-hint', { detail: { text, ok } }));
  };

  const save = (channel: TaskNotifyChannel, quiet = false) => {
    saveNotifyWebhook(channel, hooks[channel]);
    // 详情面板／提醒浮窗里的「未配置」标记读取的是 localStorage，通知它们重算
    window.dispatchEvent(new Event('glimnote:notify-pref'));
    if (!quiet) {
      const raw = NOTIFY_CHANNELS.find((c) => c.id === channel)?.label || tr('通知');
      const label = tr(raw);
      hintFooter(tr('{label} Webhook 已保存', { label }));
    }
  };

  const test = async (channel: TaskNotifyChannel) => {
    if (testing) return;
    save(channel, true);
    setTesting(channel);
    setStatus((prev) => ({ ...prev, [channel]: undefined }));
    try {
      await testNotifyChannel(channel);
      setStatus((prev) => ({ ...prev, [channel]: { ok: true, text: tr('已发送，去群里看看') } }));
      toast(tr('测试通知已发送'), 'success');
    } catch (e) {
      const text = (e as Error).message || tr('发送失败');
      setStatus((prev) => ({ ...prev, [channel]: { ok: false, text } }));
      toast(text, 'error');
    } finally {
      setTesting(null);
    }
  };

  /** 云端配置写进仓库文件；保存后立刻同步一次，工作流才会尽快出现在仓库里 */
  const saveCloud = async (next: CloudPushConfig, quiet = false, inline = false) => {
    if (cloudSaving) return false;
    const say = (text: string, kind: 'success' | 'warn' | 'error' | 'info' = 'success') => {
      if (inline) hintFooter(text, kind === 'success' || kind === 'info');
      else toast(text, kind);
    };
    const webhook = next.webhook.trim();
    if (next.enabled && !webhook) {
      say(tr('先填好群机器人 Webhook 再开启'), 'warn');
      return false;
    }
    if (webhook && !/^https?:\/\//i.test(webhook)) {
      say(tr('Webhook 地址要以 http:// 或 https:// 开头'), 'warn');
      return false;
    }
    // 关闭旧配置要放行，开启只允许 GitHub 仓库
    if (next.enabled && gitCfg?.provider !== 'github') {
      say(tr('云端推送目前只支持 GitHub 仓库'), 'warn');
      return false;
    }
    setCloudSaving(true);
    try {
      const state = useApp.getState();
      const tasks = state.tasksLoaded ? state.tasks : await loadTasks();
      // 从关闭切到开启时先查一次令牌权限：经典令牌缺 workflow 会直接拒绝推送，
      // 与其等同步失败，不如在这里拦住。细粒度令牌查不出来（返回 null），交给推送失败兜底。
      if (next.enabled && !cloud.enabled) {
        setCloudChecking(true);
        const perm = await checkGitHubWorkflowPermission(token);
        setCloudChecking(false);
        if (perm.allowed === false) {
          // 地址和时间照常保存，但保持关闭：没有权限时写入工作流会把笔记同步一起卡住
          await saveCloudPushConfig({ ...next, enabled: false }, tasks, gitCfg?.provider);
          setCloud(cachedCloudPushConfig());
          // 除了右下角提示，再在卡片里留一行结果，避免一眼看不到开关为什么又弹回去。
          // 把实际查到的 scope 列出来：多半是应用里存的还是旧令牌，或者修改后没点 Update token。
          setCloudNeedsToken(true);
          setCloudStatus({
            ok: false,
            text: perm.scopes.length
              ? tr('令牌缺少 workflow 权限（本机保存的令牌当前只有：{scopes}），云端推送未开启', {
                  scopes: perm.scopes.join('、'),
                })
              : tr('令牌缺少 workflow 权限，云端推送未开启'),
          });
          say(
            tr(
              '本机保存的这个令牌没有 workflow 权限，暂时无法开启云端推送。请在 GitHub 令牌页确认已勾选 workflow 并点过 Update token；如果令牌重新生成过，还要到「同步」页的「更新授权令牌」里粘贴保存一次。',
            ),
            'warn',
          );
          return false;
        }
      }
      await saveCloudPushConfig({ ...next, webhook }, tasks, gitCfg?.provider);
      setCloud(cachedCloudPushConfig());
      setCloudStatus(null);
      setCloudNeedsToken(false);
      if (!quiet) {
        // 开关动作和单纯保存地址是两种结果：关着的时候保存地址不该报「已关闭」，
        // 那听起来像保存失败；应该告诉用户地址已经存下了，只是要打开开关才生效。
        const toggled = next.enabled !== cloud.enabled;
        if (next.enabled) {
          say(toggled ? tr('云端推送已开启，正在同步配置') : tr('推送地址已保存，正在同步配置'));
        } else if (toggled) {
          say(tr('云端推送已关闭'));
        } else if (webhook) {
          say(tr('推送地址已保存，开启「云端推送」后才会生效'));
        } else {
          say(tr('推送地址已清空'));
        }
      }
      if (state.cfg && state.token) void state.syncNow(true);
      else if (!quiet) say(tr('配置已保存到本机，连接云端仓库并同步后才会生效'), 'info');
      return true;
    } catch (e) {
      // 开关是先乐观翻过去的；保存失败时退回真实状态，别让界面一直停在「已开启」
      setCloud(cachedCloudPushConfig());
      say((e as Error).message || tr('保存失败'), 'error');
      return false;
    } finally {
      setCloudSaving(false);
      setCloudChecking(false);
    }
  };

  const testCloud = async () => {
    if (cloudTesting) return;
    const webhook = cloud.webhook.trim();
    if (!webhook) {
      toast(tr('先填好群机器人 Webhook 再测试'), 'warn');
      return;
    }
    setCloudTesting(true);
    setCloudStatus(null);
    try {
      await testCloudPush({ ...cloud, webhook });
      setCloudStatus({ ok: true, text: tr('已发送，去群里看看') });
      toast(tr('测试消息已发送'), 'success');
    } catch (e) {
      const text = (e as Error).message || tr('发送失败');
      setCloudStatus({ ok: false, text });
      toast(text, 'error');
    } finally {
      setCloudTesting(false);
    }
  };

  const channelLabel = (id: TaskNotifyChannel) => tr(NOTIFY_CHANNELS.find((c) => c.id === id)?.label || '企业微信');

  // 保存按钮统一在弹窗底部（设置页脚），这里按当前标签页决定保存什么：
  // 本地页把三个 Webhook 一起写回，云端页提交整张推送配置。
  const saveAll = () => {
    if (activeTab === 'cloud') {
      // 旧平台没有可保存的配置，只能关闭；别让底部的「保存」把工作流又写回去
      if (!supportedPlatform) {
        hintFooter(tr('旧版云端推送只能用上面的「关闭并删除工作流」'), false);
        return;
      }
      void saveCloud(cloud, false, true);
      return;
    }
    NOTIFY_CHANNELS.forEach((channel) => save(channel.id, true));
    hintFooter(tr('本地通知设置已保存'));
  };

  useEffect(() => {
    const onSave = () => saveAll();
    window.addEventListener('glimnote:notify-save', onSave);
    return () => window.removeEventListener('glimnote:notify-save', onSave);
  });

  return (
    <>
      {cloudSupported && (
        <div className="segment notify-tabs" role="tablist" aria-label={tr('通知方式')}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'local'}
            className={cn(activeTab === 'local' && 'on')}
            onClick={() => setTab('local')}
          >
            <Bell size={14} />
            {tr('本地通知')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'cloud'}
            className={cn(activeTab === 'cloud' && 'on')}
            onClick={() => setTab('cloud')}
          >
            <Cloud size={14} />
            {tr('云端推送')}
          </button>
        </div>
      )}

      {activeTab === 'local' && (
        <>
          <div className="ai-intro">
            <Bell size={16} strokeWidth={1.75} />
            <div>
              {tr(
                '到点时先在桌面右下角提醒；配好下面的群机器人后，还可以在每条待办的「到点提醒」里勾选企业微信、飞书或钉钉，让提醒同时发到群里。Webhook 地址只保存在这台设备上，不会进 Git 仓库。',
              )}
            </div>
          </div>

          {NOTIFY_CHANNELS.map((channel) => {
            const state = status[channel.id];
            return (
              <div className="notify-channel" key={channel.id}>
                <div className="notify-head">
                  <span className="notify-name">{tr(channel.label)}</span>
                  {hooks[channel.id].trim() ? <span className="notify-badge">{tr('已填写')}</span> : null}
                </div>
                <div className="set-desc">{tr(channel.desc)}</div>
                <div className="notify-input-row">
                  <input
                    className="input"
                    value={hooks[channel.id]}
                    placeholder={channel.placeholder}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label={tr('{label} Webhook 地址', { label: tr(channel.label) })}
                    onChange={(e) => {
                      setHooks((prev) => ({ ...prev, [channel.id]: e.target.value }));
                      setStatus((prev) => ({ ...prev, [channel.id]: undefined }));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        save(channel.id);
                      }
                    }}
                  />
                  <button
                    className="btn btn-secondary"
                    onClick={() => void test(channel.id)}
                    disabled={Boolean(testing)}
                  >
                    {testing === channel.id ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                    {tr('测试')}
                  </button>
                </div>
                {state && (
                  <div className={cn('notify-status', state.ok ? 'ok' : 'bad')}>
                    {state.ok ? <Check size={13} /> : <X size={13} />}
                    {state.text}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {cloudSupported &&
        activeTab === 'cloud' &&
        (supportedPlatform ? (
          <>
            <div className="ai-intro">
              <Cloud size={16} strokeWidth={1.75} />
              <div>
                {tr(
                  '由仓库的定时流水线每天汇总推送一次，电脑没开、应用没运行也能收到。只推送在待办详情里勾了「云端推送」的任务；勾选不会停掉本机的到点提醒和群通知。配置会写进仓库的 .glimnote/ 目录，所以仓库必须是私有的。',
                )}
              </div>
            </div>

            <div className="notify-channel cloud-push-card">
              <div className="notify-head">
                <span className="notify-name">{tr('启用每日汇总')}</span>
                {cloudChecking ? (
                  <span className="notify-badge">{tr('检查中')}</span>
                ) : cloud.enabled ? (
                  <span className="notify-badge">{tr('已开启')}</span>
                ) : null}
                <span className="grow" />
                <button
                  className={cn('switch', cloud.enabled && 'on')}
                  role="switch"
                  aria-checked={cloud.enabled}
                  title={cloud.enabled ? tr('关闭云端推送') : tr('开启云端推送')}
                  disabled={cloudSaving}
                  onClick={() => {
                    const next = { ...cloud, enabled: !cloud.enabled };
                    // 先让开关动起来，再去查权限；否则弱网下点完像卡住
                    setCloud(next);
                    setCloudStatus(null);
                    void saveCloud(next).then((ok) => {
                      if (!ok) setCloud(cachedCloudPushConfig());
                    });
                  }}
                />
              </div>

              {cloudChecking && (
                <div className="notify-status">
                  <Loader2 size={13} className="spin" />
                  {tr('正在检查令牌权限，最多几秒…')}
                </div>
              )}

              <div className="cloud-push-grid">
                <label className="cloud-push-field">
                  <span>{tr('机器人')}</span>
                  <div className="segment td-seg">
                    {NOTIFY_CHANNELS.map((channel) => (
                      <button
                        key={channel.id}
                        type="button"
                        className={cn(cloud.channel === channel.id && 'on')}
                        onClick={() => setCloud((prev) => ({ ...prev, channel: channel.id }))}
                      >
                        {tr(channel.label)}
                      </button>
                    ))}
                  </div>
                </label>
                <label className="cloud-push-field">
                  <span>{tr('每天推送时间')}</span>
                  <input
                    className="input"
                    type="time"
                    value={cloud.time}
                    onChange={(e) => setCloud((prev) => ({ ...prev, time: e.target.value }))}
                  />
                </label>
                <label className="cloud-push-field">
                  <span>{tr('推送窗口（小时）')}</span>
                  <input
                    className="input"
                    type="number"
                    min={CLOUD_PUSH_WINDOW_MIN}
                    max={CLOUD_PUSH_WINDOW_MAX}
                    step={1}
                    value={cloud.windowHours}
                    onChange={(e) =>
                      setCloud((prev) => ({
                        ...prev,
                        windowHours: Math.min(
                          CLOUD_PUSH_WINDOW_MAX,
                          Math.max(CLOUD_PUSH_WINDOW_MIN, Number(e.target.value) || CLOUD_PUSH_WINDOW_MIN),
                        ),
                      }))
                    }
                  />
                </label>
              </div>

              <div className="set-desc">
                {tr(
                  '窗口从推送时间往后算，最小 24 小时；设为 48 小时时，同一条待办可能连续两天都出现在汇总里。时间按北京时间计算。',
                )}
              </div>

              <div className="notify-input-row">
                <input
                  className="input"
                  value={cloud.webhook}
                  placeholder={NOTIFY_CHANNELS.find((c) => c.id === cloud.channel)?.placeholder || 'https://…'}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label={tr('{label} Webhook 地址', { label: channelLabel(cloud.channel) })}
                  onChange={(e) => {
                    setCloud((prev) => ({ ...prev, webhook: e.target.value }));
                    setCloudStatus(null);
                  }}
                />
                <button className="btn btn-secondary" onClick={() => void testCloud()} disabled={cloudTesting}>
                  {cloudTesting ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                  {tr('测试')}
                </button>
              </div>

              {cloudStatus && (
                <div className={cn('notify-status', cloudStatus.ok ? 'ok' : 'bad')}>
                  {cloudStatus.ok ? <Check size={13} /> : <X size={13} />}
                  {cloudStatus.text}
                </div>
              )}

              {cloudNeedsToken && (
                <button className="btn btn-secondary" onClick={() => setSettings(true, 'sync')}>
                  <KeyRound size={14} /> {tr('去同步页更新令牌')}
                </button>
              )}

              <div className="td-time-hint td-notify-hint">
                {cloud.enabled
                  ? tr('每天 {time}（北京时间）推送 {hours} 小时内到期的待办；推送前会自动同步一次。', {
                      time: cloud.time,
                      hours: cloud.windowHours,
                    })
                  : tr('开启后，仓库里会自动生成定时工作流和推送脚本。')}
              </div>

              <div className="cloud-risk">
                <AlertTriangle size={16} strokeWidth={1.75} />
                <div>
                  <b>{tr('使用前请了解这些限制')}</b>
                  <p>
                    {tr(
                      '依赖 Git 平台的免费定时任务：消息可能延迟或发送失败，摘要也可能不是最新。请不要把它当作唯一提醒，重要任务仍以本机到点提醒为准。',
                    )}
                  </p>
                  <p>
                    {tr(
                      '保存后会提交到 GitHub 仓库：.glimnote/push.json、digest.json、push.mjs 和 .github/workflows/glimnote-push.yml。工作流默认只认主分支，定时任务可能比设定时间晚几分钟启动；仓库长期没有活动时，GitHub 也可能暂停定时任务，同步一次即可恢复。',
                    )}
                  </p>
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="ai-intro">
              <Cloud size={16} strokeWidth={1.75} />
              <div>
                {tr(
                  '这个工作区连接的不是 GitHub。GitCode 的云端定时任务不稳定，新版本已停止支持；开启中的旧配置会在下次同步时自动关闭，并删除仓库里的工作流、摘要和发送脚本。也可以现在点下面的按钮立即关闭。',
                )}
              </div>
            </div>

            <div className="notify-channel cloud-push-card">
              <div className="notify-head">
                <span className="notify-name">{tr('云端推送（旧配置）')}</span>
                <span className="notify-badge">{tr('运行中')}</span>
              </div>
              <div className="set-desc">
                {tr(
                  '仓库：{repo} · 配置时间 {time}（北京时间）。同一群里每天收到两条汇总，通常就是有两个仓库都开着云端推送，这里是其中一个。',
                  {
                    repo: [gitCfg?.owner, gitCfg?.repo].filter(Boolean).join('/') || tr('未知仓库'),
                    time: cloud.time,
                  },
                )}
              </div>

              <div className="td-time-hint td-notify-hint">
                {tr(
                  '关闭后需要同步一次，删除才会提交到远端；如果同步失败，也可以到仓库网页手动删除 .gitcode/workflows/glimnote-push.yml。',
                )}
              </div>

              <div className="sync-warn-actions">
                <button
                  className="btn btn-danger"
                  onClick={() => void saveCloud({ ...cloud, enabled: false })}
                  disabled={cloudSaving}
                >
                  {cloudSaving ? <Loader2 size={14} className="spin" /> : <X size={14} />}
                  {tr('关闭并删除工作流')}
                </button>
              </div>

              {cloudStatus && (
                <div className={cn('notify-status', cloudStatus.ok ? 'ok' : 'bad')}>
                  {cloudStatus.ok ? <Check size={13} /> : <X size={13} />}
                  {cloudStatus.text}
                </div>
              )}
            </div>
          </>
        ))}

      <div className="token-warn">
        {tr(
          '网页版可能被浏览器的跨域策略拦住，发送失败时请改用桌面客户端。群机器人开启「加签」时，请直接把带签名的完整地址粘贴进来。',
        )}
      </div>
    </>
  );
}
