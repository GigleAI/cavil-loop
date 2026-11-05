/** Readable text color on a GitHub label background (hex without '#'). */
export function textColor(hex: string) {
  if (!/^[0-9a-f]{6}$/i.test(hex)) return '#000';
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#1f2328' : '#fff';
}
