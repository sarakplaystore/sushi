/**
 * Turns a made QR code into a single SVG path — the shape `DonateModal` paints.
 *
 * Runs on the bare minimum of the generator's API (`getModuleCount` / `isDark`)
 * so the dialog can keep `qrcode-generator` in a lazily loaded chunk, and the
 * test suite can feed it the real generator and decode the result back.
 *
 * Each horizontal run of dark modules becomes one rect, so a 33×33 code is a
 * few hundred characters instead of a thousand `<rect>` elements.
 */
export interface QrModuleSource {
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

export function qrSvgPath(qr: QrModuleSource): { path: string; moduleCount: number } {
  const count = qr.getModuleCount();
  let path = "";
  for (let row = 0; row < count; row += 1) {
    let col = 0;
    while (col < count) {
      if (!qr.isDark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < count && qr.isDark(row, col)) col += 1;
      path += `M${start} ${row}h${col - start}v1h-${col - start}z`;
    }
  }
  return { path, moduleCount: count };
}

/** View-box that leaves a 1-module quiet-ish border around the code. */
export function qrSvgViewBox(moduleCount: number, border = 2): string {
  return `${-border} ${-border} ${moduleCount + border * 2} ${moduleCount + border * 2}`;
}
