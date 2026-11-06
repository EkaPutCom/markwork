// Long saved and streaming conversations must scroll inside the chat, never
// move the window's chrome.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { seedFolderAgent } from './folderpi.mjs';
import { performance } from 'node:perf_hooks';
import { launchApp, scratchFolder, stepper, testModule } from './support.mjs';

const { scratch, notes } = scratchFolder('agentchat-layout');
const gate = join(scratch, 'continue-stream');

const paragraph =
    'The plan and meeting notes describe a' +
        ' launch moved to 22 November. Compare' +
        ' the sources before proposing an' +
        ' update. ';
const answer =
    '### Research finding\n\n' +
    paragraph.repeat(12) +
    '\n\n- Compare references.\n- Review the proposed update.\n\n```text\n' +
    'long_reference_'.repeat(80) +
    '\n```\n';
seedFolderAgent({
    scratch,
    notes,
    title: 'Long research conversation',
    messages: Array.from({ length: 25 }, (_, i) => [
        { role: 'user', content: `Research question ${i + 1}` },
        {
            role: 'assistant',
            content: [{ type: 'text', text: answer }],
            stopReason: 'stop',
        },
    ]).flat(),
});
const { step, steps } = stepper({ echo: true });
const app = await launchApp({
    scratch,
    notes,
    env: {
        MARKWORK_TEST_PI: testModule('folderpi.mjs'),
        MARKWORK_TEST_PI_GATE: gate,
        MARKWORK_TEST_PI_ANSWER: answer,
    },
});
let failed = false;
let page;
try {
    page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
    });
    const chats = page.getByRole('complementary', {
        name: 'Agent conversation',
        exact: true,
    });
    const geometry = () =>
        page.evaluate(() => ({
            height: innerHeight,
            width: innerWidth,
            windowY: scrollY,
            documentHeight: document.documentElement.scrollHeight,
            documentWidth: document.documentElement.scrollWidth,
            bodyHeight: document.body.clientHeight,
            bodyScrollHeight: document.body.scrollHeight,
            bodyScrollTop: document.body.scrollTop,
            titlebar: document
                .querySelector('.titlebar')
                .getBoundingClientRect()
                .toJSON(),
            header: document
                .querySelector('.headerbar')
                .getBoundingClientRect()
                .toJSON(),
            chats: Array.from(
                document.querySelectorAll('.agent-conversation')
            ).map((chat) => ({
                bounds: chat.getBoundingClientRect().toJSON(),
                pane: chat
                    .closest('.pane-body')
                    .getBoundingClientRect()
                    .toJSON(),
                composer: chat
                    .querySelector('.chat-input')
                    .getBoundingClientRect()
                    .toJSON(),
                messages: chat
                    .querySelector('.chat-messages')
                    .getBoundingClientRect()
                    .toJSON(),
                scrollHeight: chat.querySelector('.chat-messages').scrollHeight,
                clientHeight: chat.querySelector('.chat-messages').clientHeight,
            })),
        }));
    const check = async () => {
        const box = await geometry();
        assert.equal(
            box.windowY,
            0,
            'the window scrolled instead of the conversation'
        );
        assert.equal(
            box.bodyScrollTop,
            0,
            'focusing the composer scrolled the window body'
        );
        assert.ok(
            box.bodyScrollHeight <= box.bodyHeight + 1,
            'conversation overflow escaped into the window body'
        );
        assert.ok(box.documentHeight <= box.height + 1, JSON.stringify(box));
        assert.ok(
            box.documentWidth <= box.width + 1,
            'wide message content escaped the window'
        );
        assert.ok(
            box.titlebar.top >= 0 && box.header.top >= box.titlebar.bottom - 1,
            'window chrome moved off screen'
        );
        for (const chat of box.chats) {
            assert.ok(
                chat.bounds.bottom <= chat.pane.bottom + 1,
                'chat grew outside its pane'
            );
            assert.ok(
                chat.composer.bottom <= chat.pane.bottom + 1 &&
                    chat.composer.top >= chat.messages.bottom - 1,
                'composer escaped the visible chat'
            );
            assert.ok(
                chat.scrollHeight > chat.clientHeight,
                'history should have its own scroll range'
            );
        }
    };
    await step(
        'long saved history keeps window chrome' +
            ' and the composer inside the viewport',
        async () => {
            await chats.waitFor({ timeout: 15000 });
            await chats.locator('.chat-assistant').nth(24).waitFor();
            await page.setViewportSize({ width: 1400, height: 900 });
            await chats.getByLabel('Message', { exact: true }).focus();
            await check();
            await chats.locator('.chat-messages').evaluate(
                (el) =>
                    new Promise((resolve) => {
                        if (el.scrollTop === 0) {
                            resolve();
                            return;
                        }
                        el.addEventListener('scroll', () => resolve(), {
                            once: true,
                        });
                        el.scrollTop = 0;
                    })
            );
            await chats
                .getByText('Research question 1', { exact: true })
                .waitFor();
            await check();
        }
    );
    await step(
        'streaming follows new output but' +
            ' preserves a user reading earlier' +
            ' messages',
        async () => {
            await page
                .getByRole('button', { name: 'Activate pi agent', exact: true })
                .click();
            await page
                .getByRole('alertdialog', {
                    name: 'Activate pi agent?',
                    exact: true,
                })
                .getByRole('button', { name: 'Activate pi agent', exact: true })
                .click();
            await chats
                .getByLabel('Message', { exact: true })
                .fill('Continue the research');
            await chats.getByLabel('Message', { exact: true }).press('Enter');
            await chats
                .getByText('Stream checkpoint', { exact: true })
                .waitFor();
            await page.waitForFunction(() => {
                const el = document.querySelector(
                    '.agent-conversation .chat-messages'
                );
                return el.scrollHeight - el.clientHeight - el.scrollTop < 2;
            });
            await check();
            await chats.locator('.chat-messages').evaluate(
                (el) =>
                    new Promise((resolve) => {
                        if (el.scrollTop === 0) {
                            resolve();
                            return;
                        }
                        el.addEventListener('scroll', () => resolve(), {
                            once: true,
                        });
                        el.scrollTop = 0;
                    })
            );
            await page.waitForFunction(
                () =>
                    document.querySelector('.agent-conversation .chat-messages')
                        .scrollTop === 0
            );
            writeFileSync(gate, 'continue');
            await chats
                .getByText('Final streamed paragraph.', { exact: true })
                .waitFor();
            await chats
                .getByRole('button', { name: 'Send', exact: true })
                .waitFor();
            assert.equal(
                await chats
                    .locator('.chat-messages')
                    .evaluate((el) => el.scrollTop),
                0,
                'streaming pulled the user away from older messages'
            );
            await check();
        }
    );
    await step(
        'measure long-history tab switching and' +
            ' renderer heap without a provider',
        async () => {
            await page
                .getByRole('treeitem', { name: 'instructions.md', exact: true })
                .click();
            const measurements = [];
            for (let i = 0; i < 23; i++) {
                await page
                    .getByRole('tab', { name: /instructions\.md/ })
                    .click();
                const start = performance.now();
                await page
                    .getByRole('tab', { name: /Long research conversation/ })
                    .click();
                await chats.locator('.chat-input textarea').waitFor();
                if (i >= 3) measurements.push(performance.now() - start);
            }
            measurements.sort((a, b) => a - b);
            const cdp = await page.context().newCDPSession(page),
                heap = await cdp.send('Runtime.getHeapUsage');
            await cdp.detach();
            console.log(
                '  Long-history UI baseline: ' +
                    JSON.stringify({
                        medianMs: measurements[10],
                        p95Ms: measurements[18],
                        maxMs: measurements[19],
                        rendererHeapBytes: heap.usedSize,
                        historyTurns: 50,
                        repetitions: 20,
                    })
            );
        }
    );
    await step(
        'long history stays contained in both' +
            ' themes, a narrow window, and split' +
            ' panes',
        async () => {
            const out = process.env.MARKWORK_LONG_CHAT_OUT;
            if (out) mkdirSync(out, { recursive: true });
            for (const theme of ['light', 'dark']) {
                await page.emulateMedia({
                    colorScheme: theme,
                    reducedMotion: 'reduce',
                });
                await chats.locator('.chat-messages').evaluate((el) => {
                    el.scrollTop = el.scrollHeight;
                });
                await check();
                if (out)
                    await page.screenshot({
                        animations: 'disabled',
                        path: join(out, `long-chat-${theme}.png`),
                    });
            }
            await page.setViewportSize({ width: 560, height: 800 });
            await check();
            if (out)
                await page.screenshot({
                    animations: 'disabled',
                    path: join(out, 'long-chat-narrow.png'),
                });
            await page.setViewportSize({ width: 1400, height: 900 });
            await page
                .getByRole('button', { name: 'Pane actions', exact: true })
                .click();
            await page.getByRole('menuitem', { name: /^Split Down/ }).click();
            await page.waitForFunction(
                () =>
                    document.querySelectorAll('.agent-conversation').length ===
                    2
            );
            await check();
            if (out)
                await page.screenshot({
                    animations: 'disabled',
                    path: join(out, 'long-chat-split.png'),
                });
        }
    );
    await step('no renderer errors occurred', () =>
        assert.deepEqual(errors, [])
    );
} catch (error) {
    failed = true;
    console.error(error);
} finally {
    writeFileSync(gate, 'continue');
    await Promise.race([
        app.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    try {
        app.process().kill();
    } catch {}
    rmSync(scratch, { recursive: true, force: true });
}
console.log(`Agent chat layout: ${steps.length} steps`);
process.exit(failed ? 1 : 0);
