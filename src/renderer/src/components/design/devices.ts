// Preview widths: desktop fills the pane; the others are CSS pixel widths,
// scaled down to fit when the pane is narrower.
export type Device = { id: 'desktop' | 'tablet' | 'phone'; label: string; width: number }
export const DEVICES: Device[] = [
  { id: 'desktop', label: 'Desktop', width: 0 },
  { id: 'tablet', label: 'Tablet', width: 820 },
  { id: 'phone', label: 'Phone', width: 390 }
]
