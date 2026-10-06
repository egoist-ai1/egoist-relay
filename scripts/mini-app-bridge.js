(() => {
    if (window.top !== window || !window.chrome?.webview)
        return;
    const nonce = '__RELAY_MINI_APP_NONCE__';
    const pendingInbound = [];
    const pendingOutbound = [];
    let generation;
    function post(event) {
        if (!generation) {
            if (pendingInbound.length < 64)
                pendingInbound.push(event);
            return;
        }
        window.chrome.webview.postMessage(`${nonce}:${JSON.stringify({ ...event, generation })}`);
    }
    function deliver(data) {
        if (data.nonce !== nonce || (generation && data.generation !== generation))
            return;
        const receive = window.Telegram?.WebView?.receiveEvent;
        if (!generation || typeof receive !== 'function') {
            if (pendingOutbound.length < 64)
                pendingOutbound.push(data);
            return;
        }
        receive(data.event.eventType, data.event.eventData);
    }
    function flush() {
        if (!generation)
            return;
        pendingInbound.splice(0).forEach(post);
        if (typeof window.Telegram?.WebView?.receiveEvent === 'function')
            pendingOutbound.splice(0).forEach(deliver);
    }
    Object.defineProperty(window, '__egoistRelayMiniAppBind', { value(value) {
            if (generation || typeof value !== 'string')
                return;
            generation = value;
            flush();
        } });
    Object.defineProperty(window, 'TelegramWebviewProxy', {
        value: Object.freeze({ postEvent(eventType, data) {
                if (typeof eventType !== 'string')
                    return;
                try {
                    const eventData = typeof data === 'string' && data ? JSON.parse(data) : data;
                    post({ eventType, eventData });
                    flush();
                }
                catch { /* Invalid Mini App messages are ignored */ }
            } }),
        writable: false,
        configurable: false,
    });
    window.chrome.webview.addEventListener('message', ({ data }) => {
        if (typeof data?.event?.eventType !== 'string')
            return;
        deliver(data);
    });
    document.addEventListener('DOMContentLoaded', flush, { once: true });
})();
