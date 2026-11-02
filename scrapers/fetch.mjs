const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const fetchWithRetry = async (url, retries = 1) => {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15000)
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    if (retries > 0) {
      return fetchWithRetry(url, retries - 1);
    }
    return { status: "ERR " + e.message, text: "" };
  }
};

export { fetchWithRetry };
