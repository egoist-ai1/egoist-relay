import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { initializeAuditBrowser, project } from './relay-ui-audit.server.mjs';
import { startComposerMediaServer } from './relay-composer-media.server.fixture.mjs';
const output = process.env.RELAY_COMPOSER_MEDIA_OUTPUT;
const evidence = process.env.RELAY_COMPOSER_MEDIA_EVIDENCE;
const executable = process.env.RELAY_UI_AUDIT_BROWSER;
if (!output || !evidence || !executable)
    throw new Error('Own work, project evidence and existing headless browser required');
await mkdir(output, { recursive: true });
await mkdir(evidence, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
    schemaVersion: 1, artifactId: 'relay-composer-media-audit-2026-10-02', version: 1, generatedAt: new Date().toISOString(), projectPath: project, sourcePackageVersion: JSON.parse(await readFile('package.json', 'utf8')).version, candidateKind: 'NEXT working tree, not the immutable canonical package',
    environment: {
        actualApp: true, transport: 'existing MockClient + protected action recorder', headless: true, externalRequests: 'blocked', viewport: '1920x1080 + 640x900 emulations', realUploads: 0, realMessages: 0, realDeletes: 0, realPayments: 0
    }, cases: [], pageErrors: [], consoleErrors: [], sources: {}, inputs: [], gates: ['Live upload/download/send acceptance and throughput remain unverified; no account effects run', 'Document upload/download progress is synthetic props on the actual Document/File components; actual network transfer is not measured']
};
const sourcePaths = ['src/components/common/Composer.tsx', 'src/components/middle/composer/AttachMenu.tsx', 'src/components/middle/composer/AttachmentModal.tsx', 'src/components/middle/composer/AttachmentModalItem.tsx', 'src/components/middle/composer/hooks/useAttachmentModal.ts', 'src/components/middle/composer/helpers/buildAttachment.ts', 'src/components/ui/mediaEditor/MediaEditor.tsx', 'src/components/ui/mediaEditor/MediaEditor.module.scss', 'src/components/common/Titlebar.module.scss', 'src/components/common/Document.tsx', 'src/components/common/File.tsx', 'src/components/common/DocumentReaderModal.tsx', 'src/util/files.ts', 'scripts/relay-composer-media.fixture.tsx', 'scripts/relay-composer-media.server.fixture.mjs', 'scripts/relay-composer-media.test.mjs'];
for (const source of sourcePaths) {
    const bytes = await readFile(source);
    report.sources[source] = { bytes: bytes.length, sha256: sha(bytes) };
}
const documentBytes = Buffer.from('Owned research fixture\nAlpha source\nAlpha comparison\nNo external content.\n');
await writeFile(path.join(output, 'owned-research.txt'), documentBytes);
const bin = Buffer.alloc(65537);
for (let index = 0; index < bin.length; index++)
    bin[index] = (index * 37 + 11) & 255;
