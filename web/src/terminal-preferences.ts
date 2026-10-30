export const FONT_SIZE_KEY = "workdeck.terminal.fontSize";
export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 24;

export function parseFontSize(value: string | null): number {
  if (value === null || value.trim() === "") return DEFAULT_FONT_SIZE;
  const size = Number(value);
  return Number.isInteger(size) &&
    size >= MIN_FONT_SIZE &&
    size <= MAX_FONT_SIZE
    ? size
    : DEFAULT_FONT_SIZE;
}
export function readFontSize(): number {
  try {
    return parseFontSize(localStorage.getItem(FONT_SIZE_KEY));
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}
export function saveFontSize(size: number) {
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(size));
  } catch {}
}
