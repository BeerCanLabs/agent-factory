export type ProxyMode = 'LIVE' | 'PAUSED' | 'ISOLATED' | 'THROTTLED';

export class KillSwitch {
  mode: ProxyMode = 'LIVE';
  tokensPerMinute = 0;
  private windowStart = Date.now();
  private windowTokens = 0;
  private readonly throttleLimit: number;

  constructor(throttleLimit = 60) {
    this.throttleLimit = throttleLimit;
  }

  apply(command: string): ProxyMode {
    switch (command.toUpperCase()) {
      case 'PAUSE':
        this.mode = 'PAUSED';
        break;
      case 'RESUME':
        this.mode = 'LIVE';
        break;
      case 'ISOLATE':
        this.mode = 'ISOLATED';
        break;
      case 'THROTTLE':
        this.mode = 'THROTTLED';
        break;
      default:
        break;
    }
    return this.mode;
  }

  allow(tokens = 0): { ok: boolean; status: number; reason: string } {
    if (this.mode === 'PAUSED') return { ok: false, status: 503, reason: 'paused' };
    if (this.mode === 'ISOLATED') return { ok: false, status: 403, reason: 'isolated' };
    if (this.mode === 'THROTTLED') {
      this.rotate();
      if (this.windowTokens + tokens > this.throttleLimit) {
        return { ok: false, status: 429, reason: 'throttled' };
      }
    }
    return { ok: true, status: 200, reason: 'ok' };
  }

  record(tokens: number) {
    this.rotate();
    this.windowTokens += tokens;
    this.tokensPerMinute = this.windowTokens;
  }

  private rotate() {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.windowTokens = 0;
    }
  }
}