const runFile = promisify(execFile);
const videoPath = path.join(output, 'owned-video.mp4');
const audioPath = path.join(output, 'owned-audio.wav');
await runFile(path.join(project, 'runtime/media/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=12', '-t', '1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', videoPath], { windowsHide: true, timeout: 20000 });
await runFile(path.join(project, 'runtime/media/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '1', '-c:a', 'pcm_s16le', audioPath], { windowsHide: true, timeout: 20000 });
const { server, url, counts } = await startComposerMediaServer(output);
let context;
let page;
const events = () => page.evaluate(() => window.__relayComposerMedia.events);
const count = async (name) => (await events()).filter(event => event.name === name).length;
const captures = () => page.evaluate(() => window.__relayComposerMedia.captures());
const settle = async () => page.waitForTimeout(350);
const attachment = () => page.locator('.modal-dialog').filter({ has: page.locator('#caption-input-text') });
async function close() {
    const editor = page.locator('[class*=MediaEditor][class*=root]').first();
    if (await editor.isVisible())
        await page.keyboard.press('Escape');
    await settle();
    await page.evaluate(() => {
        window.__relayComposerMedia.closeReader();
        window.__relayComposerMedia.closeTransfer();
    });
    for (let step = 0; step < 2; step++) {
        const cancel = page.getByRole('button', { name: 'Cancel attachments', exact: true });
        if (await cancel.count())
            await cancel.click().catch(() => {
            });
        await settle();
    }
}
async function choose(files, asFile = false) {
    await close();
    await page.evaluate(() => {
        window.__relayComposerMedia.protect();
        window.__relayComposerMedia.resetSettings();
    });
    await page.locator('#attach-menu-button').hover();
    await settle();
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
    chooser.catch(() => undefined);
    await page.locator(`.AttachMenu--menu .MenuItem:has(.icon-${asFile ? 'document' : 'photo'})`).click();
    await (await chooser).setFiles(files);
    await attachment().waitFor({ state: 'visible', timeout: 8000 });
    await settle();
    return attachment();
}
async function more(icon) {
    await attachment().getByRole('button', { name: 'More actions', exact: true }).click();
    const item = page.locator(`.MenuItem:visible:has(.icon-${icon})`).last();
    await item.click();
    await settle();
}
async function send() {
    const before = (await captures()).length;
    await attachment().locator('button[class*="__send"]').click();
    await page.waitForFunction(value => window.__relayComposerMedia.sends.length > value, before, { timeout: 5000 });
    return (await captures()).at(-1);
}
async function geometry(scope) {
    return scope.evaluate(element => {
        const win = window;
        const box = element.getBoundingClientRect().toJSON();
        const controls = Array.from(element.querySelectorAll('button,input,[role=button]')).filter(control => control.getClientRects().length && win.getComputedStyle(control).visibility !== 'hidden');
        return {
            box, viewport: { width: win.innerWidth, height: win.innerHeight }, horizontalOverflow: element.scrollWidth > element.clientWidth + 2, outside: controls.filter(control => {
                const rect = control.getBoundingClientRect();
                return rect.left < -1 || rect.right > win.innerWidth + 1;
            }).map(control => ({ name: control.getAttribute('aria-label') || control.textContent, box: control.getBoundingClientRect().toJSON() })), controls: controls.length
        };
    });
}
async function run(id, action) {
    delete report.interactionProof;
    if (process.env.RELAY_COMPOSER_MEDIA_FILTER && !new RegExp(process.env.RELAY_COMPOSER_MEDIA_FILTER).test(id))
        return;
    const errorsAt = report.pageErrors.length;
    try {
        const detail = await action();
        report.cases.push({
            id, status: detail?.gate ? 'gate' : 'pass', detail, pageErrors: report.pageErrors.slice(errorsAt)
        });
        console.log('PASS ' + id);
    }
    catch (error) {
        const screenshot = `composer-media-failure-${id}.png`;
        await page.screenshot({ path: path.join(evidence, screenshot) }).catch(() => {
        });
        report.cases.push({
            id, status: 'fail', error: String(error), stack: error.stack, interactionProof: report.interactionProof, screenshot, pageErrors: report.pageErrors.slice(errorsAt)
        });
        console.log('FAIL ' + id + ' ' + String(error).slice(0, 180));
    }
}
try {
    context = await chromium.launchPersistentContext(path.join(output, 'profile-' + Date.now()), {
        headless: true, executablePath: executable, viewport: { width: 1920, height: 1080 }, serviceWorkers: 'block'
    });
    page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.addInitScript(initializeAuditBrowser);
    report.blockedRequests = [];
    await context.route('**/*', route => {
        const requested = new URL(route.request().url());
        if (requested.hostname === '127.0.0.1')
            return route.continue();
        report.blockedRequests.push({ scheme: requested.protocol, host: requested.hostname });
        return route.abort();
    });
    page.on('pageerror', error => report.pageErrors.push(String(error)));
    page.on('console', message => {
        if (message.type() === 'error')
            report.consoleErrors.push(message.text().slice(0, 500));
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__relayComposerMedia?.protect && window.__relayAudit.state().chatCount >= 2, undefined, { timeout: 30000 });
    await page.evaluate(() => window.__relayComposerMedia.openDraft());
    await page.locator('#attach-menu-button').waitFor({ state: 'visible', timeout: 10000 });
    await settle();
    const imageBuffer = Buffer.from(await page.evaluate(async () => {
        const canvas = window.document.createElement('canvas');
        canvas.width = 3000;
        canvas.height = 2000;
        const drawing = canvas.getContext('2d');
        drawing.fillStyle = '#3d6994';
        drawing.fillRect(0, 0, 3000, 2000);
        drawing.fillStyle = '#ffe082';
        drawing.fillRect(400, 200, 1200, 700);
        drawing.font = '180px sans-serif';
        drawing.fillStyle = '#ffffff';
        drawing.fillText('Owned media fixture', 160, 1600);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return Array.from(bytes);
    }));
    const photo = { name: 'owned-photo.png', mimeType: 'image/png', buffer: imageBuffer };
    const second = { ...photo, name: 'owned-photo-two.png' };
    const documentInput = { name: 'owned-byte-integrity.bin', mimeType: 'application/octet-stream', buffer: bin };
    const video = { name: 'owned-video.mp4', mimeType: 'video/mp4', buffer: await readFile(videoPath) };
    const audio = { name: 'owned-audio.wav', mimeType: 'audio/wav', buffer: await readFile(audioPath) };
    report.inputs = [photo, documentInput, video, audio].map(file => ({
        name: file.name, mimeType: file.mimeType, bytes: file.buffer.length, sha256: sha(file.buffer)
    }));
    await run('full-attachment-photo-caption-standard', async () => {
        const modal = await choose([photo]);
        await modal.locator('[contenteditable=true]').fill('Owned caption — подпись проверена');
        const result = await send();
        assert.equal(result.text, 'Owned caption — подпись проверена');
        assert.equal(result.attachments[0].sourceSha256, sha(imageBuffer));
        assert.notEqual(result.attachments[0].selectedSha256, sha(imageBuffer));
        assert.equal(result.attachments[0].shouldSendAsFile, false);
        assert.deepEqual(result.attachments[0].selectedDimensions, { width: 1280, height: 853 });
        return { actualComposer: true, result };
    });
    await run('photo-high-quality-real-output', async () => {
        await choose([photo]);
        await more('hd-photo');
        assert.equal(await page.evaluate(() => window.__relayComposerMedia.settings().shouldSendInHighQuality), true);
        const result = await send();
        assert.equal(result.attachments[0].shouldSendInHighQuality, true);
        assert.deepEqual(result.attachments[0].selectedDimensions, { width: 2560, height: 1706 });
        assert.equal(result.attachments[0].sourceSha256, sha(imageBuffer));
        assert.notEqual(result.attachments[0].selectedSha256, sha(imageBuffer));
        return { result };
    });
    await run('photo-as-file-byte-integrity', async () => {
        await choose([photo]);
        await more('document');
        const result = await send();
        assert.equal(result.attachments[0].shouldSendAsFile, true);
        assert.equal(result.attachments[0].selectedSha256, sha(imageBuffer));
        assert.equal(result.attachments[0].selectedBytes, imageBuffer.length);
        return { result };
    });
    await run('album-group-and-ungroup', async () => {
        await choose([photo, second]);
        const grouped = await send();
        assert.equal(grouped.grouped, true);
        assert.equal(grouped.attachments.length, 2);
        await choose([photo, second]);
        await more('grouped-disable');
        const ungrouped = await send();
        assert.equal(ungrouped.grouped, false);
        return { grouped, ungrouped };
    });
    await run('caption-inversion-and-spoiler', async () => {
        const modal = await choose([photo]);
        await modal.locator('[contenteditable=true]').fill('Caption above photo');
        await more('move-caption-up');
        await more('spoiler');
        const result = await send();
        assert.equal(result.inverted, true);
        assert.equal(result.attachments[0].shouldSendAsSpoiler, true);
        return { result };
    });
    await run('single-photo-inverted-caption-with-ungroup-setting', async () => {
        const modal = await choose([photo]);
        await page.evaluate(() => window.__relayComposerMedia.setGrouped(false));
        await settle();
        await modal.locator('[contenteditable=true]').fill('Isolated caption above single photo');
        await more('move-caption-up');
        assert.equal(await page.evaluate(() => window.__relayComposerMedia.settings().isInvertedMedia), true);
        const result = await send();
        assert.equal(result.grouped, false);
        report.interactionProof = { result, settingsRequestedInversion: true };
        assert.equal(result.inverted, true, 'Single-photo caption inversion must survive unrelated album ungroup setting');
        return { result };
    });
    await run('multiple-ungrouped-inverted-caption', async () => {
        const modal = await choose([photo, second]);
        await more('grouped-disable');
        await modal.locator('[contenteditable=true]').fill('Isolated caption above ungrouped photos');
        await more('move-caption-up');
        assert.equal(await page.evaluate(() => window.__relayComposerMedia.settings().isInvertedMedia), true);
        const result = await send();
        assert.equal(result.grouped, false);
        report.interactionProof = { result, settingsRequestedInversion: true };
        assert.equal(result.inverted, true, 'Requested ungrouped media caption inversion is retained');
        return { result };
    });
    await run('empty-caption-inversion-cleared', async () => {
        await choose([photo]);
        await more('move-caption-up');
        const result = await send();
        assert.equal(result.text, '');
        assert.equal(result.inverted, undefined);
        return { result, emptyCaptionFlagCleared: true };
    });
    await run('file-mode-inversion-cleared', async () => {
        await choose([photo], true);
        await page.evaluate(() => window.__relayComposerMedia.setInverted());
        const result = await send();
        assert.equal(result.attachments[0].shouldSendAsFile, true);
        assert.equal(result.inverted, undefined);
        return { result, fileModeFlagCleared: true };
    });
    await run('editor-header-pointer-hit-test', async () => {
        await choose([photo]);
        await attachment().locator('.icon-edit').click();
        const editor = page.locator('[class*=MediaEditor][class*=root]').first();
        await editor.waitFor({ state: 'visible' });
        await settle();
        const hits = await editor.locator('[class*=panelHeader] button').evaluateAll(elements => elements.map(element => {
            const box = element.getBoundingClientRect();
            const top = window.document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return {
                icon: element.querySelector('.icon')?.className, disabled: element.disabled, box: box.toJSON(), actualHitClass: top?.className, ownsHit: top === element || element.contains(top)
            };
        }));
        report.interactionProof = { hits };
        const screenshot = 'composer-media-editor-header-hit-test.png';
        await page.screenshot({ path: path.join(evidence, screenshot) });
        report.interactionProof.screenshot = screenshot;
        assert(hits.filter(hit => !hit.disabled).every(hit => hit.ownsHit), 'Enabled editor controls own their pointer hit after animation');
        return { hits, screenshot };
    });
    await run('multiple-persisted-ungrouped-inverted-caption', async () => {
        const modal = await choose([photo, second]);
        await page.evaluate(() => window.__relayComposerMedia.setGrouped(false));
        await settle();
        await modal.locator('[contenteditable=true]').fill('Persisted ungrouped caption above photos');
        await more('move-caption-up');
        const result = await send();
        assert.equal(result.grouped, false);
        report.interactionProof = { result, settingsRequestedInversion: true };
        assert.equal(result.inverted, true, 'Persisted ungrouped media requested caption inversion retained');
        return { result };
    });
    await run('editor-header-focus-owner', async () => {
        await choose([photo]);
        await attachment().locator('.icon-edit').click();
        const editor = page.locator('[class*=MediaEditor][class*=root]').first();
        await editor.waitFor({ state: 'visible' });
        await settle();
        const closeControl = editor.locator('[class*=panelHeader] button:has(.icon-close)');
        await closeControl.focus();
        const focus = await closeControl.evaluate(element => ({
            ownsFocus: window.document.activeElement === element, activeClass: window.document.activeElement?.className, activeAria: window.document.activeElement?.getAttribute('aria-label'), insideEditor: window.document.activeElement?.closest('[class*=MediaEditor][class*=root]') !== null
        }));
        report.interactionProof = focus;
        assert.equal(focus.ownsFocus, true, 'Editor Portal owns focus while parent attachment modal remains mounted');
        return { focus };
    });
    await run('editor-keyboard-tab-space-escape-ownership', async () => {
        await choose([photo]);
        await attachment().locator('[contenteditable=true]').fill('Escape keeps original caption');
        await attachment().locator('.icon-edit').click();
        const editor = page.locator('[class*=MediaEditor][class*=root]').first();
        await editor.waitFor({ state: 'visible' });
        await settle();
        const traces = [];
        for (let step = 0; step < 15; step++) {
            await page.keyboard.press('Tab');
            const focus = await editor.evaluate(element => ({ inside: element.contains(window.document.activeElement), activeClass: window.document.activeElement?.className }));
            traces.push(focus);
            assert.equal(focus.inside, true);
        }
        await page.keyboard.press('Escape');
        await editor.waitFor({ state: 'hidden' });
        await attachment().waitFor({ state: 'visible' });
        assert.equal(await attachment().locator('[contenteditable=true]').innerText(), 'Escape keeps original caption');
        await attachment().locator('.icon-edit').click();
        await editor.waitFor({ state: 'visible' });
        await settle();
        const closeControl = editor.locator('[class*=panelHeader] button:has(.icon-close)');
        await closeControl.focus();
        await page.keyboard.press('Space');
        await editor.waitFor({ state: 'hidden' });
        await attachment().waitFor({ state: 'visible' });
        const result = await send();
        assert.equal(result.attachments[0].sourceSha256, sha(imageBuffer));
        return {
            tabTraces: traces, escapeKeepsParent: true, spaceOwnCancel: true, result
        };
    });
    await run('group-compression-quality-caption-independent-settings', async () => {
        const modal = await choose([photo, second]);
        await more('grouped-disable');
        await modal.locator('[contenteditable=true]').fill('Independent selection controls');
        await more('hd-photo');
        await more('move-caption-up');
        await more('document');
        await more('photo');
        const result = await send();
        assert.equal(result.grouped, false);
        assert.equal(result.inverted, true);
        assert(result.attachments.every(item => item.shouldSendInHighQuality === true));
        assert(result.attachments.every(item => !item.shouldSendAsFile));
        assert(result.attachments.every(item => item.sourceSha256 === sha(imageBuffer)));
        return { result };
    });
    await run('document-original-byte-integrity', async () => {
        await choose([documentInput], true);
        const result = await send();
        assert.equal(result.attachments[0].selectedSha256, sha(bin));
        assert.equal(result.attachments[0].selectedBytes, bin.length);
        assert.equal(result.attachments[0].shouldSendAsFile, true);
        return { result };
    });
    await run('actual-video-local-decode-preview', async () => {
        const modal = await choose([video]);
        await page.waitForFunction(() => window.document.querySelector('[class*="AttachmentModalItem"] video')?.videoWidth > 0, undefined, { timeout: 5000 });
        const decoded = await modal.locator('video').evaluate(element => ({
            width: element.videoWidth, height: element.videoHeight, duration: element.duration, readyState: element.readyState
        }));
        assert.equal(decoded.width, 1280);
        assert.equal(decoded.height, 720);
        const result = await send();
        assert.equal(result.attachments[0].selectedSha256, sha(video.buffer));
        return { decoded, result };
    });
    await run('actual-audio-metadata-and-byte-integrity', async () => {
        await choose([audio], true);
        const result = await send();
        assert.equal(result.attachments[0].selectedSha256, sha(audio.buffer));
        assert.equal(result.attachments[0].audio.duration, 1);
        return { result };
    });
    await run('modal-add-real-filechooser-delete-and-cancel', async () => {
        await choose([photo]);
        await attachment().getByRole('button', { name: 'More actions', exact: true }).click();
        const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
        chooser.catch(() => undefined);
        await page.locator('.MenuItem:visible:has(.icon-add)').click();
        await (await chooser).setFiles([documentInput]);
        await page.waitForFunction(() => window.document.querySelectorAll('[class*="AttachmentModalItem"][class*="root"]').length === 2);
        const before = await count('sendMessage');
        await attachment().locator('.icon-delete').last().click();
        await settle();
        assert.equal(await attachment().locator('[class*="AttachmentModalItem"][class*="root"]').count(), 1);
        await attachment().getByRole('button', { name: 'Cancel attachments', exact: true }).click();
        await settle();
        assert.equal(await count('sendMessage'), before);
        const state = await attachment().count() ? await attachment().evaluate(element => ({ parentClass: element.closest('.Modal')?.className, open: element.closest('.Modal')?.classList.contains('open'), rect: element.getBoundingClientRect().toJSON() })) : { open: false };
        report.interactionProof = { state };
        assert.equal(state.open, false);
        return {
            append: 2, remaining: 1, sendDelta: 0, state
        };
    });
    await run('photo-editor-crop-rotate-undo-redo-save', async () => {
        await choose([photo]);
        await attachment().locator('[contenteditable=true]').fill('Caption preserved through actual editor');
        await attachment().locator('.icon-edit').click();
        const editor = page.locator('[class*="MediaEditor"][class*="root"]').first();
        await editor.waitFor({ state: 'visible' });
        await settle();
        await editor.locator('.SquareTabList .Tab').last().click();
        await settle();
        const corner = editor.locator('[class*="cropCorner"][class*="bottomRight"]');
        const beforeBox = await editor.locator('[class*="cropRegion"]').boundingBox();
        const handle = await corner.boundingBox();
        assert(handle);
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        await page.mouse.move(handle.x - 65, handle.y - 45, { steps: 12 });
        await page.mouse.up();
        await settle();
        const croppedBox = await editor.locator('[class*="cropRegion"]').boundingBox();
        assert(croppedBox.width < beforeBox.width - 20);
        await editor.locator('button:has(.icon-undo)').click();
        await settle();
        const undoneBox = await editor.locator('[class*="cropRegion"]').boundingBox();
        assert(Math.abs(undoneBox.width - beforeBox.width) < 2);
        await editor.locator('button:has(.icon-rotate)').click();
        await settle();
        await editor.locator('button:has(.icon-undo)').click();
        await settle();
        await editor.locator('button:has(.icon-redo)').click();
        await settle();
        await page.keyboard.press('Control+z');
        await settle();
        await page.keyboard.press('Control+Shift+z');
        await settle();
        await editor.getByRole('button', { name: /Save|Сохранить/i }).click();
        await editor.waitFor({ state: 'hidden', timeout: 5000 });
        await attachment().waitFor({ state: 'visible' });
        const result = await send();
        assert.equal(result.text, 'Caption preserved through actual editor');
        assert.notEqual(result.attachments[0].sourceSha256, sha(imageBuffer));
        assert.equal(result.attachments[0].quick.width, 2000);
        assert.equal(result.attachments[0].quick.height, 3000);
        return {
            result, pointerCrop: { beforeBox, croppedBox, undoneBox }, pointerUndoRedo: true, keyboardUndoRedo: true
        };
    });
    await run('editor-cancel-keeps-original-and-zero-send', async () => {
        await choose([photo]);
        const before = await count('sendMessage');
        await attachment().locator('.icon-edit').click();
        const editor = page.locator('[class*="MediaEditor"][class*="root"]').first();
        await editor.waitFor({ state: 'visible' });
        await settle();
        await editor.locator('[class*=panelHeader] button:has(.icon-close)').click();
        await editor.waitFor({ state: 'hidden' });
        await attachment().waitFor({ state: 'visible' });
        assert.equal(await count('sendMessage'), before);
        const result = await send();
        assert.equal(result.attachments[0].sourceSha256, sha(imageBuffer));
        return { result, cancelSendDelta: 0, actualPointerCancel: true };
    });
    await run('malformed-video-falls-back-to-original-file', async () => {
        const bytes = Buffer.from('Owned malformed MP4 payload');
        await choose([{ name: 'owned-invalid-video.mp4', mimeType: 'video/mp4', buffer: bytes }]);
        const result = await send();
        assert.equal(result.attachments[0].shouldSendAsFile, true);
        assert.equal(result.attachments[0].selectedSha256, sha(bytes));
        return { result, finiteFallback: true };
    });
    await run('malformed-photo-error-and-valid-retry', async () => {
        const beforeUnhandled = await page.evaluate(() => window.__relayUnhandled.length);
        const beforeSends = await count('sendMessage');
        const bytes = Buffer.from('Owned malformed PNG payload');
        let failedSelect;
        try {
            await choose([{ name: 'owned-invalid-photo.png', mimeType: 'image/png', buffer: bytes }]);
        }
        catch (error) {
            failedSelect = String(error).slice(0, 220);
        }
        const unhandled = await page.evaluate(() => window.__relayUnhandled.slice());
        await choose([photo]);
        await close();
        assert.equal(await count('sendMessage'), beforeSends);
        report.interactionProof = {
            failedSelect, unhandled: unhandled.slice(beforeUnhandled), validRetryOpened: true, realSendDelta: 0
        };
        assert.equal(unhandled.length, beforeUnhandled, 'Malformed photo is rejected with handled feedback, without unhandled async rejection');
        return report.interactionProof;
    });
    await run('malformed-photo-valid-sibling-selection', async () => {
      const beforeUnhandled = await page.evaluate(() => window.__relayUnhandled.length);
      const beforeSends = await count('sendMessage');
      const beforeNotifications = await count('showNotification');
      const invalid = { name: 'owned-invalid-sibling.png', mimeType: 'image/png', buffer: Buffer.from('Owned malformed PNG sibling payload') };
      let failedSelect;
      try { await choose([invalid, photo]); } catch (error) { failedSelect = String(error).slice(0, 220); }
      const unhandled = await page.evaluate(() => window.__relayUnhandled.slice());
      const notifications = (await events()).filter(event => event.name === 'showNotification').slice(beforeNotifications);
      report.interactionProof = { failedSelect, unhandled: unhandled.slice(beforeUnhandled), notifications, beforeSends, sendDelta: await count('sendMessage') - beforeSends };
      assert.equal(unhandled.length, beforeUnhandled, 'Mixed invalid media decode must be handled without rejecting valid sibling selection');
      assert.equal(await count('sendMessage'), beforeSends, 'File selection does not send');
      assert.equal(notifications.length, 1);
      assert(notifications[0].detail.message);
      const result = await send();
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0].sourceSha256, sha(imageBuffer));
      assert.equal(result.attachments[0].filename, photo.name);
      return { result, notifications, realSendDelta: 0 };
    });
    await run('malformed-photo-retains-existing-selection-exact-hook', async () => {
        await close();
        const beforeUnhandled = await page.evaluate(() => window.__relayUnhandled.length);
        const beforeSends = await count('sendMessage');
        const beforeNotifications = await count('showNotification');
        await page.evaluate(async bytes => {
            window.__relayComposerMedia.protect();
            const file = new window.File([new Uint8Array(bytes)], 'owned-retained-prior.png', { type: 'image/png' });
            await window.__relayComposerMedia.hookProbeSelect([file]);
        }, Array.from(imageBuffer));
        await page.waitForFunction(() => window.__relayComposerMedia.hookProbeAttachments().length === 1);
        const before = await page.evaluate(async () => {
            const attachment = window.__relayComposerMedia.hookProbeAttachments()[0];
            return { filename: attachment.filename, uniqueId: attachment.uniqueId, sha256: Array.from(new Uint8Array(await window.crypto.subtle.digest('SHA-256', await attachment.blob.arrayBuffer()))).map(byte => byte.toString(16).padStart(2, '0')).join('') };
        });
        await page.evaluate(async () => {
            const file = new window.File(['Owned malformed prior-preservation PNG'], 'owned-invalid-retained.png', { type: 'image/png' });
            await window.__relayComposerMedia.hookProbeSelect([file]);
        });
        await settle();
        const after = await page.evaluate(async () => {
            const attachment = window.__relayComposerMedia.hookProbeAttachments()[0];
            return { filename: attachment.filename, uniqueId: attachment.uniqueId, sha256: Array.from(new Uint8Array(await window.crypto.subtle.digest('SHA-256', await attachment.blob.arrayBuffer()))).map(byte => byte.toString(16).padStart(2, '0')).join('') };
        });
        assert.deepEqual(after, before);
        assert.equal(after.sha256, sha(imageBuffer));
        assert.equal(await page.evaluate(() => window.__relayUnhandled.length), beforeUnhandled);
        assert.equal(await count('sendMessage'), beforeSends);
        assert.equal(await count('showNotification'), beforeNotifications + 1);
        await page.evaluate(() => window.__relayComposerMedia.hookProbeClear());
        return { actualImportedHook: true, scope: 'Direct callback/state probe because existing attachment modal blocks the underlying initial file chooser', before, after, realSendDelta: 0 };
    });
    await run('fullhd-and-narrow-attachment-geometry', async () => {
        const samples = [];
        for (const viewport of [{ width: 1920, height: 1080 }, { width: 640, height: 900 }]) {
            await close();
            await page.setViewportSize(viewport);
            const modal = await choose([photo, second]);
            const measured = await geometry(modal);
            assert.deepEqual(measured.outside, []);
            assert.equal(measured.horizontalOverflow, false);
            const screenshot = `composer-media-attachments-${viewport.width}.png`;
            await page.screenshot({ path: path.join(evidence, screenshot) });
            samples.push({ ...measured, screenshot });
        }
        await close();
        await page.setViewportSize({ width: 1920, height: 1080 });
        return { samples };
    });
    await run('editor-fullhd-narrow-geometry-and-pointer-cancel', async () => {
        const samples = [];
        try {
            for (const viewport of [{ width: 1920, height: 1080 }, { width: 640, height: 900 }, { width: 390, height: 844 }]) {
                await close();
                await page.setViewportSize({ width: 1920, height: 1080 });
                await choose([photo]);
                await attachment().locator('.icon-edit').click();
                const editor = page.locator('[class*=MediaEditor][class*=root]').first();
                await editor.waitFor({ state: 'visible' });
                await settle();
                await page.setViewportSize(viewport);
                await settle();
                const sample = await editor.evaluate(element => {
                    const box = element.getBoundingClientRect().toJSON();
                    const controls = Array.from(element.querySelectorAll('button,input,[role=button]')).filter(control => control.getClientRects().length && !control.disabled && !control.closest('.FloatingActionButton:not(.revealed), .Transition_slide-inactive') && window.getComputedStyle(control).visibility !== 'hidden');
                    return {
                        box,
                        viewport: { width: window.innerWidth, height: window.innerHeight },
                        outside: controls.filter(control => {
                            const rect = control.getBoundingClientRect();
                            return rect.left < -1 || rect.right > window.innerWidth + 1 || rect.top < -1 || rect.bottom > window.innerHeight + 1;
                        }).map(control => {
                            const scroller = control.closest('[class*=panelContent]');
                            return { name: control.getAttribute('aria-label') || control.textContent, box: control.getBoundingClientRect().toJSON(), reachableByPanelScroll: Boolean(scroller && scroller.scrollHeight > scroller.clientHeight && window.getComputedStyle(scroller).overflowY === 'auto') };
                        }),
                        overflow: element.scrollWidth > element.clientWidth + 2,
                        bodyClass: window.document.body.className,
                    };
                });
                report.interactionProof = { samples, sample };
                assert.equal(sample.box.top, 40);
                assert(sample.box.bottom <= viewport.height + 1);
                assert.deepEqual(sample.outside.filter(control => !control.reachableByPanelScroll), []);
                assert.equal(sample.overflow, false);
                const scroller = editor.locator('[class*=panelContent]').first();
                const scroll = await scroller.evaluate(element => {
                    element.scrollTop = element.scrollHeight;
                    return { scrollTop: element.scrollTop, maxScroll: element.scrollHeight - element.clientHeight };
                });
                assert(scroll.maxScroll === 0 || scroll.scrollTop > 0);
                const screenshot = 'composer-media-editor-' + viewport.width + '.png';
                await page.screenshot({ path: path.join(evidence, screenshot) });
                await editor.locator('[class*=panelHeader] button:has(.icon-close)').click();
                await editor.waitFor({ state: 'hidden' });
                await attachment().waitFor({ state: 'visible' });
                samples.push({ ...sample, scroll, screenshot });
            }
            return { samples, realPointerCancels: samples.length, responsiveEntry: 'Open via offered desktop editor control, then resize own viewport; narrow attachment editor affordance is intentionally absent' };
        }
        finally {
            await close();
            await page.setViewportSize({ width: 1920, height: 1080 });
        }
    });
    await run('editor-landing-ghost-popover-inset-geometry', async () => {
        await choose([photo]);
        await page.evaluate(() => {
            const host = window.document.createElement('div');
            host.id = 'MediaViewer';
            host.style.display = 'none';
            const slide = window.document.createElement('div');
            slide.className = 'MediaViewerSlide--active';
            const image = window.document.createElement('img');
            slide.append(image);
            host.append(slide);
            window.document.body.append(host);
            window.__relayComposerMedia.landingTraces = [];
            const sample = () => {
                const editor = window.document.querySelector('[class*=MediaEditor][class*=root][popover]');
                if (!editor?.matches(':popover-open'))
                    return;
                const box = editor.getBoundingClientRect().toJSON();
                window.__relayComposerMedia.landingTraces.push({
                    popoverOpen: true, className: editor.className, box, viewportHeight: window.innerHeight, captionHeight: window.getComputedStyle(editor).getPropertyValue('--media-editor-caption-height').trim()
                });
            };
            const observer = new MutationObserver(sample);
            observer.observe(window.document.querySelector('#portals'), { childList: true, subtree: true, attributes: true });
            window.__relayComposerMedia.closeLandingProbe = () => {
                observer.disconnect();
                host.remove();
            };
        });
        try {
            await attachment().locator('.icon-edit').click();
            await page.waitForFunction(() => window.__relayComposerMedia.landingTraces.length > 0, undefined, { timeout: 4000 });
            const traces = await page.evaluate(() => window.__relayComposerMedia.landingTraces);
            report.interactionProof = { traces, scope: 'Synthetic hidden viewer-host sentinel triggers actual MediaEditor manual-popover branch; actual viewer lifecycle unverified' };
            assert(traces.some(trace => Math.abs(trace.box.top - 40) < 1 && trace.box.bottom <= trace.viewportHeight + 1 && trace.box.height <= trace.viewportHeight - 39));
            const editor = page.locator('[class*=MediaEditor][class*=root]').first();
            await settle();
            await editor.locator('[class*=panelHeader] button:has(.icon-close)').click();
            await editor.waitFor({ state: 'hidden' });
            return report.interactionProof;
        }
        finally {
            await page.evaluate(() => window.__relayComposerMedia.closeLandingProbe());
        }
    });
    await run('actual-document-upload-progress-cancel', async () => {
        await close();
        await page.evaluate(() => window.__relayComposerMedia.openTransfer('upload', 0.375));
        const file = page.locator('#composer-owned-document');
        await file.waitFor({ state: 'visible' });
        await file.locator('.ProgressSpinner').waitFor({ state: 'visible' });
        const before = await count('cancelOwnedUpload');
        await file.locator('.ProgressSpinner').click();
        assert.equal(await count('cancelOwnedUpload'), before + 1);
        return { progress: 0.375, cancelDelta: 1, geometry: await geometry(file) };
    });
    await run('actual-document-download-cancel', async () => {
        await close();
        await page.evaluate(() => window.__relayComposerMedia.openTransfer('download'));
        const file = page.locator('#composer-owned-document');
        await file.waitFor({ state: 'visible' });
        const before = await count('cancelMediaDownload');
        await file.locator('.file-icon-container').click();
        assert.equal(await count('cancelMediaDownload'), before + 1);
        return { cancelDelta: 1 };
    });
    await run('document-download-exact-selection', async () => {
        await close();
        await page.evaluate(() => window.__relayComposerMedia.openTransfer('idle'));
        const file = page.locator('#composer-owned-document');
        await file.waitFor({ state: 'visible' });
        const before = await count('downloadMedia');
        await file.locator('.file-icon-container').click();
        assert.equal(await count('downloadMedia'), before + 1);
        assert.equal((await events()).filter(event => event.name === 'downloadMedia').at(-1).detail.mediaId, '990000001');
        return { callbackDelta: 1, selectedMediaId: '990000001', realDownloads: 0 };
    });
    await run('document-preview-loading-then-exact-content', async () => {
        await close();
        await page.evaluate(() => window.__relayComposerMedia.openReader('loading'));
        const reader = page.locator('dialog[open]').last();
        await reader.waitFor({ state: 'visible' });
        assert.equal(await reader.locator('[aria-busy=true]').count(), 1);
        await reader.locator('[class*="textLines"]').waitFor({ state: 'visible', timeout: 4000 });
        assert((await reader.innerText()).includes('Alpha comparison'));
        return { actualReader: true, requests: counts.loading };
    });
    await run('document-preview-error-retry-download', async () => {
        await close();
        await page.evaluate(() => window.__relayComposerMedia.openReader('retry'));
        const reader = page.locator('dialog[open]').last();
        await reader.locator('[role=alert]').waitFor({ state: 'visible', timeout: 4000 });
        await reader.locator('[role=alert] button').first().click();
        await reader.locator('[class*="textLines"]').waitFor({ state: 'visible', timeout: 4000 });
        assert.equal(counts.retry, 2);
        assert((await reader.innerText()).includes('Alpha source'));
        const before = await count('downloadMedia');
        await reader.locator('button:has(.icon-download)').first().click();
        assert.equal(await count('downloadMedia'), before + 1);
        return { retryReadRequests: 2, downloadDelta: 1, realDownloads: 0 };
    });
    await close();
    report.events = await events();
    report.captures = await captures();
    report.unhandled = await page.evaluate(() => window.__relayUnhandled);
    report.readerRequests = counts;
}
catch (error) {
    report.fatal = String(error);
    console.error(error);
}
finally {
    await context?.close();
    await server.close();
    report.summary = {
        total: report.cases.length, pass: report.cases.filter(item => item.status === 'pass').length, fail: report.cases.filter(item => item.status === 'fail').length, gates: report.gates.length, pageErrors: report.pageErrors.length, unhandled: report.unhandled?.length || 0
    };
    const bytes = JSON.stringify(report, null, 2) + '\n';
    await writeFile(path.join(evidence, 'composer-media-results.json'), bytes);
    console.log(JSON.stringify(report.summary));
    if (report.fatal || report.summary.fail || report.pageErrors.length || report.unhandled?.length)
        process.exitCode = 1;
}
