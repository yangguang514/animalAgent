// 给外部 HTTP 请求统一加超时，避免 LLM 或工具接口长时间卡住对话。
export async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  // 内部 controller 同时承接调用方取消和本地超时，fetch 最终只需要监听一个 signal。
  const externalSignal = options?.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms.`)),
    timeoutMs
  );
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    // 无论请求成功还是失败都移除监听器，避免长会话累计 AbortSignal 回调。
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}
