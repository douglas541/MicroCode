// Temporarily take ownership of the terminal without closing the chat readline.
// Pausing the stream alone is insufficient: readline still owns keypress events.
export function captureKeys({
  input,
  rl,
  onKey,
  render = () => {},
  signal,
  onCleanup = () => {},
  registerCancel = () => {},
}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const previousListeners = input.listeners("keypress");
    const previousRaw = Boolean(input.isRaw);
    let finished = false;
    rl.pause();
    for (const listener of previousListeners)
      input.removeListener("keypress", listener);
    const finish = (value, error) => {
      if (finished) return;
      finished = true;
      input.removeListener("keypress", keypress);
      input.removeListener("end", ended);
      signal?.removeEventListener("abort", aborted);
      registerCancel(null);
      for (const listener of previousListeners) input.on("keypress", listener);
      input.setRawMode?.(previousRaw);
      rl.line = "";
      rl.cursor = 0;
      if (!rl.closed) rl.resume();
      onCleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const keypress = (text, key = {}) => {
      try {
        const result = onKey(text || "", key);
        if (result?.done) finish(result.value);
        else if (!finished) render();
      } catch (error) {
        finish(null, error);
      }
    };
    const ended = () => finish(null);
    const aborted = () => finish(null, signal.reason);
    input.on("keypress", keypress);
    input.once("end", ended);
    signal?.addEventListener("abort", aborted, { once: true });
    registerCancel(() => finish(null));
    input.setRawMode?.(true);
    input.resume();
    render();
  });
}

export function printable(text, key) {
  if (key.ctrl || key.meta || text.includes("\x1b")) return "";
  return text.replace(/[\x00-\x1f\x7f]/g, "");
}
