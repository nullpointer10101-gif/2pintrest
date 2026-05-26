const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('./db');
const config = require('./config.json');

// Helper to wait randomly between min and max ms
const delay = (min, max) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1) + min)));

class PinterestUploader {
    constructor(accountName, sessionCookie, browser) {
        this.accountName = accountName;
        this.sessionCookie = sessionCookie;
        this.browser = browser;
    }

    async uploadPin(pinData) {
        console.log(`[Uploader - ${this.accountName}] Processing pin: ${pinData.title || pinData.id}`);
        const page = await this.browser.newPage();
        
        try {
            // Spoof User-Agent to prevent headless blocking
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            // Set the session cookie so we are logged in
            await page.setCookie({
                name: '_pinterest_sess',
                value: this.sessionCookie,
                domain: '.pinterest.com',
                path: '/',
                secure: true,
                httpOnly: true
            });

            // Navigate to Pin Creation page (Using Pinterest's standard UI builder)
            await page.goto('https://www.pinterest.com/pin-builder/', { waitUntil: 'domcontentloaded', timeout: 120000 });

            // Ensure we are actually logged in by waiting for the profile picture or account menu
            const isLoggedIn = await page.waitForSelector('div[data-test-id="header-profile"], div[data-test-id="saved-tab"]', { timeout: 30000 }).catch(() => null);
            if (!isLoggedIn) {
                console.error(`[Uploader - ${this.accountName}] Session cookie might be invalid. Not logged in. Current URL is: ${page.url()}`);
                await page.close();
                return false;
            }

            console.log(`[Uploader - ${this.accountName}] Pin-builder loaded successfully! Executing UI automation.`);
            
            // 1. Download image to temporary file
            const tmpImagePath = path.join(__dirname, `tmp_${Date.now()}.jpg`);
            const writer = fs.createWriteStream(tmpImagePath);
            const response = await axios({ url: pinData.image_url, method: 'GET', responseType: 'stream' });
            response.data.pipe(writer);
            await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });

            // 2. Upload image via input element
            const fileInput = await page.$('input[type="file"]');
            if (fileInput) {
                await fileInput.uploadFile(tmpImagePath);
                await delay(2000, 4000);
            }

            // 3. Type Title
            if (pinData.title) {
                const titleSelector = 'input[placeholder*="title"], textarea[placeholder*="title"], [data-test-id="pin-builder-title"]';
                await page.waitForSelector(titleSelector, { timeout: 10000 }).catch(() => {});
                const titleEls = await page.$$(titleSelector);
                if (titleEls.length > 0) {
                    await titleEls[0].type(pinData.title, { delay: 50 });
                }
            }

            // 4. Type Description
            if (pinData.description) {
                const descSelector = 'textarea[placeholder*="Tell everyone"], [data-test-id="pin-builder-description"]';
                await page.waitForSelector(descSelector, { timeout: 10000 }).catch(() => {});
                const descEls = await page.$$(descSelector);
                if (descEls.length > 0) {
                    await descEls[0].type(pinData.description, { delay: 30 });
                }
            }

