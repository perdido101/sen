/**
 * Rolling 12-second capture of the canvas. On death or a badge unlock we can
 * offer "Save clip" - Web Share where available, download fallback.
 *
 * This is the growth loop, so it must never cost frames: MediaRecorder pulls
 * straight off the canvas stream on its own thread.
 */

const WINDOW_MS = 12000;

function pickMime(): string | null {
  const candidates = [
    'video/mp4;codecs=avc1',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

export class ClipRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: { t: number; blob: Blob }[] = [];
  private mime = '';
  supported = false;

  start(canvas: HTMLCanvasElement): void {
    if (this.rec !== null) return;
    const mime = pickMime();
    if (mime === null || typeof canvas.captureStream !== 'function') return;
    try {
      const stream = canvas.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
      rec.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        const now = performance.now();
        this.chunks.push({ t: now, blob: e.data });
        // Keep only the trailing window.
        while (this.chunks.length > 2 && now - this.chunks[0].t > WINDOW_MS) this.chunks.shift();
      };
      rec.start(1000);
      this.rec = rec;
      this.mime = mime;
      this.supported = true;
    } catch {
      this.supported = false;
    }
  }

  stop(): void {
    try {
      this.rec?.stop();
    } catch {
      // already stopped
    }
    this.rec = null;
    this.chunks.length = 0;
  }

  get hasClip(): boolean {
    return this.supported && this.chunks.length > 1;
  }

  private blob(): Blob | null {
    if (!this.hasClip) return null;
    return new Blob(this.chunks.map((c) => c.blob), { type: this.mime });
  }

  /** Returns true if the clip was handed off to the OS or downloaded. */
  async save(filename = 'superelnino-clip'): Promise<boolean> {
    const blob = this.blob();
    if (blob === null) return false;
    const ext = this.mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const file = new File([blob], `${filename}.${ext}`, { type: this.mime });

    if (
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] }) &&
      typeof navigator.share === 'function'
    ) {
      try {
        await navigator.share({ files: [file], title: 'Super El Nino' });
        return true;
      } catch {
        // User cancelled, or share failed - fall through to download.
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  }
}
