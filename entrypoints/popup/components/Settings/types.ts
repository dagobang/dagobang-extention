import type { Dispatch, SetStateAction } from 'react';
import type { Settings } from '@/types/extention';

export type TFunc = (key: string, subs?: Array<string | number>) => string;

export type SettingsDraftProps = {
  settingsDraft: Settings;
  setSettingsDraft: Dispatch<SetStateAction<Settings>>;
  tt: TFunc;
  busy: boolean;
};

export type SettingsSectionId = 'root' | 'network' | 'trade' | 'gas' | 'notification' | 'security';
