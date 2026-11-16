import type { ReactNode, RefObject } from 'react';
import { APP_COLORS, type AppColor } from '../lib/apps';
import { HOME_ICON_OPTIONS, iconFor } from './homeIcons';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18n';

export interface AppMetaDraft {
  name: string;
  description: string;
  icon: string;
  color: AppColor;
}

interface Props {
  value: AppMetaDraft;
  onChange: (patch: Partial<AppMetaDraft>) => void;
  nameRef?: RefObject<HTMLInputElement>;
  autoFocusName?: boolean;
  /** 放在「一句话说明」和「图标」之间，例如生成页的分组选择 */
  children?: ReactNode;
}

/** 应用名称 / 说明 / 图标 / 颜色。生成页的应用信息卡和首页「编辑应用信息」共用同一套表单。 */
export function AppMetaFields({ value, onChange, nameRef, autoFocusName, children }: Props) {
  const tr = useT();
  return (
    <>
      <div className="field">
        <label>{tr('名称')}</label>
        <input
          ref={nameRef}
          className="input"
          value={value.name}
          maxLength={20}
          placeholder={tr('建议 2–12 个字')}
          autoFocus={autoFocusName}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </div>
      <div className="field">
        <label>{tr('一句话说明')}</label>
        <input
          className="input"
          value={value.description}
          maxLength={160}
          placeholder={tr('它会出现在入口卡片的副标题里')}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>
      {children}
      <div className="field">
        <label>{tr('图标')}</label>
        <div className="home-icon-grid compact">
          {HOME_ICON_OPTIONS.map((key) => {
            const Icon = iconFor(key, 'sparkles');
            return (
              <button
                key={key}
                type="button"
                className={cn('home-icon-btn', value.icon === key && 'on')}
                title={key}
                aria-label={key}
                onClick={() => onChange({ icon: key })}
              >
                <Icon size={15} strokeWidth={1.75} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="field">
        <label>{tr('颜色')}</label>
        <div className="home-color-row">
          {APP_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={cn('home-color-dot', `hc-${color}`, value.color === color && 'on')}
              title={color}
              aria-label={color}
              onClick={() => onChange({ color })}
            />
          ))}
        </div>
      </div>
    </>
  );
}
