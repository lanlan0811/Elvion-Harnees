import { ElvionError } from './errors.js';

function cancellationReason(signal: AbortSignal): ElvionError {
  const reason: unknown = signal.reason;
  if (reason instanceof ElvionError && ['cancelled', 'timeout'].includes(reason.code)) return reason;
  return new ElvionError('cancelled', 'Operation cancelled', { cause: reason });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancellationReason(signal);
}

/** Local cancellation and deadlines; aborting never promises remote processing stopped. */
export class CancellationScope {
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #parent: AbortSignal | undefined;
  #parentListener: (() => void) | undefined;

  constructor(options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)
    ) {
      throw new ElvionError('validation_error', 'Timeout must be a positive safe timer duration');
    }
    this.signal = this.#controller.signal;
    if (options.signal) {
      this.#parent = options.signal;
      this.#parentListener = () => {
        this.#controller.abort(cancellationReason(options.signal as AbortSignal));
        this.dispose();
      };
      if (options.signal.aborted) {
        this.#parentListener();
      } else {
        options.signal.addEventListener('abort', this.#parentListener, { once: true });
      }
    }
    if (!this.signal.aborted && options.timeoutMs !== undefined) {
      this.#timer = setTimeout(() => {
        this.#controller.abort(new ElvionError('timeout', 'Operation timed out'));
        this.dispose();
      }, options.timeoutMs);
      this.#timer.unref();
    }
  }

  cancel(): void {
    this.#controller.abort(new ElvionError('cancelled', 'Operation cancelled'));
    this.dispose();
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#parent && this.#parentListener) {
      this.#parent.removeEventListener('abort', this.#parentListener);
    }
    this.#timer = undefined;
    this.#parent = undefined;
    this.#parentListener = undefined;
  }
}

/** Stop awaiting on cancellation. The caller still owns stopping the underlying side effect. */
export async function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let listener: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = () => reject(cancellationReason(signal));
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}
