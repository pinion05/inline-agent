import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from "@earendil-works/pi-tui";

export interface InlineTuiTheme {
  accent: (text: string) => string;
  text: (text: string) => string;
  muted: (text: string) => string;
  success: (text: string) => string;
  warning: (text: string) => string;
  error: (text: string) => string;
  bold: (text: string) => string;
  userBg: (text: string) => string;
  toolBg: (text: string) => string;
  assistantBg: (text: string) => string;
  errorBg: (text: string) => string;
  editor: EditorTheme;
  selectList: SelectListTheme;
  markdown: MarkdownTheme;
}

export function createTuiTheme(
  colors: boolean = process.env.NO_COLOR === undefined,
): InlineTuiTheme {
  const fg = (code: number) => style(`\x1b[38;5;${code}m`, "\x1b[39m", colors);
  const bg = (code: number) => style(`\x1b[48;5;${code}m`, "\x1b[49m", colors);
  const bold = style("\x1b[1m", "\x1b[22m", colors);
  const italic = style("\x1b[3m", "\x1b[23m", colors);
  const strikethrough = style("\x1b[9m", "\x1b[29m", colors);
  const underline = style("\x1b[4m", "\x1b[24m", colors);

  const accent = fg(75);
  const text = fg(252);
  const muted = fg(245);
  const success = fg(114);
  const warning = fg(221);
  const error = fg(210);
  const selectList: SelectListTheme = {
    selectedPrefix: accent,
    selectedText: (value) => bold(accent(value)),
    description: muted,
    scrollInfo: muted,
    noMatch: warning,
  };

  return {
    accent,
    text,
    muted,
    success,
    warning,
    error,
    bold,
    userBg: bg(24),
    toolBg: bg(58),
    assistantBg: bg(22),
    errorBg: bg(52),
    editor: {
      borderColor: accent,
      selectList,
    },
    selectList,
    markdown: {
      heading: (value) => bold(accent(value)),
      link: accent,
      linkUrl: muted,
      code: warning,
      codeBlock: text,
      codeBlockBorder: muted,
      quote: text,
      quoteBorder: muted,
      hr: muted,
      listBullet: accent,
      bold,
      italic,
      strikethrough,
      underline,
    },
  };
}

export const tuiTheme = createTuiTheme();

function style(
  open: string,
  close: string,
  enabled: boolean,
): (text: string) => string {
  return enabled ? (text) => `${open}${text}${close}` : (text) => text;
}
