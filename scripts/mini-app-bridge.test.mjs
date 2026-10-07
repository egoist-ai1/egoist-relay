import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
const script = readFileSync(new URL('./mini-app-bridge.js', import.meta.url), 'utf8')
    .replace("'__RELAY_MINI_APP_NONCE__'", JSON.stringify('owned-session'));
function frame() {
    const dom = new JSDOM('', { url: 'https://shop.example/#tgWebAppData=query_id%3Dsynthetic-only&tgWebAppVersion=9.1&tgWebAppPlatform=weba',
        runScripts: 'outside-only' });
    const posted = [];
    let receive;
    const { window } = dom;
    window.chrome = { webview: {
            postMessage(data) { posted.push(JSON.parse(data.slice('owned-session:'.length))); },
            addEventListener(name, callback) { assert.equal(name, 'message'); receive = callback; },
        } };
    window.eval(script);
    return { window, posted, receive: (data) => receive({ data }), close: () => window.close() };
}
test('SDK startup events wait for the current native navigation binding', () => {
    const f = frame();
    f.window.TelegramWebviewProxy.postEvent('web_app_ready', '{}');
    assert.equal(f.posted.length, 0);
    f.window.__egoistRelayMiniAppBind('7');
    assert.equal(f.posted[0].eventType, 'web_app_ready');
    assert.equal(f.posted[0].generation, '7');
    f.window.__egoistRelayMiniAppBind('8');
    f.window.TelegramWebviewProxy.postEvent('web_app_request_theme', '');
    assert.equal(f.posted[1].generation, '7');
    f.close();
});
test('outbound events require the host nonce and navigation generation', () => {
    const f = frame();
    const received = [];
    f.window.Telegram = { WebView: { receiveEvent: (...args) => received.push(args) } };
    f.window.__egoistRelayMiniAppBind('9');
    const event = { eventType: 'theme_changed', eventData: { theme_params: { bg_color: '#000000' } } };
    f.receive({ nonce: 'foreign', generation: '9', event });
    f.receive({ nonce: 'owned-session', generation: '8', event });
    assert.equal(received.length, 0);
    f.receive({ nonce: 'owned-session', generation: '9', event });
    assert.equal(received.length, 1);
    assert.equal(received[0][0], 'theme_changed');
    assert.equal(received[0][1].theme_params.bg_color, '#000000');
    f.close();
});
test('queues are bounded and malformed data does not reach native', () => {
    const f = frame();
    f.window.TelegramWebviewProxy.postEvent('web_app_ready', '{broken');
    for (let i = 0; i < 100; i += 1)
        f.window.TelegramWebviewProxy.postEvent('web_app_request_viewport', '{}');
    f.window.__egoistRelayMiniAppBind('1');
    assert.equal(f.posted.length, 64);
    f.close();
});
test('the official Telegram SDK uses the native bridge and receives host events', {
    skip: !process.env.RELAY_MINI_APP_SDK_FIXTURE,
}, () => {
    const f = frame();
    f.window.eval(readFileSync(process.env.RELAY_MINI_APP_SDK_FIXTURE, 'utf8'));
    f.window.__egoistRelayMiniAppBind('2');
    assert.equal(f.window.Telegram.WebView.isIframe, false);
  assert.equal(f.window.Telegram.WebApp.platform, 'weba');
  assert.equal(f.window.Telegram.WebApp.initData, 'query_id=synthetic-only');
  f.window.Telegram.WebApp.ready();
    assert.ok(f.posted.some((event) => event.eventType === 'web_app_ready'));
    f.receive({ nonce: 'owned-session', generation: '2', event: {
            eventType: 'theme_changed', eventData: { theme_params: { bg_color: '#000000', text_color: '#ffffff' } },
        } });
    assert.equal(f.window.Telegram.WebApp.themeParams.bg_color, '#000000');
    f.receive({ nonce: 'owned-session', generation: '2', event: {
    eventType: 'viewport_changed', eventData: { height: 360, width: 320, is_state_stable: true, is_expanded: true },
  } });
  assert.equal(f.window.Telegram.WebApp.viewportStableHeight, 360);
  f.window.Telegram.WebApp.close();
    assert.ok(f.posted.some((event) => event.eventType === 'web_app_close'));
    f.close();
});
