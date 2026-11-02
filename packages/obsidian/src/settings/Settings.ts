import { OBSIDIAN_THEME_IDENTIFIER } from 'packages/obsidian/src/themes/ThemeMapper';

export enum FrameType {
	Code = 'code',
	Terminal = 'terminal',
	None = 'none',
	Auto = 'auto',
}

export interface Settings {
	disabledLanguages: string[];
	customThemeFolder: string;
	customLanguageFolder: string;
	/**
	 * Old theme setting, from before we had separate light/dark theme settings. Will me migrated on load.
	 */
	theme: string | undefined;
	darkTheme: string;
	lightTheme: string;
	preferThemeColors: boolean;
	inlineHighlighting: boolean;
	livePreviewEcRendering: boolean;
	ecDefaultShowLineNumbers: boolean;
	ecDefaultWrap: boolean;
	ecDefaultFrame: FrameType;
}

export const DEFAULT_SETTINGS: Settings = {
	disabledLanguages: [],
	customThemeFolder: '',
	customLanguageFolder: '',
	theme: undefined,
	darkTheme: OBSIDIAN_THEME_IDENTIFIER,
	lightTheme: OBSIDIAN_THEME_IDENTIFIER,
	preferThemeColors: true,
	inlineHighlighting: true,
	livePreviewEcRendering: true,
	ecDefaultShowLineNumbers: false,
	ecDefaultWrap: false,
	ecDefaultFrame: FrameType.Auto,
};