            // 4.5. Select the Board (Create if missing)
            if (pinData.board_name) {
                console.log(`[Uploader - ${this.accountName}] Trying to select/create board: "${pinData.board_name}"`);
                
                // Open board dropdown
                const boardDropdownOpened = await page.evaluate(() => {
                    const dropdowns = Array.from(document.querySelectorAll('[data-test-id="board-dropdown-select-button"], [data-test-id="board-dropdown-button"]'));
                    if (dropdowns.length > 0 && dropdowns[0]) {
                        dropdowns[0].click();
                        return true;
                    }
                    const fallbackBtns = Array.from(document.querySelectorAll('button, div[role="button"]'));
                    for (const btn of fallbackBtns) {
                        const txt = (btn.innerText || '').toLowerCase();
                        if (txt === 'choose a board' || txt === 'select board' || txt.includes('save to board')) {
                            btn.click();
                            return true;
                        }
                    }
                    return false;
                });

                if (boardDropdownOpened) {
                    await delay(1500, 2500);
                    const targetBoard = pinData.board_name.trim().toLowerCase();

                    // Search for the board in the dropdown, or click "Create board"
                    const boardAction = await page.evaluate((tBoard) => {
                        const candidateSelectors = [
                            '[data-test-id="board-row"]',
                            '[data-test-id="board-row"] button',
                            'div[role="listbox"] [role="option"]',
                            'div[role="menu"] [role="menuitem"]'
                        ];

                        for (const sel of candidateSelectors) {
                            const items = Array.from(document.querySelectorAll(sel));
                            for (const item of items) {
                                const text = (item.innerText || '').trim().toLowerCase();
                                const cleanText = text.split('\n')[0].trim();
                                if (item.offsetParent !== null && (cleanText === tBoard || cleanText.startsWith(tBoard))) {
                                    item.scrollIntoView({ block: 'nearest' });
                                    item.click();
                                    return 'selected';
                                }
                            }
                        }

                        // Not found, look for create board button
                        const createBtn = Array.from(document.querySelectorAll('[role="button"], button, [role="menuitem"], div[role="button"]'))
                            .find(el => {
                                const txt = (el.innerText || '').trim().toLowerCase();
                                return el.offsetParent !== null && (txt === 'create board' || txt.includes('create board'));
                            });
                        
                        if (createBtn) {
                            createBtn.scrollIntoView({ block: 'nearest' });
                            createBtn.click();
                            return 'create_clicked';
                        }
                        
                        return 'failed';
                    }, targetBoard);

                    if (boardAction === 'create_clicked') {
                        console.log(`[Uploader - ${this.accountName}] Board "${pinData.board_name}" not found. Creating it...`);
                        await page.waitForSelector('input[id="boardEditName"]', { timeout: 5000 }).catch(()=>{});
                        await page.type('input[id="boardEditName"]', pinData.board_name, { delay: 50 });
                        await delay(1000, 1500);

                        await page.evaluate(() => {
                            const buttons = Array.from(document.querySelectorAll('div[role="dialog"] button, div[data-test-id="create-board-modal"] button, form button'));
                            const createBtn = buttons.find(b => (b.innerText || '').trim().toLowerCase() === 'create');
                            if (createBtn) createBtn.click();
                        });
                        await delay(3000, 4000);
                        console.log(`[Uploader - ${this.accountName}] Created and selected new board: "${pinData.board_name}"`);
                    } else if (boardAction === 'selected') {
                        console.log(`[Uploader - ${this.accountName}] Selected existing board: "${pinData.board_name}"`);
                        await delay(1000, 2000);
                    } else {
                        console.log(`[Uploader - ${this.accountName}] Failed to select or create board, proceeding with default.`);
                    }
                } else {
                    console.log(`[Uploader - ${this.accountName}] Could not open board dropdown.`);
                }
            }

            // 5. Click Publish
            const publishSelector = '[data-test-id="pwt-publish-button"], [data-test-id="board-dropdown-save-button"], button[aria-label="Publish"]';
            const publishBtn = await page.$(publishSelector);
            if (publishBtn) {
                console.log(`[Uploader - ${this.accountName}] Clicking Publish...`);
                await publishBtn.click();
                
                // Wait for success toast or URL change
                await delay(5000, 8000); 
            } else {
                console.log(`[Uploader - ${this.accountName}] Could not find Publish button.`);
            }

            // Cleanup temp file
            if (fs.existsSync(tmpImagePath)) fs.unlinkSync(tmpImagePath);

            await page.close();
            return true;
        } catch (e) {
            console.error(`[Uploader - ${this.accountName}] Error uploading:`, e.message);
            await page.close();
            return false;
        }
    }
}

async function startUploaderLoop(maxPinsPerRun = 999999) {
    console.log(`[Uploader] Starting Continuous upload batch with Puppeteer...`);

    const browser = await puppeteer.launch({ 
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
            '--no-zygote',
            '--disable-notifications'
        ] 
    });

    // Initialize all uploader sessions
    const uploaders = {};
    for (const acc of config.destination_channels) {
        const sessionCookie = process.env.PINTEREST_SESSION_COOKIE || acc.session_cookie;
        uploaders[acc.name] = new PinterestUploader(acc.name, sessionCookie, browser);
    }

    let pinsProcessed = 0;

    while (pinsProcessed < maxPinsPerRun) {
        try {
            // Grab 1 pending pin from the queue
            const pin = await db.getNextPendingPin();
            
            if (!pin) {
                console.log('[Uploader] Queue is empty. All extracted pins have been posted.');
                break; // Exit the loop so GitHub Action can finish
            }

            const uploader = uploaders[pin.destination_channel_name];
            
            if (!uploader) {
                console.error(`[Uploader] Unrecognized channel: ${pin.destination_channel_name}.`);
                await db.updatePinStatus(pin.id, 'failed');
                continue;
            }

            const success = await uploader.uploadPin(pin);

            if (success) {
                await db.updatePinStatus(pin.id, 'success');
                console.log(`[Uploader] Successfully uploaded Pin #${pin.id}.`);
            } else {
                await db.updatePinStatus(pin, 'failed');
            }

            pinsProcessed++;

            if (pinsProcessed >= maxPinsPerRun) {
                break;
            }

        } catch (e) {
            console.error('[Uploader] Loop error:', e.message);
        }

        console.log(`[Uploader] Sleeping for 15 seconds before the next pin...`);
        await delay(15000, 15000); // Wait exactly 15 seconds
    }

    await browser.close();
    console.log('[Uploader] Batch complete.');
}

module.exports = {
    startUploaderLoop
};
